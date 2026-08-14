
from datetime import datetime
import os

from rest_framework.parsers import BaseParser
from django.conf import settings
from progeo.v1.creator import create_progeo_alarm_safe
from progeo.v1.legacy.helper_resistance import MAX_JSON_SAFE_RESISTANCE_OHM
from progeo.v1.models import ProgeoDevice, ProgeoLocation, ProgeoMeasurement
from dataclasses import dataclass
from typing import List
import json
from django.utils import timezone
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from progeo.v1.viewsets.setup_viewset import _get_controller_account
from progeo.consumer import GRP_NAME
 
@dataclass
class DataMeasurement:
    project_id: int
    m_headerlines: int
    m_filetype: int
    m_points: int
    m_type: int
    m_stv: int
    m_date: int
    start: int
    voltage: float
    m_i: float
    m_u: float
    m_aux: float
    m_temp: float
    m_hum: float
    m_pres: float
    mbyte: int
    alert: int
    faul: int
    error: int
    status: int
    rbyte: int
    abyte: int
    bbyte: int
    mac345: int

    samples: List[int]

    def get_relevant_info(self):
        m_i = _to_12bit(self.m_i)
        m_u = _to_12bit(self.m_u)
        m_aux = _to_12bit(self.m_aux)
        m_temp = _to_12bit(self.m_temp)
        m_hum = _to_12bit(self.m_hum)
        m_pres = _to_12bit(self.m_pres)
        voltage = _to_12bit(self.voltage)
        data = {
            "project_id": self.project_id,
            "date": self.m_date,
            "pressure": m_pres,
            "voltage": voltage,
            "m_i_raw": m_i,
            "m_u_raw": m_u,
            "m_aux_raw": m_aux,
            "m_temp_raw": m_temp,
            "m_hum_raw": m_hum,
            "m_pres_raw": m_pres,
            "voltage_raw": voltage,
            "filetype": self.m_filetype,
            "status": self.status,
            "samples": self.samples,
            "start_index": self.start,
            "end_index": self.m_points,
            "points": self.m_points - self.start,
            "m_i": norm_current(m_i),           # mA
            "m_u": norm_voltage(m_u),           # V
            "m_aux": norm_voltage(m_aux),       # V
            "m_temp": norm_temperature(m_temp), # °C
            "m_hum": norm_humidity(m_hum)       # %
        }
        if self.error != 0:
            data["error"] = self.error
        if self.alert != 0:
            data["alert"] = self.alert

        return data


def _to_12bit(value):
    try:
        return int(value) & 0x0FFF
    except (ValueError, TypeError):
        return 0


def norm_current(value):
    return round(value * 0.0141 - 6.3634, 2)

def norm_voltage(value):
    return round(value * 0.0053 - 0.1015, 2)

def norm_temperature(value):
    return round(value * -0.0428 + 150.3, 1)

def norm_humidity(value):
    return round(value * -0.3409 + 1392.3, 1)


def parse_sample_timestamp(timestamp_value):
    if not timestamp_value:
        return None

    parsed = None

    if isinstance(timestamp_value, datetime):
        parsed = timestamp_value
    elif isinstance(timestamp_value, str):
        text = timestamp_value.strip()
        if not text:
            return None

        formats = [
            "%Y/%m/%d %H:%M:%S",
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%dT%H:%M:%S",
            "%Y-%m-%dT%H:%M:%S.%f",
        ]
        for fmt in formats:
            try:
                parsed = datetime.strptime(text, fmt)
                break
            except ValueError:
                continue

        if parsed is None:
            try:
                parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                return None
    else:
        return None

    if timezone.is_naive(parsed):
        return timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed

def is_imei(value):
    if not isinstance(value, str):
        return False
    text = value.strip()
    if len(text) != 15 or not text.isdigit():
        return False
    return True

def get_device_type(measurement, device_id) -> ProgeoDevice.DeviceType:
    if is_imei(device_id):
        return ProgeoDevice.DeviceType.IMEI
    elif isinstance(measurement, DataMeasurement):
        return ProgeoDevice.DeviceType.SMARTBOX
    elif isinstance(measurement, dict):
        return ProgeoDevice.DeviceType.LEGACY

