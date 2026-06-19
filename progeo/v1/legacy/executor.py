
from rest_framework.parsers import BaseParser
from progeo.v1.models import ProgeoDevice, ProgeoMeasurement
from dataclasses import dataclass
from typing import List
import json

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

    
def save_measurement_from_legacy_data(measurement, device_id: str, battery_V: int = None, last_battery_percentage: int = None):
    db_name = "default"
    device, created = ProgeoDevice.objects.using(db_name).get_or_create(raw_hash=device_id)

    if created:
        device.device_ip = None
        device.save(using=db_name)


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
        measure = ProgeoMeasurement.objects.using(db_name).create(
            device=device,
            project_id=data.get("project_id"),
            samples=data.get("samples"),
            raw_data=data,
        )
    else:
        raise ValueError("Measurement must be a DataMeasurement instance or a dict | measurement:", measurement)


    measure.save(using=db_name)
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
            continue
        values.append(int(float(text)))
    return values


def parse_legacy_data_measurement(data):
    values = _normalize_legacy_payload_to_int_list(data)
    if len(values) < 25:
        raise ValueError("Legacy data requires at least 25 indexed values")

    samples = values[25:]
    last = samples[-1] if samples else 0
    return DataMeasurement(
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




