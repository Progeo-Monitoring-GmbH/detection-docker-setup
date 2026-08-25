import os
from typing import Any

import requests
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from progeo.helper.basics import dlog, ilog, elog
from progeo.settings import PROGEO_CONFIG_ENABLE_MEASUREMENTS, PROGEO_CONFIG_HAS_ROOT_SERVER
from progeo.v1.creator import (
    create_progeo_location_safe,
    create_progeo_measurement_safe,
)
from progeo.v1.serializers import ProgeoMeasurementSerializer
from progeo.v1.viewsets.setup_viewset import _get_controller_account
from progeo.v1.viewsets.status_viewset import get_connected_devices
from progeo.v1.models import ProgeoDevice


class Command(BaseCommand):
    help = "scan_devices"

    @staticmethod
    def _parse_response(response: requests.Response) -> dict[str, Any]:
        try:
            payload = response.json()
            if isinstance(payload, dict):
                return payload
            return {"data": payload}
        except ValueError:
            text = response.text or ""
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            parsed: dict[str, Any] = {}
            for line in lines:
                if "=" in line:
                    key, value = line.split("=", 1)
                    parsed[key.strip()] = value.strip()
                else:
                    parsed.setdefault("lines", []).append(line)

            if parsed:
                return parsed
            return {"text": text}

    @staticmethod
    def _build_base_url(ip_address: str) -> str:
        return f"http://{ip_address}"

    @staticmethod
    def _build_device_hash(device_info: dict[str, Any], payload: dict[str, Any]) -> str:
        return str(
            payload.get("device_hash")
            or payload.get("raw_hash")
            or device_info.get("mac")
            or device_info.get("ip")
            or device_info.get("hostname")
        )

    def _post_measure(self, base_url: str) -> requests.Response:
        try:
            # Force a fresh connection for each attempt to avoid stale keep-alive sockets.
            response = requests.post(
                f"{base_url}/measure",
                timeout=(30, 500)
            )
            response.raise_for_status()
            return response
        except requests.RequestException as exc:
            elog(f"POST /measure failed for {base_url}: {exc}")

    def handle(self, *args, **options):

        if not PROGEO_CONFIG_ENABLE_MEASUREMENTS:
            ilog("by PROGEO_CONFIG_ENABLE_MEASUREMENTS", tag="[DISABLED]")
            return
        
        _, connected_devices = get_connected_devices()
        if not isinstance(connected_devices, list):
            raise CommandError("Could not read connected devices", connected_devices)

        account = _get_controller_account()
        found_devices = []

        dlog(f"Scanning {len(connected_devices)} connected device(s)")

        for device_info in connected_devices:
            ip_address = device_info.get("ip")
            if not ip_address:
                continue

            base_url = self._build_base_url(ip_address)
            try:
                response = requests.get(f"{base_url}/identify", timeout=5)
                response.raise_for_status()
            except requests.RequestException:
                dlog(f"Skipping unreachable device at {ip_address}")
                continue

            payload = self._parse_response(response)
            dlog(f"Received payload from {ip_address}: {payload}")
            device_hash = payload.get("device_hash")
            if not device_hash:
                dlog(f"Skipping device at {ip_address}: no device identifier")
                continue

            location_label = os.getenv("CONTROLLER_DEFAULT_ACCOUNT", "Unknown Location")
            location, _ = create_progeo_location_safe(account=account, address=location_label)
            if not location:
                elog(f"Skipping device at {ip_address}: failed to create location")
                continue

            device = ProgeoDevice.objects.filter(mac=device_info.get("mac")).first()
            if not device:
                elog(f"Skipping device at {ip_address}: failed to register device")
                continue

            found_devices.append({
                "device": device,
                "device_info": device_info,
                "payload": payload,
                "base_url": base_url,
            })
            dlog(f"Registered device {device.raw_hash} at {ip_address} | payload: {payload}")

        for found in found_devices:
            device = found["device"]
            device_info = found["device_info"]
            _ip = device_info.get("ip", "unknown IP")
            ilog(f"Found device {found['device'].raw_hash} at {_ip}, starting measurement")

            try:
                response = self._post_measure(found["base_url"])
            except requests.RequestException as exc:
                elog(f"Measurement failed for {device.raw_hash}: {exc}")
                continue

            if not response:
                elog(f"Measurement failed for {device.raw_hash}: no response")
                continue

            measure_payload = self._parse_response(response)
            measurement_data = {
                "hostname": device_info.get("hostname"),
                "identify": found["payload"],
                "measure": measure_payload,
                "scanned_at": timezone.now().isoformat(),
            }
            measurement, created = create_progeo_measurement_safe(
                device=device,
                raw_data=measurement_data,
                db=account.db_name,
            )
            if not measurement:
                dlog(f"Failed to store measurement for {device.raw_hash}")
                continue

            status = "created" if created else "existing"
            dlog(f"Stored measurement for {device.raw_hash} ({status})")

            if PROGEO_CONFIG_HAS_ROOT_SERVER:
                try:
                    root_response = requests.post(
                        f"{PROGEO_CONFIG_HAS_ROOT_SERVER}/api/v1/device/forward/measurement/",
                        json={"data": ProgeoMeasurementSerializer(measurement).data},
                    )
                    if root_response.ok:
                        ilog(f"Forwarded measurement {measurement.pk} to root server {PROGEO_CONFIG_HAS_ROOT_SERVER} ({status})")
                    else:
                        elog(
                            f"Root server rejected forwarded measurement {measurement.pk}: "
                            f"{root_response.status_code} {root_response.text[:200]}"
                        )
                except Exception as exc:
                    elog(f"Failed to send measurement to root server for {device.raw_hash}: {exc}")