def save_measurement_from_legacy_data(measurement, device_id: str, battery_V: int = None, last_battery_percentage: int = None):
    db_name = "default"
    device, created = ProgeoDevice.objects.using(db_name).get_or_create(raw_hash=device_id)

    if created:
        device.device_ip = None
        device.type = get_device_type(measurement, device_id)
        device.save(using=db_name)

        account = _get_controller_account()
        location, _ = ProgeoLocation.objects.using(db_name).get_or_create(
                account=account,
                project_id=device_id,
            )
        location.devices.add(device)
        location.save(using=db_name)


    if isinstance(measurement, DataMeasurement):
        data = measurement.get_relevant_info()
        measure = ProgeoMeasurement.objects.using(db_name).create(
            project_id=data.get("project_id"),
            voltage=data.get("voltage"),
            humidity=data.get("m_hum"),
            temperature=data.get("m_temp"),
            current=data.get("m_i"),
            samples=data.get("samples"),
            start_index=data.get("start_index"),
            end_index=data.get("end_index"),
            points=data.get("points"),
            device=device,
            raw_data={
                "status": data.get("status"),
                "error": data.get("error", 0),
                "alert": data.get("alert", 0),
                "filetype": data.get("filetype"),
                # Persist raw 12-bit fields for audit/debug and exact downstream reuse. REMOVE LATER
                "m_i": data.get("m_i_raw"),
                "m_u": data.get("m_u_raw"),
                "m_aux": data.get("m_aux_raw"),
                "m_temp": data.get("m_temp_raw"),
                "m_hum": data.get("m_hum_raw"),
                "m_pres": data.get("m_pres_raw"),
                "voltage_raw": data.get("voltage_raw"),
            },
        )
    elif isinstance(measurement, dict):
        data = measurement
        if battery_V is not None:
            data["battery_V"] = battery_V
        if last_battery_percentage is not None:
            data["last_battery_percentage"] = last_battery_percentage
        
        samples = data.get("samples", [])
        del data["samples"]

        measure = ProgeoMeasurement.objects.using(db_name).create(
            device=device,
            project_id=data.get("project_id"),
            samples=samples,
            raw_data=data,
        )
        if len(data["resistance_rows"]) >= 1:
            sample = data["resistance_rows"][0]
            timestamp = sample.get("timestamp")
            parsed_timestamp = parse_sample_timestamp(timestamp)
            if parsed_timestamp is not None:
                measure.last_updated = parsed_timestamp
            measure.resistance_idc = sample.get("r_idc_ohm", MAX_JSON_SAFE_RESISTANCE_OHM)
            measure.resistance_vdc = sample.get("r_vdc_ohm", MAX_JSON_SAFE_RESISTANCE_OHM)
            measure.voltage = sample.get("vdc_intput", -1)

    else:
        raise ValueError("Measurement must be a DataMeasurement instance or a dict | measurement:", measurement)


    measure.save(using=db_name)

    '''
    # To heavy load. Evaluate via cronjob
    alarm_threshold = 1500  #device.location.alarm_threshold if device and device.location else 150
    sensor_id, max_value = measure.evaluate(alarm_threshold=alarm_threshold)
    if sensor_id is not None and max_value is not None:
        create_progeo_alarm_safe(
            measurement=measure,
            sensor_id=sensor_id + 1,
            max_value=max_value,
            threshold=alarm_threshold,
            triggered_at=measure.last_updated,
            db=db_name
        )
    '''
    return measure
        


def _normalize_legacy_payload_to_int_list(data):
    if data is None:
        return []

    # Legacy payload can be either one CSV string or an already split list.
    if isinstance(data, str):
        raw_items = data.split(",")
    elif isinstance(data, list):
        raw_items = []
        for item in data:
            if isinstance(item, str) and "," in item:
                raw_items.extend(item.split(","))
            else:
                raw_items.append(item)
    else:
        raw_items = [data]

    values = []
    for item in raw_items:
        text = str(item).strip()
        if not text:
            values.append(0)
            continue

        try:
            values.append(int(float(text)))
        except (TypeError, ValueError, OverflowError):
            values.append(0)
    return values


def _broadcast_legacy_location(project_id: int):
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return

    location = ProgeoLocation.objects.using("default").filter(project_id=project_id).first()
    payload = {
        "type": "legacy_location_event",
        "project_id": project_id,
        "parsed_at": timezone.now().isoformat(),
        "location": None,
    }

    if location:
        payload["location"] = {
            "id": location.id,
            "project_id": location.project_id,
            "name": location.name,
            "city": location.city,
            "address": location.address,
            "plz": location.plz,
            "manager": location.manager,
            "telefon": location.telefon,
            "mail": location.mail,
            "latitude": location.latitude,
            "longitude": location.longitude,
        }

    async_to_sync(channel_layer.group_send)(GRP_NAME, payload)


def parse_legacy_data_measurement(data):
    values = _normalize_legacy_payload_to_int_list(data)
    if len(values) < 25:
        raise ValueError("Legacy data requires at least 25 indexed values")

    samples = values[25:]
    last = samples[-1] if samples else 0
    measurement = DataMeasurement(
        project_id=values[0],
        m_headerlines=values[2],
        m_filetype=values[3],
        m_points=values[4],
        m_type=values[5],
        m_stv=values[6],
        m_date=values[7],
        start=values[8],
        m_i=_to_12bit(values[9]),
        m_u=_to_12bit(values[10]),
        m_aux=_to_12bit(values[11]),
        m_temp=_to_12bit(values[12]),
        m_hum=_to_12bit(values[13]),
        m_pres=_to_12bit(values[14]),
        voltage=_to_12bit(values[15]),
        mbyte=values[16],
        alert=values[17],
        faul=values[18],
        error=values[19],
        status=values[20],
        rbyte=values[21],
        abyte=values[22],
        bbyte=values[23],
        mac345=values[24],
        samples=samples,
    )

    _broadcast_legacy_location(measurement.project_id)
    return measurement


