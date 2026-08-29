
import math
import re
from datetime import datetime, timedelta
from dataclasses import asdict

from django.utils import timezone
from celery.exceptions import TimeoutError
from rest_framework.decorators import action
from rest_framework.exceptions import ParseError
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from progeo.authentication import LimitedTokenAuthentication
from rest_framework.permissions import IsAuthenticated
from progeo.helper.measurement_utils import flatten_numeric_values
from progeo.management.commands.patch_live import fetch_device_locations
from progeo.tasks import download_device_config as download_device_config_task, upload_device_config as upload_device_config_task
from progeo.v1.models import ProgeoDevice, ProgeoLocation, ProgeoMeasurement
from progeo.v1.serializers import DeviceSerializer, ProgeoMeasurementSerializer
from progeo.decorator import calc_runtime, require_module_permissions
from progeo.helper.basics import RequestSuccess, RequestFailed, elog, ilog
from progeo.helper.creator import create_MfS_log
from progeo.v1.creator import create_progeo_measurement_safe
from progeo.v1.viewsets.progeo_model_viewset import ProgeoModalViewSet
from progeo.v1.viewsets.setup_viewset import _get_controller_account
from progeo.v1.legacy.executor import parse_legacy_data_measurement, parse_sample_timestamp, save_measurement_from_legacy_data, fetch_and_import_legacy_project
from progeo.v1.legacy.executor import SafeLuaUploadParser
from progeo.v1.legacy.helper_resistance import calc_resistances


# ######################################################################################################################



