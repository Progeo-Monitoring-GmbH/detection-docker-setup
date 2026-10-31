
import math
import re
from dataclasses import asdict
from datetime import datetime, timedelta

from celery.exceptions import TimeoutError
from django.db import transaction
from django.db.models import DateTimeField, OuterRef, Subquery
from django.utils import timezone
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.exceptions import ParseError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import (
    ExpiringTokenAuthentication,
    IsTransferRequest,
    TransferPrincipal,
    TransferTokenAuthentication,
)
from progeo.decorator import (
    calc_runtime,
    has_module_permissions,
    permission_denied_response,
    require_module_permissions,
)
from progeo.helper import airtable_locations, device_commands
from progeo.helper import device_provisioning as provisioning
from progeo.helper.airtable import AirtableHelper
from progeo.helper.alarm_evaluation import evaluate_measurement_instantly
from progeo.helper.basics import RequestFailed, RequestSuccess, elog, ilog
from progeo.helper.controller_wifi import parse_lua_wifi, request_controller_wifi_update
from progeo.helper.creator import create_MfS_log
from progeo.helper.location_access import (
    can_see_location,
    configured_accounts,
    is_staff_admin,
    location_id_db,
    location_q,
    request_location_id,
    resolve_request_account,
    resolve_request_accounts,
    visible_location_filters,
    visible_locations_by_db,
)
from progeo.helper.measurement_utils import flatten_numeric_values
from progeo.helper.project_dbs import location_db, release_connection, split_enabled
from progeo.management.commands.patch_live import fetch_device_locations
from progeo.tasks import download_device_config as download_device_config_task
from progeo.tasks import upload_device_config as upload_device_config_task
from progeo.v1.creator import create_progeo_measurement_safe
from progeo.v1.legacy.executor import (
    SafeLuaUploadParser,
    fetch_and_import_legacy_project,
    ingest_db,
    ingest_legacy_query,
    parse_sample_timestamp,
    save_measurement_from_legacy_data,
)
from progeo.v1.legacy.helper_resistance import calc_resistances
from progeo.v1.models import (
    LimitedToken,
    ProgeoDevice,
    ProgeoLocation,
    ProgeoMeasurement,
)
from progeo.v1.serializers import DeviceSerializer, ProgeoMeasurementSerializer
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.v1.viewsets.setup_viewset import (
    _get_controller_account,
    build_wifi_payload,
    qr_code_data_uri,
)

# ######################################################################################################################

# measurementId of a LoRaWAN uplink message -> ProgeoMeasurement field
LORAWAN_MEASUREMENT_FIELDS = {
    4097: "temperature",
    4098: "humidity",
}


