import os
from typing import Any

import requests
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from progeo.helper.basics import dlog, ilog, elog
from progeo.settings import DJANGO_DATABASES
from progeo.v1.creator import (
    create_account_safe,
    create_progeo_device_safe,
    create_progeo_location_safe,
    create_progeo_measurement_safe,
)
from progeo.v1.viewsets.setup_viewset import StatusViewSet


class Command(BaseCommand):
    help = "scan_devices"

    ping_timeout = 2
    measure_timeout = 120

    def _get_controller_account(self):
        account_name = (os.getenv("CONTROLLER_DEFAULT_ACCOUNT") or "").strip()
        if not account_name:
            raise CommandError("CONTROLLER_DEFAULT_ACCOUNT is not set")

        if not DJANGO_DATABASES:
            raise CommandError("DJANGO_DATABASES is empty")

        account, _ = create_account_safe(name=account_name, db_name=DJANGO_DATABASES[0], db="default")
        if not account:
            raise CommandError("Failed to get or create controller account")

        return account

    @staticmethod
    def _parse_response(response: requests.Response) -> dict[str, Any]:
        try:
            payload = response.json()
            if isinstance(payload, dict):
                return payload
            return {"data": payload}
        except ValueError:
            return {"text": response.text}

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

    def handle(self, *args, **options):
        connected_devices = StatusViewSet.get_connected_devices()
        if not isinstance(connected_devices, list):
            raise CommandError("Could not read connected devices")

        account = self._get_controller_account()
        found_devices = []

        dlog(f"Scanning {len(connected_devices)} connected device(s)")

        for device_info in connected_devices:
            ip_address = device_info.get("ip")
            if not ip_address:
                continue

            base_url = self._build_base_url(ip_address)
            try:
                response = requests.get(f"{base_url}/identify", timeout=self.ping_timeout)
                response.raise_for_status()
            except requests.RequestException:
                dlog(f"Skipping unreachable device at {ip_address}")
                continue

            payload = self._parse_response(response)
            dlog(f"Received payload from {ip_address}: {payload}")
            device_hash = payload.get("data",{}).get("hash")
            if not device_hash:
                dlog(f"Skipping device at {ip_address}: no device identifier")
                continue

            location_label = os.getenv("CONTROLLER_DEFAULT_ACCOUNT", "Unknown Location")
            location, _ = create_progeo_location_safe(account=account, address=location_label)
            if not location:
                elog(f"Skipping device at {ip_address}: failed to create location")
                continue

            device, created = create_progeo_device_safe(
                location=location,
                raw_hash=device_hash,
                db=account.db_name,
            )
            if not device:
                elog(f"Skipping device at {ip_address}: failed to register device")
                continue

            found_devices.append({
                "device": device,
                "device_info": device_info,
                "payload": payload,
                "base_url": base_url,
                "created": created,
            })
            dlog(f"Registered device {device.raw_hash} at {ip_address} | payload: {payload}")

        for found in found_devices:
            ilog(f"Found device {found['device'].raw_hash} at {found['device_info'].get('ip')}, starting measurement")
            device = found["device"]
            device_info = found["device_info"]
            try:
                response = requests.post(f"{found['base_url']}/measure", timeout=self.measure_timeout)
                response.raise_for_status()
            except requests.RequestException as exc:
                dlog(f"Measurement failed for {device.raw_hash}: {exc}")
                continue

            measure_payload = self._parse_response(response)
            measurement_data = {
                "device_hash": device.raw_hash,
                "ip": device_info.get("ip"),
                "mac": device_info.get("mac"),
                "hostname": device_info.get("hostname"),
                "ping": found["payload"],
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

            # TODO relais to legacy server