class DeviceViewSet(ProgeoModalViewSet):
    serializer_class = DeviceSerializer
    authentication_classes = [SessionAuthentication, JWTAuthentication, TokenAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _resolve_request_account(request):
        account = getattr(request, "account", None)
        user = getattr(request, "user", None)

        if not user:
            return account or _get_controller_account()

        if user.is_staff or user.is_superuser:
            return account or _get_controller_account()

        if account and account.users.filter(pk=user.pk).exists():
            return account

        user_account = user.accounts.order_by("id").first()
        if user_account:
            return user_account

        return account or _get_controller_account()

    @require_module_permissions("module_devices_enabled")
    def list(self, request, *args, **kwargs):
        return super(DeviceViewSet, self).list(request, no_cache=True, *args, **kwargs)

    @require_module_permissions("module_devices_enabled")
    def retrieve(self, request, pk=None, *args, **kwargs):
        return super(DeviceViewSet, self).retrieve(request, pk=pk, *args, **kwargs)

    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    def create(self, request, *args, **kwargs):
        return super(DeviceViewSet, self).create(request, *args, **kwargs)

    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    def update(self, request, *args, **kwargs):
        return super(DeviceViewSet, self).update(request, *args, **kwargs)

    @require_module_permissions("module_devices_enabled", "module_devices_edit")
    def partial_update(self, request, *args, **kwargs):
        return super(DeviceViewSet, self).partial_update(request, *args, **kwargs)

    @require_module_permissions("module_devices_enabled", "module_devices_delete")
    def destroy(self, request, *args, **kwargs):
        return super(DeviceViewSet, self).destroy(request, *args, **kwargs)

    def get_queryset(self):
        account = self._resolve_request_account(self.request)
        ilog("DeviceViewSet: get_queryset called | account:", account)

        if not account:
            return ProgeoDevice.objects.none()
        return ProgeoDevice.objects.using(account.db_name).filter(location__account=account)
    

    @calc_runtime
    @require_module_permissions("module_devices_enabled")
    @action(detail=False, url_path="forward/measurement",
            authentication_classes=[SessionAuthentication, JWTAuthentication, TokenAuthentication, LimitedTokenAuthentication],
            methods=["POST"])
    def forward_measurement(self, request, pk=None, *args, **kwargs):
        """Store a measurement forwarded from a node server as a NEW row.

        The payload is the serialized ``ProgeoMeasurement`` of the sending node
        (``ProgeoMeasurementSerializer`` output, optionally wrapped in
        ``{"data": {...}}``). The incoming pk is reset and the measurement is
        saved as a fresh entry on this server; the node's original id is kept
        in ``raw_data["forwarded_from"]["id"]`` so originals stay traceable.
        """
        account = getattr(request, "account", None) or _get_controller_account()
        db_name = account.db_name if account else "default"

        payload = request.data if isinstance(request.data, dict) else {}
        data = payload.get("data") if isinstance(payload.get("data"), dict) else None
        if not data:
            data = payload if payload.get("device") is not None else None
        if not data:
            return RequestFailed({"reason": "No measurement data provided"})

        device = self._resolve_forwarded_device(data, db_name)
        if device is None:
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

        device_pk = data.get("device")
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

        



    @action(detail=False, url_path="sample/debug", authentication_classes=[LimitedTokenAuthentication], methods=["POST"])
    def catch_legacy_data_debug(self, request, *args, **kwargs):
        ilog("DeviceViewSet: catch_legacy_data_debug called | request.data:", request.data, tag="[DEBUG]")
        return RequestSuccess({"data": request.data})
    

    @action(detail=False, url_path="sample/query", authentication_classes=[LimitedTokenAuthentication], methods=["POST"])
    def catch_legacy_data_query(self, request, *args, **kwargs):
        data = request.data.get("Y")
        try:
            measurement = parse_legacy_data_measurement(data)
        except (TypeError, ValueError) as exc:
            return RequestFailed({"reason": f"Invalid legacy data: {exc}"})
        
        save_measurement_from_legacy_data(
            measurement=measurement,
            device_id=str(measurement.project_id)
        )

        return RequestSuccess({"data": request.data, "measurement": asdict(measurement)})


    @action(detail=False, url_path="legacy/fetch", methods=["POST"])
    def fetch_legacy_project(self, request, *args, **kwargs):
        """Download https://data-progeo.net/gprs{project_id}.txt, parse it and
        import the measurements. Entries are only created when no measurement
        exists for the same project_id + datetime (no duplicates).
        """

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

    @action(detail=False, url_path="sample/imei", authentication_classes=[LimitedTokenAuthentication], methods=["POST"])
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
            series_keys = [key for key in raw_values.keys() if str(key).isdigit()]
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

        if isinstance(raw_values, dict):
            device_id = raw_values.get("IMEI") if raw_values.get("IMEI") else (str(project_id) if project_id is not None else "legacy-field-unknown")
        else:
            device_id = str(project_id) if project_id is not None else "legacy-field-unknown"

        data = {
            "project_id": project_id,
            "raw": raw_values,
            "resistance_rows": resistance_rows,
            "samples": samples,
        }

        save_measurement_from_legacy_data(
            measurement=data,
            device_id=device_id,
        )

        return RequestSuccess({
            "project_id": project_id,
            "device_id": device_id,
            "sample": samples,
            "resistance_rows": resistance_rows,
            "count": len(samples),
        })

    @action(detail=False, url_path="sample/catch", authentication_classes=[LimitedTokenAuthentication], methods=["POST"])
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
            device_id=device_id or str(project_id),
            battery_V=battery_V,
            last_battery_percentage=int(last_battery) if last_battery is not None else None,
        )

        return RequestSuccess()

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

        queryset = ProgeoMeasurement.for_account(account, using=db_name, user=request.user).select_related("device").filter(resistance_idc__isnull=False, last_updated__isnull=False).order_by("device__raw_hash", "last_updated", "id")
        if since:
            queryset = queryset.filter(last_updated__gte=since)

        imei_regex = re.compile(r"^\d{15}$")
        grouped = {}

        for measurement in queryset:
            raw_hash = (measurement.device.raw_hash or "").strip()
            if not imei_regex.match(raw_hash):
                continue

            try:
                resistance_vdc = float(measurement.resistance_vdc)
                resistance_idc = float(measurement.resistance_idc)
            except (TypeError, ValueError):
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
        account = getattr(request, "account", None) or _get_controller_account()
        db_name = account.db_name if account else "default"
        device = ProgeoDevice.objects.using(db_name).filter(pk=pk, location__account=account).first()
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
        account = getattr(request, "account", None) or _get_controller_account()
        db_name = account.db_name if account else "default"
        device = ProgeoDevice.objects.using(db_name).filter(pk=pk, location__account=account).first()
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

        return RequestSuccess({
            "task_id": task.id,
            "status_code": result.get("status_code"),
            "content": result.get("content", ""),
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
        device, created = ProgeoDevice.objects.using(db_name).get_or_create(
            raw_hash=device_hash,
            defaults={"location": location},
        )

        return RequestSuccess({
            "created": created,
            "device": DeviceSerializer(device).data,
        })

    @calc_runtime
    @require_module_permissions("module_measurements_enabled")
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

        account = getattr(request, "account", None) or _get_controller_account()
        #if not account:
        #    return RequestFailed({"reason": "No account configured"})

        #db_name = account.db_name or "default"
        db_name = account.db_name if account else "default"
        device = ProgeoDevice.objects.using(db_name).filter(pk=pk, location__account=account).first()
        if not device:
            return RequestFailed({"reason": "Device not found"})

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
        account = getattr(request, "account", None) or _get_controller_account()
        db_name = account.db_name if account else "default"

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

        device = ProgeoDevice.objects.using(db_name).filter(pk=pk).first()
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
        account = getattr(request, "account", None) or _get_controller_account()
        db_name = account.db_name if account else "default"
        try:
            device = ProgeoDevice.objects.using(db_name).get(id=int(pk), location__account=account)
        except (ValueError, ProgeoDevice.DoesNotExist):
            device = None

        if not device:
            return RequestFailed({"reason": "Device not found"})
        device.delete(using=db_name)
        create_MfS_log(request)
        return RequestSuccess({"deleted": True})