class DeviceViewSet(ProgeoModalViewSet):
    serializer_class = DeviceSerializer
    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _resolve_request_account(request):
        return resolve_request_account(request, fallback_account=_get_controller_account())

    @require_module_permissions("module_devices_enabled")
    def list(self, request, *args, **kwargs):
        account = self._resolve_request_account(request)
        if not (split_enabled() and account and request_location_id(request) is None):
            return super().list(request, *args, no_cache=True, **kwargs)
        # Split: the devices of the visible locations are spread over the project databases.
        data = []
        for db_name, location_ids in visible_locations_by_db(request.user, account).items():
            try:
                # Serialized inside: lazy relations must not reopen the connection after release.
                data.extend(self.get_serializer(
                    ProgeoDevice.objects.using(db_name).filter(location_id__in=location_ids), many=True
                ).data)
            finally:
                release_connection(db_name)
        return Response(data=data)

    @require_module_permissions("module_devices_enabled")
    def retrieve(self, request, pk=None, *args, **kwargs):
        return super().retrieve(request, *args, pk=pk, **kwargs)

    customer_actions = ("create", "update", "partial_update", "destroy")

    def perform_create(self, serializer):
        self._check_location(serializer)
        super().perform_create(serializer)

    def perform_update(self, serializer):
        self._check_location(serializer)
        super().perform_update(serializer)

    def _check_location(self, serializer):
        """fields="__all__" accepts any location id: a customer's devices
        may only be created in / moved to locations they see."""
        from rest_framework.exceptions import PermissionDenied

        if is_staff_admin(self.request.user):
            return
        data = serializer.validated_data
        if (serializer.instance is None or "location" in data) and not can_see_location(
            self.request.user, data.get("location")
        ):
            raise PermissionDenied("Location not accessible")

    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    def create(self, request, *args, **kwargs):
        return super().create(request, *args, **kwargs)

    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    def update(self, request, *args, **kwargs):
        return super().update(request, *args, **kwargs)

    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    def partial_update(self, request, *args, **kwargs):
        return super().partial_update(request, *args, **kwargs)

    @require_module_permissions("module_devices_enabled", "module_devices_delete")
    def destroy(self, request, *args, **kwargs):
        return super().destroy(request, *args, **kwargs)

    def _visible_device(self, pk):
        """Device `pk` if the user sees it (get_queryset - ?location= names
        the database with the split on), else None."""
        try:
            return self.get_queryset().filter(pk=int(pk)).first()
        except (TypeError, ValueError):
            return None

    def get_queryset(self):
        account = self._resolve_request_account(self.request)
        ilog("DeviceViewSet: get_queryset called | account:", account)

        if not account:
            return ProgeoDevice.objects.none()
        # ?location= names the database (device ids are only unique per database with the split on).
        return ProgeoDevice.objects.using(location_id_db(account, request_location_id(self.request))).filter(
            location_q(self.request.user, account, "location__")
        )
    

    @staticmethod
    def _may_forward_to(user, device, db_name):
        """Forwarding nodes (scan_devices) send with a transfer token (or a
        staff user); a customer may only add measurements to devices it sees."""
        if isinstance(user, TransferPrincipal) or is_staff_admin(user):
            return True
        location = ProgeoLocation.objects.using(db_name).filter(pk=device.location_id).first()
        return can_see_location(user, location)

    @calc_runtime
    @action(detail=False, url_path="forward/measurement",
            authentication_classes=[JWTAuthentication, ExpiringTokenAuthentication, TransferTokenAuthentication,
                                    SessionAuthentication],
            methods=["POST"])
    def forward_measurement(self, request, pk=None, *args, **kwargs):
        """Store a measurement forwarded from a node server as a NEW row.

        The payload is the serialized ``ProgeoMeasurement`` of the sending node
        (``ProgeoMeasurementSerializer`` output, optionally wrapped in
        ``{"data": {...}}``). The incoming pk is reset and the measurement is
        saved as a fresh entry on this server; the node's original id is kept
        in ``raw_data["forwarded_from"]["id"]`` so originals stay traceable.
        """
        # A forwarding node sends with a transfer token; people need the device module.
        if not isinstance(request.user, TransferPrincipal) and not has_module_permissions(
            request.user, "module_devices_enabled"
        ):
            return permission_denied_response(["module_devices_enabled"])
        account = getattr(request, "account", None) or _get_controller_account()
        db_name = account.db_name if account else "default"

        payload = request.data if isinstance(request.data, dict) else {}
        data = payload.get("data") if isinstance(payload.get("data"), dict) else None
        if not data:
            data = payload if payload.get("device") is not None else None
        if not data:
            return RequestFailed({"reason": "No measurement data provided"})

        if split_enabled() and data.get("device_hash"):
            # The device's own database - pks are only unique per database with the split on.
            db_name = ingest_db(data.get("project_id"), data.get("device_hash"), account)
        device = self._resolve_forwarded_device(data, db_name)
        if device is None or not self._may_forward_to(request.user, device, db_name):
            return RequestFailed({"reason": "Device not found on this server"})

        measurement = ProgeoMeasurement(
            device=device,
            project_id=data.get("project_id"),
            is_watching=bool(data.get("is_watching")),
            raw_data=self._forwarded_raw_data(data),
        )
        last_fetched = self._parse_forwarded_timestamp(data.get("last_fetched"))
        if last_fetched is not None:
            measurement.last_fetched = last_fetched
        # last_fetched=False keeps the forwarded timestamp; otherwise RootModel
        # would overwrite it with "now".
        measurement.save(using=db_name, last_fetched=last_fetched is None)
        evaluate_measurement_instantly(measurement, db_name)

        return RequestSuccess({
            "data": ProgeoMeasurementSerializer(measurement).data,
            "status": "forwarded",
        })

    @staticmethod
    def _resolve_forwarded_device(data: dict, db_name: str):
        """Resolve the device on this server by pk, falling back to raw_hash/mac.

        Node and root servers are separate databases, so the node's device pk
        may not exist here; the serialized payload also carries device_hash
        (raw_hash) / device_mac to look the device up by identity.
        """
        queryset = ProgeoDevice.objects.using(db_name)

        # With the split on, pks repeat across the project databases - the identity comes first.
        device_pk = None if split_enabled() else data.get("device")
        if device_pk is not None:
            device = queryset.filter(pk=device_pk).first()
            if device:
                return device

        for identity_key, lookup_field in (("device_hash", "raw_hash"), ("device_mac", "mac")):
            identity = data.get(identity_key)
            if not identity:
                continue
            device = queryset.filter(**{lookup_field: identity}).first()
            if device:
                return device
        return None

    @staticmethod
    def _forwarded_raw_data(data: dict) -> dict:
        """Rebuild raw_data from the serialized payload and keep the origin."""
        raw_data = {"samples": data.get("samples") or []}
        forwarded_id = data.get("id")
        if forwarded_id is not None:
            raw_data["forwarded_from"] = {"id": forwarded_id}
        return raw_data

    @staticmethod
    def _parse_forwarded_timestamp(value):
        """Parse the serialized last_fetched (project pretty or ISO format)."""
        if not value or not isinstance(value, str):
            return None
        try:
            return datetime.strptime(value, "%d.%m.%Y, %H:%M")
        except ValueError:
            pass
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None

    @action(detail=True, url_path="sample/cc", authentication_classes=[TransferTokenAuthentication], permission_classes=[IsTransferRequest], methods=["GET", "POST"])
    def catch_live_data_c_n_c(self, request, pk, *args, **kwargs):
        """The controller's command poll: {"commands": [...]} - e.g. "measure"
        queued by the provisioning page ("Messung anfragen"). Handed out once
        (helper/device_commands.py). The device is the one of the transfer
        token (provisioned tokens name it), else ?device_hash= / the body's
        device_hash, else the project_id (pk), like the samples."""
        token = request.auth if isinstance(request.auth, LimitedToken) else None
        raw_data = token.raw_data if token is not None and isinstance(token.raw_data, dict) else {}
        body = request.data if isinstance(request.data, dict) else {}
        raw_hash = str(
            raw_data.get("device") or request.query_params.get("device_hash") or body.get("device_hash") or pk
        ).strip()
        return RequestSuccess({"commands": device_commands.take_commands(raw_hash)})
    
    @action(detail=True, url_path="sample", authentication_classes=[TransferTokenAuthentication], permission_classes=[IsTransferRequest], methods=["POST"])
    def catch_live_data(self, request, pk, *args, **kwargs):
        """Store a live sample of a controller (event "sample").

        samples is the CSV of the interleaved pairs [eigen, wirk, ...], two
        values per sensor (cut to `sensors` pairs). The device is identified
        by device_hash (default: the project_id); chip_id / ip are kept on
        the device, event / heap / mac / ... in raw_data. pk is the project_id
        (only there to filter the logs).
        """
        #ilog("DeviceViewSet: catch_live_data called | request.data:", request.data, "pk=", pk, tag="[DEBUG]")
        payload = request.data

        try:
            project_id = int(payload.get("project_id") or pk)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "project_id must be an integer"})

        values = ProgeoMeasurement.normalize_samples(payload.get("samples"))
        try:
            sensors = int(payload.get("sensors"))
        except (TypeError, ValueError):
            sensors = None
        if sensors:
            values = values[: 2 * sensors]
        if len(values) < 2:
            return RequestFailed({"reason": "No samples provided"})

        raw_hash = str(payload.get("device_hash") or project_id).strip()
        measure = save_measurement_from_legacy_data(
            measurement={
                "project_id": project_id,
                "potentials": values,
                **{key: payload.get(key) for key in ("event", "sensors", "chip_id", "heap", "ip", "mac")},
            },
            project_id=project_id,
            raw_hash=raw_hash,
            device_type=ProgeoDevice.DeviceType.SMARTBOX,
        )

        # device.mac is the custom name shown in the frontend - the MAC stays in raw_data.
        device_info = {"chip_id": payload.get("chip_id"), "device_ip": payload.get("ip")}
        device_info = {field: str(value) for field, value in device_info.items() if value not in (None, "")}
        if device_info:
            # Only written when something changed (exclude: all fields already equal).
            ProgeoDevice.objects.using(measure._state.db).filter(pk=measure.device_id).exclude(
                **device_info
            ).update(**device_info)

        return RequestSuccess({
            "project_id": project_id,
            "device_hash": raw_hash,
            "measurement_id": measure.pk,
            "count": len(values) // 2,
        })

    @action(detail=False, url_path="sample/debug", authentication_classes=[TransferTokenAuthentication], permission_classes=[IsTransferRequest], methods=["POST"])
    def catch_legacy_data_debug(self, request, *args, **kwargs):
        ilog("DeviceViewSet: catch_legacy_data_debug called | request.data:", request.data, tag="[DEBUG]")
        return RequestSuccess({"data": request.data})
    

    @action(detail=False, url_path="sample/query", authentication_classes=[TransferTokenAuthentication], permission_classes=[IsTransferRequest], methods=["POST"])
    def catch_legacy_data_query(self, request, *args, **kwargs):
        data = request.data.get("Y")
        try:
            measurement = ingest_legacy_query(data)
        except (TypeError, ValueError) as exc:
            return RequestFailed({"reason": f"Invalid legacy data: {exc}"})

        return RequestSuccess({"data": request.data, "measurement": asdict(measurement)})


    @action(detail=False, url_path="legacy/fetch", methods=["POST"])
    def fetch_legacy_project(self, request, *args, **kwargs):
        """Download https://data-progeo.net/gprs{project_id}.txt, parse it and
        import the measurements. Entries are only created when no measurement
        exists for the same project_id + datetime (no duplicates).
        """
        if not is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})

        project_id = request.data.get("project_id")
        try:
            project_id = int(project_id)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "project_id must be an integer"})

        try:
            dry_run = bool(request.data.get("dry_run"))
        except (TypeError, ValueError):
            dry_run = False

        try:
            report = fetch_and_import_legacy_project(project_id, dry_run=dry_run)
        except Exception as exc:
            elog(f"[legacy/fetch] project_id={project_id} failed: {exc}")
            return RequestFailed({"reason": f"Import failed: {exc}"})
        
        fetch_device_locations()
        return RequestSuccess({"report": report})

    @action(detail=False, url_path="sample/imei", authentication_classes=[TransferTokenAuthentication], permission_classes=[IsTransferRequest], methods=["POST"])
    def catch_legacy_imei_data(self, request, *args, **kwargs):

        # Accept telemetry body where sample values are nested under payload.value.
        raw_values = request.data.get("payload", {}).get("value") if isinstance(request.data.get("payload"), dict) else None
        if raw_values is None:
            raw_values = request.data.get("sample")
        if raw_values is None:
            raw_values = request.data.get("payload")
        if raw_values is None:
            raw_values = request.data

        if not raw_values:
            return RequestFailed({"reason": "No sample provided"})

        samples = []
        resistance_rows = []
        if isinstance(raw_values, dict):
            series_keys = [key for key in raw_values if str(key).isdigit()]
            ilog(f"catch_legacy_imei_data | series_keys: {series_keys} | raw_values: {raw_values}", tag="[IMEI]")
            for key in sorted(series_keys, key=int):
                row = raw_values.get(key)
                if not isinstance(row, (list, tuple)) or len(row) < 2:
                    continue

                idc_intput, vdc_intput, ts = row[0], row[1], row[2]
                if idc_intput is not None:
                    try:
                        idc_intput = float(idc_intput)
                    except (TypeError, ValueError):
                        idc_intput = None
                        
                if vdc_intput is not None:
                    try:
                        vdc_intput = float(vdc_intput)
                    except (TypeError, ValueError):
                        vdc_intput = None

                if ts is not None:
                    ts = parse_sample_timestamp(ts)
                elif raw_values.get("time") is not None:
                    ts = raw_values.get("time")

                result = calc_resistances(vdc_intput=vdc_intput, idc_intput=idc_intput)
                sample_value = result.get("r_vdc_ohm")

                if sample_value is not None and math.isfinite(float(sample_value)):
                    samples.append(round(float(sample_value), 2))

                resistance_rows.append({
                    "index": key,
                    "timestamp": ts,
                    **result,
                })
                ilog(f"catch_legacy_imei_data | index: {key} | row: {row} | result: {result}", tag="[IMEI]")

        if not samples and isinstance(raw_values, list):
            for value in raw_values:
                try:
                    samples.append(float(value))
                except (TypeError, ValueError):
                    elog(f"Missmatch for value: {value}", tag="[IMEI]")
                    continue

        project_id = request.data.get("project_id")
        if project_id is not None and isinstance(project_id, str) and project_id.strip() == "":
            project_id = None

        battery_v = None
        if isinstance(raw_values, dict):
            device_id = raw_values.get("IMEI") if raw_values.get("IMEI") else (str(project_id) if project_id is not None else "legacy-field-unknown")
            # Battery voltage in V, e.g. 'battery': 3.651.
            try:
                battery_v = float(raw_values.get("battery"))
            except (TypeError, ValueError):
                battery_v = None
            if battery_v is not None and not math.isfinite(battery_v):
                battery_v = None
        else:
            device_id = str(project_id) if project_id is not None else "legacy-field-unknown"

        data = {
            "project_id": project_id,
            "raw": raw_values,
            "resistance_rows": resistance_rows,
            "samples": samples,
            "battery_v": battery_v,
        }

        save_measurement_from_legacy_data(
            measurement=data,
            project_id=project_id,
            raw_hash=device_id,
        )

        return RequestSuccess({
            "project_id": project_id,
            "device_id": device_id,
            "sample": samples,
            "resistance_rows": resistance_rows,
            "battery_v": battery_v,
            "count": len(samples),
        })

    @action(detail=False, url_path="sample/catch", authentication_classes=[TransferTokenAuthentication], permission_classes=[IsTransferRequest], methods=["POST"])
    def catch_legacy_data(self, request, *args, **kwargs):
        last_battery = None
        device_id = None
        battery_V = None
        ilog("DeviceViewSet: catch_legacy_data called | request.data:", request.data, tag="[CATCH]")
        uplink_message = request.data.get("uplink_message")
        if uplink_message:
            decoded_payload = uplink_message.get("decoded_payload", {})
            project_id = decoded_payload.get("project_id")
            battery_V = decoded_payload.get("Bat_V")

            sample = decoded_payload.get("sample")

            last_battery_percentage = uplink_message.get("last_battery_percentage", {})
            last_battery = last_battery_percentage.get("value")
            device_id = request.data.get("end_device_ids", {}).get("device_id")
        else:

            data = request.data.get("data")
            if not data:
                project_id = request.data.get("project_id")
                sample = request.data.get("sample")
            else:
                project_id = data.get("project_id")
                sample = data.get("sample")

        if not project_id:
            return RequestFailed({"reason": "No project_id provided"})
        if not sample:
            return RequestFailed({"reason": "No sample provided"})
        
        data = {
            "project_id": project_id,
            "sample": sample,
        }

        save_measurement_from_legacy_data(
            measurement=data,
            project_id=project_id,
            raw_hash=device_id,
            battery_V=battery_V,
            last_battery_percentage=int(last_battery) if last_battery is not None else None,
        )

        return RequestSuccess()

    @action(detail=False, url_path=r"lorawan/(?P<project_id>\d+)",
            authentication_classes=[TransferTokenAuthentication], permission_classes=[IsTransferRequest], methods=["POST"])
    def catch_lorawan_data(self, request, project_id=None, token=None, *args, **kwargs):
        """Store a LoRaWAN uplink forwarded by the network server.

        project_id and the LimitedToken come from the URL, the decoded uplink
        from request.data["object"]. Its messages are mapped onto measurement
        fields by measurementId (see LORAWAN_MEASUREMENT_FIELDS), battery
        messages onto ProgeoMeasurement.battery.
        """

        #ilog("DeviceViewSet: catch_lorawan_data called | project_id:", project_id, "| request.data:", request.data, tag="[LORAWAN]")
        
        uplink = request.data.get("object")
        if not isinstance(uplink, dict):
            return RequestFailed({"reason": "No object provided"})
        if not uplink.get("valid", True) or uplink.get("err"):
            return RequestFailed({"reason": "Invalid uplink", "err": uplink.get("err")})

        values = {}
        for message in uplink.get("messages") or []:
            if not isinstance(message, dict):
                continue
            # SenseCAP reports the battery level as its own message type
            # ({"type": "upload_battery", "battery": 100.0}), not by measurementId.
            if "battery" in message:
                field, raw_value = "battery", message.get("battery")
            elif "measurementId" in message:
                try:
                    field = LORAWAN_MEASUREMENT_FIELDS.get(int(message.get("measurementId")))
                except (TypeError, ValueError):
                    field = None
                raw_value = message.get("measurementValue")
            else:
                # Device info messages (version, interval, sensor id, ...) carry no measurement.
                continue
            try:
                value = float(raw_value)
            except (TypeError, ValueError):
                elog(f"Invalid LoRaWAN message: {message}", tag="[LORAWAN]")
                continue
            if field is not None and math.isfinite(value):
                values[field] = value

        if not values:
            return RequestFailed({"reason": "No known measurements provided"})
        
        # ChirpStack sends the sensor's devEui in deviceInfo; top-level
        # devEui is accepted for other forwarders.
        device_info = request.data.get("deviceInfo")
        dev_eui = (device_info.get("devEui") if isinstance(device_info, dict) else None) or request.data.get("devEui")
        dev_eui = str(dev_eui or "").strip().upper() or None

        measure = save_measurement_from_legacy_data(
            measurement={"project_id": project_id, **values},
            project_id=project_id,
            raw_hash=dev_eui,
            numbered_sensor=dev_eui is not None,
            # The token's account lives in the DB the device data is written to;
            # the controller account may not (it's in DJANGO_DATABASES[0]).
            account=request.auth.account,
            device_type=ProgeoDevice.DeviceType.LORAWAN,
            project_type=ProgeoLocation.PROJECT_TYPE_CHOICES.LORAWAN,
        )

        return RequestSuccess({
            "project_id": project_id,
            "measurement_id": measure.pk,
            **values,
        })

    @calc_runtime
    @require_module_permissions("module_imei_enabled")
    @action(detail=False, url_path="imei/display", methods=["GET"])
    def measurements_imei_display(self, request, *args, **kwargs):
        account = self._resolve_request_account(request)
        db_name = account.db_name if account else "default"
        now = timezone.now()
        min_valid_updated = now.replace(
            year=2025,
            month=1,
            day=1,
            hour=0,
            minute=0,
            second=0,
            microsecond=0,
        )

        since_hours_raw = request.query_params.get("since_hours")
        since = None
        if since_hours_raw not in [None, ""]:
            try:
                since_hours = max(0, int(since_hours_raw))
                since = timezone.now() - timedelta(hours=since_hours)
            except (TypeError, ValueError):
                return RequestFailed({"reason": "since_hours must be an integer"})

        def imei_measurements(database, location_ids=None):
            queryset = ProgeoMeasurement.for_account(account, using=database, user=request.user).select_related("device").filter(resistance_idc__isnull=False, last_updated__isnull=False).order_by("device__raw_hash", "last_updated", "id")
            if location_ids is not None:
                queryset = queryset.filter(device__location_id__in=location_ids)
            if since:
                queryset = queryset.filter(last_updated__gte=since)
            return list(queryset)

        if split_enabled() and account:
            # The IMEI devices of the visible locations are spread over the project databases.
            measurements = []
            for database, location_ids in visible_locations_by_db(request.user, account).items():
                try:
                    measurements.extend(imei_measurements(database, location_ids))
                finally:
                    release_connection(database)
            measurements.sort(key=lambda m: ((m.device.raw_hash or ""), m.last_updated, m.id))
        else:
            measurements = imei_measurements(db_name)

        imei_regex = re.compile(r"^\d{15}$")
        grouped = {}

        for measurement in measurements:
            raw_hash = (measurement.device.raw_hash or "").strip()
            if not imei_regex.match(raw_hash):
                continue

            # The VDC resistance is the IMEI sample (no column of its own).
            resistance_vdc = measurement.get_resistance_vdc()
            try:
                resistance_idc = float(measurement.resistance_idc)
            except (TypeError, ValueError):
                continue
            if resistance_vdc is None:
                continue

            last_updated = measurement.last_updated
            if last_updated is None:
                continue

            # Normalize timezone awareness to avoid comparing naive with aware datetimes.
            if timezone.is_naive(last_updated) and timezone.is_aware(min_valid_updated):
                last_updated = timezone.make_aware(last_updated, timezone.get_current_timezone())
            elif timezone.is_aware(last_updated) and timezone.is_naive(min_valid_updated):
                last_updated = timezone.make_naive(last_updated, timezone.get_current_timezone())

            if last_updated < min_valid_updated:
                continue

            if raw_hash not in grouped:
                grouped[raw_hash] = {
                    "imei": raw_hash,
                    "device_id": measurement.device.id,
                    "device_hash": raw_hash,
                    "measurements": [],
                }

            grouped[raw_hash]["measurements"].append({
                "id": measurement.id,
                "last_updated": last_updated.isoformat(),
                "resistance_idc": resistance_idc,
                "resistance_vdc": resistance_vdc,
                "battery_v": measurement.battery_v,
            })

        devices = sorted(grouped.values(), key=lambda row: row.get("imei") or "")
        return RequestSuccess({
            "devices": devices,
            "count_devices": len(devices),
            "count_measurements": sum(len(device.get("measurements", [])) for device in devices),
        })

        

    @calc_runtime
    @require_module_permissions("module_devices_enabled")
    @action(detail=True, url_path="config/download", methods=["GET"])
    def download_config(self, request, pk=None, *args, **kwargs):
        device = self._visible_device(pk)
        if not device:
            return RequestFailed({"reason": "Device not found"})

        path = (request.query_params.get("path") or "config/device_config.lua").strip()
        task = download_device_config_task.delay(device.device_ip or "", path)

        try:
            result = task.get(timeout=20)
        except TimeoutError:
            return RequestFailed({"reason": "Timed out waiting for device response", "task_id": task.id})
        except Exception as exc:
            return RequestFailed({"reason": str(exc), "task_id": task.id})

        if not result.get("ok"):
            return RequestFailed({
                "reason": "Device download request failed",
                "task_id": task.id,
                "status_code": result.get("status_code"),
                "content": result.get("content", ""),
            })

        return RequestSuccess({
            "task_id": task.id,
            "status_code": result.get("status_code"),
            "content": result.get("content", ""),
        })

    @calc_runtime
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=True, url_path="config/upload", methods=["POST"], parser_classes=[SafeLuaUploadParser])
    def upload_config(self, request, pk=None, *args, **kwargs):
        device = self._visible_device(pk)
        if not device:
            return RequestFailed({"reason": "Device not found"})

        content_type = (request.content_type or "").split(";")[0].strip().lower()
        payload = {}
        raw_body = (request.body or b"").decode("utf-8", errors="replace")

        # Accept plain Lua upload in raw request body.
        if content_type == "text/plain":
            content = raw_body
            path = (request.query_params.get("path") or "config/device_config.lua").strip()
        else:
            try:
                payload = request.data
            except ParseError:
                # Fallback for clients sending raw Lua with application/json header.
                payload = {}

            if isinstance(payload, dict):
                content = payload.get("content")
                if not isinstance(content, str) and isinstance(payload.get("data"), dict):
                    content = payload.get("data", {}).get("content")
                path = (payload.get("path") or request.query_params.get("path") or "config/device_config.lua").strip()
            else:
                content = None
                path = (request.query_params.get("path") or "config/device_config.lua").strip()

            if not isinstance(content, str) and raw_body.strip():
                content = raw_body

        if not isinstance(content, str):
            return RequestFailed({
                "reason": "Missing field: content",
                "content_type": request.content_type,
                "keys": list(payload.keys()) if hasattr(payload, "keys") else [],
            })

        if not content.strip():
            return RequestFailed({
                "reason": "Empty field: content",
                "content_type": request.content_type,
            })

        task = upload_device_config_task.delay(device.device_ip or "", content, path)

        try:
            result = task.get(timeout=20)
        except TimeoutError:
            return RequestFailed({"reason": "Timed out waiting for device response", "task_id": task.id})
        except Exception as exc:
            return RequestFailed({"reason": str(exc), "task_id": task.id})

        if not result.get("ok"):
            return RequestFailed({
                "reason": "Device upload request failed",
                "task_id": task.id,
                "status_code": result.get("status_code"),
                "content": result.get("content", ""),
            })

        # Devices join the controller hotspot, so changed wifi credentials in
        # the device config are applied to the hotspot too (setup_wifi.sh on
        # the host reruns). Only after the device accepted the new config.
        controller_wifi = None
        wifi = parse_lua_wifi(content)
        if wifi:
            controller_wifi = request_controller_wifi_update(*wifi)
            if controller_wifi == "scheduled":
                ilog(f"Controller wifi changed to '{wifi[0]}' via device {device.pk}; hotspot reconfiguration scheduled")
            elif controller_wifi.startswith("invalid"):
                elog(f"Controller wifi from device {device.pk} not applied: {controller_wifi}")

        return RequestSuccess({
            "task_id": task.id,
            "status_code": result.get("status_code"),
            "content": result.get("content", ""),
            "controller_wifi": controller_wifi,
        })

    @calc_runtime
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=False, url_path="receive", methods=["POST"])
    def receive_data(self, request, *args, **kwargs):
        device_hash = kwargs.get("device_hash")
        if not device_hash:
            return RequestFailed({"reason": "No device hash provided"})

        account = _get_controller_account()
        #if not account:
        #    return RequestFailed({"reason": "No account configured"})

        #db_name = account.db_name or "default"
        db_name = "default"  # TODO hardcoded for now, needs refactor
        location, _ = ProgeoLocation.objects.using(db_name).get_or_create(
            account=account,
            address="unknown",
        )
        # The location stays in default, the device lives in its database (location_db).
        device, created = ProgeoDevice.objects.using(location_db(location, account)).get_or_create(
            raw_hash=device_hash,
            defaults={"location": location},
        )

        return RequestSuccess({
            "created": created,
            "device": DeviceSerializer(device).data,
        })

    @calc_runtime
    # Stores a measurement and may mail an alarm - a write, not a read.
    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    @action(detail=True, url_path="evaluate", methods=["POST"])
    def evaluate_measurement(self, request, pk=None, *args, **kwargs):

        threshold_raw = request.data.get("threshold")
        if threshold_raw is None:
            return RequestFailed({"reason": "No threshold provided"})

        try:
            threshold = float(threshold_raw)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "Threshold must be numeric"})

        rows = request.data.get("rows")
        if rows is None:
            return RequestFailed({"reason": "No rows provided"})

        device = self._visible_device(pk)
        if not device:
            return RequestFailed({"reason": "Device not found"})
        db_name = device._state.db

        values = flatten_numeric_values(rows)
        if not values:
            return RequestFailed({"reason": "Rows do not contain numeric values"})

        exceeding_values = [value for value in values if value > threshold]
        max_value = max(values)
        alarm_triggered = len(exceeding_values) > 0
        evaluated_at = timezone.now().isoformat()

        payload = {
            "device_hash": device.raw_hash,
            "rows": rows,
            "values": values,
            "threshold": threshold,
            "alarm": {
                "triggered": alarm_triggered,
                "max_value": max_value,
                "exceeding_values": exceeding_values,
                "evaluated_at": evaluated_at,
            },
            "evaluated_at": evaluated_at,
        }
        measurement, created = create_progeo_measurement_safe(device=device, raw_data=payload, db=db_name)
        if not measurement:
            return RequestFailed({"reason": "Failed to store measurement evaluation"})
        
        
        return RequestSuccess({
            "created": created,
            "device_hash": device.raw_hash,
            "threshold": threshold,
            "alarm_triggered": alarm_triggered,
            "max_value": max_value,
            "exceeding_values": exceeding_values,
        })

    @calc_runtime
    @require_module_permissions("module_measurements_enabled")
    @action(detail=True, url_path="measurements", methods=["GET"])
    def measurements(self, request, pk=None, *args, **kwargs):
        account = self._resolve_request_account(request)
        if not account:
            return RequestFailed({"reason": "Device not found"})
        # ?location= names the database (device ids are only unique per database with the split on).
        db_name = location_id_db(account, request_location_id(request))

        try:
            limit = int(request.query_params.get("limit", 250))
        except (TypeError, ValueError):
            return RequestFailed({"reason": "limit must be an integer"})
        limit = max(1, min(limit, 2000))

        year_raw = request.query_params.get("year")
        year = None
        if year_raw not in [None, ""]:
            try:
                year = int(year_raw)
            except (TypeError, ValueError):
                return RequestFailed({"reason": "year must be an integer"})

        # Optional time window (ISO-8601) so the frontend can scope the
        # measurements around an alarm (mirrors the location heatmap action).
        time_from = request.query_params.get("from")
        time_to = request.query_params.get("to")
        try:
            if time_from:
                time_from = datetime.fromisoformat(time_from)
            if time_to:
                time_to = datetime.fromisoformat(time_to)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "from/to must be ISO-8601 timestamps"})

        device = (
            ProgeoDevice.objects.using(db_name)
            .filter(location_q(request.user, account, "location__"))
            .filter(pk=pk)
            .first()
        )
        if not device:
            return RequestFailed({"reason": "Device not found"})

        queryset = ProgeoMeasurement.for_account(account, using=db_name, user=request.user).filter(device=device)
        if year:
            queryset = queryset.filter(last_fetched__year=year)
        if time_from:
            queryset = queryset.filter(last_fetched__gte=time_from)
        if time_to:
            queryset = queryset.filter(last_fetched__lte=time_to)
        if not year:
            queryset = queryset.select_related("device").order_by("-id")[:limit]
        serialized = ProgeoMeasurementSerializer(queryset, many=True).data

        return RequestSuccess({
            "device": DeviceSerializer(device).data,
            "count": queryset.count(),
            "limit": limit,
            "year": year,
            "measurements": serialized,
        })

    @calc_runtime
    @require_module_permissions("module_devices_enabled", "module_devices_delete")
    @action(detail=True, url_path="delete", methods=["POST"])
    def delete_device(self, request, pk=None, *args, **kwargs):
        device = self._visible_device(pk)
        if not device:
            return RequestFailed({"reason": "Device not found"})
        device.delete(using=device._state.db)
        create_MfS_log(request)
        return RequestSuccess({"deleted": True})

    # ------------------------------------------------------------------ provisioning (helper/device_provisioning.py)

    @staticmethod
    def _provision_locations(request, location_id=None):
        """[(location, database)] of the locations with a project_id the user
        sees (only `location_id`, if given)."""
        rows = []
        for db_name, (account, visible) in visible_location_filters(
            request.user, resolve_request_accounts(request)
        ).items():
            locations = ProgeoLocation.objects.using(db_name).filter(visible, project_id__isnull=False)
            if location_id is not None:
                locations = locations.filter(pk=location_id)
            rows.extend((location, location_db(location, account)) for location in locations.order_by("project_id"))
        return rows

    def _provision_location(self, request, location_id):
        try:
            location_id = int(location_id)
        except (TypeError, ValueError):
            raise provisioning.ProvisionError("location must be an integer") from None
        rows = self._provision_locations(request, location_id)
        if not rows:
            raise provisioning.ProvisionError("Location not found or without project_id")
        return rows[0]

    @require_module_permissions("module_devices_provision")
    @action(detail=False, url_path="provision/locations", methods=["GET"])
    def provision_locations(self, request, *args, **kwargs):
        """The locations a new controller can be filed under, with the defaults of the form."""
        return RequestSuccess({
            "locations": [
                # The address fields make the frontend's LocationPicker searchable.
                {"id": location.pk, "project_id": location.project_id, "name": location.name,
                 "project_type": location.get_project_type_display(),
                 "address": location.address, "plz": location.plz, "city": location.city,
                 "country": location.country, "manager": location.manager}
                for location, _ in self._provision_locations(request)
            ],
            "defaults": {
                "sensors": provisioning.DEFAULT_SENSORS,
                "interval_sec": provisioning.DEFAULT_INTERVAL_SEC,
                "pulldown_resistance": ProgeoDevice.Resistance.DEFAULT_100K,
                "protective_earth": 0,
            },
            "pulldown_resistances": [
                {"value": value, "label": label} for value, label in ProgeoDevice.Resistance.choices
            ],
        })

    @require_module_permissions("module_devices_provision")
    @action(detail=False, url_path="provision/devices", methods=["GET"])
    def provision_devices(self, request, *args, **kwargs):
        """The devices already filed under a location (?location=), so the
        provisioning page can continue a measurement-testing session."""
        db_name = None
        try:
            location, db_name = self._provision_location(request, request.query_params.get("location"))
            last_measurement = Subquery(
                ProgeoMeasurement.objects.using(db_name)
                .filter(device=OuterRef("pk"))
                .order_by("-pk")
                .values("last_fetched")[:1],
                output_field=DateTimeField(),
            )
            devices = (
                ProgeoDevice.objects.using(db_name)
                .filter(location=location)
                .annotate(last_measurement_at=last_measurement)
                .order_by("id")
            )
            return RequestSuccess({
                "devices": [
                    {
                        "id": device.pk,
                        "raw_hash": device.raw_hash,
                        "display_name": device.display_name,
                        "chip_id": device.chip_id,
                        "type": device.type,
                        "hardware": device.hardware,
                        "last_measurement_at": (
                            device.last_measurement_at.isoformat() if device.last_measurement_at else None
                        ),
                    }
                    for device in devices
                ]
            })
        except provisioning.ProvisionError as exc:
            return RequestFailed({"reason": str(exc)})
        finally:
            release_connection(db_name)

    @require_module_permissions("module_devices_provision")
    @action(detail=False, url_path="provision/preview", methods=["POST"])
    def provision_preview(self, request, *args, **kwargs):
        """Generate device_hash, token and config - nothing is saved. `signed`
        goes back to provision/confirm unchanged."""
        db_name = None
        try:
            location, db_name = self._provision_location(request, request.data.get("location"))
            plan = provisioning.build_plan(location, db_name, provisioning.parse_settings(request.data))
        except provisioning.ProvisionError as exc:
            return RequestFailed({"reason": str(exc)})
        finally:
            release_connection(db_name)
        # QR codes for the setup portal: join its network, then open the controller.
        portal_wifi = build_wifi_payload(provisioning.PORTAL["ssid"], provisioning.PORTAL["pwd"])
        return RequestSuccess({
            **plan,
            "config": provisioning.render_config(plan),
            "signed": provisioning.sign_plan(plan),
            "portal": {
                "wifi": {"ssid": provisioning.PORTAL["ssid"], "payload": portal_wifi, "image": qr_code_data_uri(portal_wifi)},
                "frontend": {
                    "url": provisioning.PORTAL_URL,
                    "payload": provisioning.PORTAL_URL,
                    "image": qr_code_data_uri(provisioning.PORTAL_URL),
                },
            },
        })

    @require_module_permissions("module_devices_provision")
    @action(detail=False, url_path="provision/confirm", methods=["POST"])
    def provision_confirm(self, request, *args, **kwargs):
        """Create the device of a preview, filed under its location, and its
        transfer token - the controller can send its samples from now on."""
        db_name = None
        try:
            plan = provisioning.unsign_plan(request.data.get("signed"))
            # Checked again: the user may have lost access since the preview.
            location, db_name = self._provision_location(request, plan["location"])
            device, token = provisioning.create_device(plan, location, db_name, request.account, request.user)
            device_data = DeviceSerializer(device).data
        except provisioning.ProvisionError as exc:
            return RequestFailed({"reason": str(exc)})
        finally:
            release_connection(db_name)
        create_MfS_log(request)
        ilog(f"Provisioned device {device.raw_hash} (location {location.pk}, token {token.pk})", tag="[PROVISION]")
        return RequestSuccess({
            "device": device_data,
            "token_id": token.pk,
            "config": provisioning.render_config(plan),
        })

    # ------------------------------------------------------------------ test measurements (helper/device_commands.py)

    def _provision_device(self, request, params):
        """(location, db_name, device) of `params` (location + device id) -
        the device must sit at a location the user may provision for."""
        location, db_name = self._provision_location(request, params.get("location"))
        try:
            device_id = int(params.get("device"))
        except (TypeError, ValueError):
            raise provisioning.ProvisionError("device must be an integer") from None
        device = ProgeoDevice.objects.using(db_name).filter(pk=device_id, location=location).first()
        if device is None:
            raise provisioning.ProvisionError("Device not found at this location")
        return location, db_name, device

    @staticmethod
    def _command_state(device):
        return {
            "pending_commands": list(device.pending_commands or []),
            "last_command_poll": device.last_command_poll.isoformat() if device.last_command_poll else None,
        }

    @require_module_permissions("module_devices_provision")
    @action(detail=False, url_path="provision/test-measurements", methods=["GET"])
    def provision_test_measurements(self, request, *args, **kwargs):
        """The newest measurements of a provisioned device (?location=&device=),
        each checked (device_commands.check_test_pairs) and drawn as a PNG -
        the provisioning page polls this while testing the controller."""
        db_name = None
        try:
            _location, db_name, device = self._provision_device(request, request.query_params)
            # The page polls every few seconds: after the first response it
            # sends the newest timestamp it knows, so only genuinely new rows
            # are read and rendered (no 50 measurements + PNGs per poll).
            know_since = (request.query_params.get("know_since") or "").strip()
            since = None
            if know_since:
                from django.utils.dateparse import parse_datetime

                since = parse_datetime(know_since)
                if since is None:
                    return RequestFailed({"reason": "know_since must be an ISO-8601 timestamp"})
                if timezone.is_naive(since):
                    since = timezone.make_aware(since, timezone.get_current_timezone())

            measurements = ProgeoMeasurement.objects.using(db_name).filter(device=device)
            if since is not None:
                measurements = measurements.filter(last_fetched__gt=since)
            measurements = measurements.order_by("-pk")[:device_commands.TEST_MEASUREMENTS_LIMIT]
            return RequestSuccess({
                "measurements": [device_commands.measurement_row(measurement) for measurement in measurements],
                "expected_rising": device_commands.EXPECTED_RISING,
                # The MUX choices of "Emulate Measurement".
                "mux_count": device_commands.mux_count(
                    device_commands.token_sensors(device_commands.transfer_token(device))
                ),
                **self._command_state(device),
            })
        except provisioning.ProvisionError as exc:
            return RequestFailed({"reason": str(exc)})
        finally:
            release_connection(db_name)

    @require_module_permissions("module_devices_provision")
    @action(detail=False, url_path="provision/request-measurement", methods=["POST"])
    def provision_request_measurement(self, request, *args, **kwargs):
        """"Messung anfragen": queue "measure" - the controller takes it with
        its next command poll (sample/cc) and measures."""
        db_name = None
        try:
            _location, db_name, device = self._provision_device(request, request.data)
            device_commands.queue_command(device, db_name, "measure")
            return RequestSuccess(self._command_state(device))
        except provisioning.ProvisionError as exc:
            return RequestFailed({"reason": str(exc)})
        finally:
            release_connection(db_name)

    @require_module_permissions("module_devices_provision")
    @action(detail=False, url_path="provision/emulate-measurement", methods=["POST"])
    def provision_emulate_measurement(self, request, *args, **kwargs):
        """"Emulate Measurement" (superusers): POST a sample like the
        controller's to its control.url, with its transfer token - `mux`
        rising, every other sensor 0 (device_commands.emulate_measurement)."""
        if not request.user.is_superuser:
            return RequestFailed({"reason": "Superuser access required"})
        db_name = None
        try:
            _location, db_name, device = self._provision_device(request, request.data)
            try:
                mux = int(request.data.get("mux") or 1)
            except (TypeError, ValueError):
                raise provisioning.ProvisionError("mux must be an integer") from None
        except provisioning.ProvisionError as exc:
            return RequestFailed({"reason": str(exc)})
        finally:
            # Released before the POST - no project database connection held while waiting.
            release_connection(db_name)
        try:
            result = device_commands.emulate_measurement(device, mux)
        except device_commands.EmulateError as exc:
            return RequestFailed({"reason": str(exc)})
        ilog(f"Emulated a measurement (MUX-{mux}) of device {device.raw_hash}", tag="[PROVISION]")
        return RequestSuccess({"mux": mux, **result})

    @require_module_permissions("module_devices_provision")
    @action(detail=False, url_path="provision/test-measurements/clear", methods=["POST"])
    def provision_clear_test_measurements(self, request, *args, **kwargs):
        """"Test-Messungen bereinigen": delete the listed test measurements
        (`ids`) of the device - with the alarms they may have raised - so
        they don't count as the location's data."""
        db_name = None
        try:
            _location, db_name, device = self._provision_device(request, request.data)
            ids = request.data.get("ids")
            if not isinstance(ids, list):
                raise provisioning.ProvisionError("ids must be a list")
            try:
                ids = [int(value) for value in ids]
            except (TypeError, ValueError):
                raise provisioning.ProvisionError("ids must be integers") from None
            with transaction.atomic(using=db_name):
                queryset = ProgeoMeasurement.objects.using(db_name).filter(device=device, pk__in=ids)
                deleted = queryset.count()
                queryset.delete()
            ilog(f"Cleared {deleted} test measurement(s) of device {device.raw_hash}", tag="[PROVISION]")
            return RequestSuccess({"deleted": deleted})
        except provisioning.ProvisionError as exc:
            return RequestFailed({"reason": str(exc)})
        finally:
            release_connection(db_name)

    # ------------------------------------------------------------------ Airtable sync (helper/airtable_locations.py)
    # Staff-only: both look at (and write) the locations of every account.

    @require_module_permissions("module_devices_provision")
    @action(detail=False, url_path="provision/airtable/sync", methods=["POST"])
    def provision_airtable_sync(self, request, *args, **kwargs):
        """Fetch the Airtable projects in "Messeinheit und Inbetriebnahme",
        merge-update their existing locations and return the projects
        without one (`signed` goes to provision/airtable/import)."""
        if not is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})
        try:
            rows = airtable_locations.fetch_rows(AirtableHelper())
        except airtable_locations.AirtableSyncError as exc:
            return RequestFailed({"reason": str(exc)})
        result = airtable_locations.sync(rows)
        ilog(f"Airtable sync: {len(rows)} project(s), {len(result['available'])} available, "
             f"{len(result['updated'])} location(s) updated", tag="[PROVISION]")
        return RequestSuccess({
            **result,
            "signed": airtable_locations.sign_rows(result["available"]),
            "accounts": [{"id": account.pk, "name": account.name}
                         for account in sorted(configured_accounts(), key=lambda account: account.name or "")],
        })

    @require_module_permissions("module_devices_provision")
    @action(detail=False, url_path="provision/airtable/import", methods=["POST"])
    def provision_airtable_import(self, request, *args, **kwargs):
        """Create a location under `account` for each of `project_ids` (of
        the signed sync result)."""
        if not is_staff_admin(request.user):
            return RequestFailed({"reason": "Staff access required"})
        try:
            rows = airtable_locations.unsign_rows(request.data.get("signed"))
        except airtable_locations.AirtableSyncError as exc:
            return RequestFailed({"reason": str(exc)})
        try:
            account_id = int(request.data.get("account"))
        except (TypeError, ValueError):
            account_id = None
        account = next((account for account in configured_accounts() if account.pk == account_id), None)
        if account is None:
            return RequestFailed({"reason": "Account not found"})
        project_ids = {str(project_id) for project_id in request.data.get("project_ids") or []}
        rows = [row for row in rows if str(row["project_id"]) in project_ids]
        if not rows:
            return RequestFailed({"reason": "No projects selected"})
        created, skipped = airtable_locations.create_locations(rows, account)
        ilog(f"Airtable import: {len(created)} location(s) under account {account.pk}", tag="[PROVISION]")
        return RequestSuccess({
            "created": [{"id": location.pk, "project_id": location.project_id, "name": location.name}
                        for location in created],
            "skipped": skipped,
        })