def fetch_legacy_data(target_dir=None, dry_run=True):
    if target_dir is None:
        target_dir = os.path.join(settings.MEDIA_ROOT, "legacy_fetch")

    report = {
        "target_dir": target_dir,
        "dry_run": dry_run,
        "files_total": 0,
        "files_with_y": 0,
        "file_read_errors": 0,
        "lines_total": 0,
        "y_lines_total": 0,
        "parsed_total": 0,
        "parse_errors": 0,
        "saved_total": 0,
        "save_errors": 0,
        "input_bytes": 0,
        "projects_found": set(),
        "error_examples": [],
    }

    if not os.path.isdir(target_dir):
        print(f"Legacy target directory does not exist: {target_dir}")
        return report

    def _split_timestamp_and_payload(raw_line):
        text = (raw_line or "").strip()
        if not text or "," not in text:
            return None, ""
        timestamp_text, payload = text.split(",", 1)
        return timestamp_text.strip(), payload.strip()

    def _build_parse_line(raw_line, prev_line):
        current = (raw_line or "").strip()
        if not current:
            return current

        current_timestamp, _ = _split_timestamp_and_payload(current)
        prev_timestamp, prev_payload = _split_timestamp_and_payload(prev_line)

        if current_timestamp and current_timestamp == prev_timestamp and prev_payload:
            needs_separator = not current.endswith((",", ";", "&"))
            current = f"{current}{',' if needs_separator else ''}{prev_payload}"

        if not current.endswith(";"):
            current = f"{current};"
        return current

    for root, _, files in os.walk(target_dir):
        for file_name in sorted(files):
            path = os.path.join(root, file_name)
            if not os.path.isfile(path):
                continue

            report["files_total"] += 1
            try:
                report["input_bytes"] += os.path.getsize(path)
            except OSError:
                pass

            file_has_y = False
            previous_line = None

            try:
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    for line_index, line in enumerate(handle, start=1):
                        report["lines_total"] += 1
                        if "Y=" in line:
                            file_has_y = True
                            report["y_lines_total"] += 1

                            try:
                                parse_line = _build_parse_line(line, previous_line)
                                y_part = parse_line.split("Y=", 1)[1]
                                y_part = y_part.split("&", 1)[0].strip()
                                y_part = y_part.split(";", 1)[0].strip()
                                values = [entry.strip() for entry in y_part.split(",") if entry.strip()]
                                measurement = parse_legacy_data_measurement(values)
                            except (TypeError, ValueError, IndexError) as exc:
                                report["parse_errors"] += 1
                                if len(report["error_examples"]) < 5:
                                    report["error_examples"].append(f"parse {path}:{line_index} -> {exc}")
                                previous_line = line
                                continue

                            report["parsed_total"] += 1
                            report["projects_found"].add(measurement.project_id)

                            if not dry_run:
                                try:
                                    save_measurement_from_legacy_data(
                                        measurement=measurement,
                                        device_id=str(measurement.project_id),
                                    )
                                    report["saved_total"] += 1
                                except Exception as exc:  # pragma: no cover
                                    report["save_errors"] += 1
                                    if len(report["error_examples"]) < 5:
                                        report["error_examples"].append(f"save {path}:{line_index} -> {exc}")

                        previous_line = line
            except OSError as exc:
                report["file_read_errors"] += 1
                if len(report["error_examples"]) < 5:
                    report["error_examples"].append(f"read {path} -> {exc}")

            if file_has_y:
                report["files_with_y"] += 1

    projects_found_count = len(report["projects_found"])
    print("")
    print("=" * 72)
    print("LEGACY DATA IMPORT REPORT")
    print("=" * 72)
    print(f"Mode               : {'DRY-RUN' if dry_run else 'WRITE'}")
    print(f"Target folder      : {report['target_dir']}")
    print("-" * 72)
    print(f"Files total        : {report['files_total']}")
    print(f"Files with Y=      : {report['files_with_y']}")
    print(f"Read errors        : {report['file_read_errors']}")
    print(f"Total lines        : {report['lines_total']}")
    print(f"Y= lines           : {report['y_lines_total']}")
    print("-" * 72)
    print(f"Parsed ok          : {report['parsed_total']}")
    print(f"Parse errors       : {report['parse_errors']}")
    print(f"Saved              : {report['saved_total']}")
    print(f"Save errors        : {report['save_errors']}")
    print(f"Projects found     : {projects_found_count}")
    print(f"Input data size    : {report['input_bytes']} bytes")
    print("=" * 72)
    if report["error_examples"]:
        print("Error samples:")
        for msg in report["error_examples"]:
            print(f"  - {msg}")

    report["projects_found"] = sorted(report["projects_found"])
    return report


class SafeLuaUploadParser(BaseParser):
    media_type = "*/*"

    def parse(self, stream, media_type=None, parser_context=None):
        raw = stream.read()
        text = raw.decode("utf-8", errors="replace")
        normalized_type = (media_type or "").split(";")[0].strip().lower()

        if normalized_type == "application/json":
            try:
                payload = json.loads(text)
            except ValueError:
                return {"content": text}
            if isinstance(payload, dict):
                return payload
            if isinstance(payload, str):
                return {"content": payload}
            return {"content": text}

        return {"content": text}




