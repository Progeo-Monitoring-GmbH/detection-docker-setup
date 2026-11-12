"""Device provisioning of DeviceViewSet: new controllers, their test measurements and the Airtable sync (/v1/device/provision/...)."""


from django.db import transaction
from django.db.models import DateTimeField, OuterRef, Subquery
from django.utils import timezone
from rest_framework.decorators import action

from progeo.decorator import (
    require_module_permissions,
)
from progeo.helper import airtable_locations, device_commands
from progeo.helper import device_provisioning as provisioning
from progeo.helper.airtable import AirtableHelper
from progeo.helper.basics import RequestFailed, RequestSuccess, ilog
from progeo.helper.creator import create_MfS_log
from progeo.helper.firmware import list_bundles as list_firmware_bundles
from progeo.helper.location_access import (
    configured_accounts,
    is_staff_admin,
    resolve_request_accounts,
    visible_location_filters,
)
from progeo.helper.project_dbs import location_db, release_connection
from progeo.v1.models import (
    ProgeoDevice,
    ProgeoLocation,
    ProgeoMeasurement,
)
from progeo.v1.serializers import DeviceSerializer
from progeo.v1.viewsets.setup_viewset import (
    build_wifi_payload,
    qr_code_data_uri,
)


class DeviceProvisioningMixin:
    """Mixed into DeviceViewSet - uses _command_state() of DeviceCommandsMixin."""

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
        bundles = list_firmware_bundles()
        default_bundle = provisioning.default_bundle(bundles)
        return RequestSuccess({
            "locations": [
                # The address fields make the frontend's LocationPicker searchable.
                {"id": location.pk, "project_id": location.project_id, "name": location.name,
                 "project_type": location.get_project_type_display(),
                 "address": location.address, "plz": location.plz, "city": location.city,
                 "country": location.country, "manager": location.manager,
                 "model": provisioning.default_model(location)}
                for location, _ in self._provision_locations(request)
            ],
            # device.model choices (ASCII only - the controller shows and logs it).
            "models": provisioning.MODELS,
            "defaults": {
                "sensors": provisioning.DEFAULT_SENSORS,
                "interval_sec": provisioning.DEFAULT_INTERVAL_SEC,
                "pulldown_resistance": ProgeoDevice.Resistance.DEFAULT_100K,
                "protective_earth": 0,
                "firmware": default_bundle["id"] if default_bundle else None,
            },
            # The flash bundles the server holds (/firmware/versions/<channel>),
            # newest first; empty: the config gets FIRMWARE_VERSION.
            "firmware_bundles": bundles,
            "firmware_fallback": provisioning.FIRMWARE_VERSION,
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
        config = provisioning.render_config(plan)
        return RequestSuccess({
            **plan,
            "config": config,
            # The whole config.lua as a QR code (~1 KB - fits into one code).
            "config_qr": qr_code_data_uri(config),
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


    @require_module_permissions("module_devices_provision")
    @action(detail=False, url_path="provision/test-measurements", methods=["GET"])
    def provision_test_measurements(self, request, *args, **kwargs):
        """The newest measurements of a provisioned device (?location=&device=),
        each checked (device_commands.check_test_pairs) and drawn as a PNG -
        the provisioning page polls this while testing the controller."""
        db_name = None
        try:
            location, db_name, device = self._provision_device(request, request.query_params)
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
            # Existing devices can report far more sensors than the token they
            # were provisioned with: take the newest measurement's count too,
            # so the MUX board/plot shows all MUXes (444 sensors = 28 MUXes).
            sensor_count = device_commands.device_sensor_count(device, db_name)
            return RequestSuccess({
                "measurements": [
                    device_commands.measurement_row(measurement, threshold=location.alarm_threshold)
                    for measurement in measurements
                ],
                "expected_rising": device_commands.EXPECTED_RISING,
                "sensor_count": sensor_count,
                # The MUX choices of "Emulate Measurement".
                "mux_count": device_commands.mux_count(sensor_count),
                **self._command_state(device, db_name),
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
            device_commands.queue_command(device, db_name, device_commands.Command.MEASURE, user=request.user)
            return RequestSuccess(self._command_state(device, db_name))
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
            location, db_name, device = self._provision_device(request, request.data)
            sensor_count = device_commands.device_sensor_count(device, db_name)
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
            result = device_commands.emulate_measurement(
                device,
                mux,
                sensors=sensor_count,
                location=location,
                user=request.user,
            )
        except device_commands.EmulateError as exc:
            return RequestFailed({"reason": str(exc)})
        ilog(f"Emulated a measurement (MUX-{mux}) of device {device.raw_hash}", tag="[PROVISION]")
        return RequestSuccess({"mux": mux, **result})

    @require_module_permissions("module_devices_provision")
    @action(detail=False, url_path="provision/test-measurements/clear", methods=["POST"])
    def provision_clear_test_measurements(self, request, *args, **kwargs):
        """"Test-Messungen bereinigen": delete the listed test measurements
        (`ids`) of the device - with the alarms they may have raised - so
        they don't count as the location's data. Deleting measurements is
        reserved for superusers; staff can still run the test session."""
        if not getattr(request.user, "is_superuser", False):
            return RequestFailed({"reason": "Superuser access required"})
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
