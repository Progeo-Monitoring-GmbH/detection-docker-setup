import os
import tempfile
import time
from typing import Any, Optional, Tuple, Union

from django.contrib.auth.models import User
from django.core.files import File
from django.core.files.storage import FileSystemStorage
from django.db.models import Q
from django.utils import timezone

from progeo.helper.basics import dlog, elog, okaylog, save_check_dir
from progeo.settings import UPLOAD_DIR
from progeo.v1.helper import calc_hash_from_dict
from progeo.v1.models import (
	Account,
	Backup,
	EMail,
	LimitedToken,
	MfSLog,
	ProgeoAlarm,
	ProgeoDevice,
	ProgeoLocation,
	ProgeoMeasurePoint,
	ProgeoMeasurement,
)


def _safe_get_or_create(model, db: str, lookup: dict, defaults: Optional[dict] = None):
	defaults = defaults or {}
	try:
		obj, created = model.objects.using(db).get_or_create(**lookup, defaults=defaults)
		action = "CREATED" if created else "EXISTING"
		okaylog(f"{model.__name__}: {action}", tag="[CREATOR]")
		return obj, created
	except Exception as exc:
		elog(f"Failed to create {model.__name__}", tag="[CREATOR]")
		elog(exc)
		return None, False


def _calc_hash(payload: dict) -> str:
	return calc_hash_from_dict(payload)


def create_account_safe(name: str, db_name: Optional[str] = None, raw_hash: Optional[str] = None,
						  db: Optional[str] = None) -> Tuple[Optional[Account], bool]:
	target_db = db or db_name or "default"
	if db_name is None:
		db_name = target_db
	if not raw_hash:
		raw_hash = _calc_hash({"name": name, "db_name": db_name})

	return _safe_get_or_create(
		Account,
		target_db,
		lookup={"raw_hash": raw_hash},
		defaults={"name": name, "db_name": db_name},
	)


def create_progeo_location_safe(account: Account, address: str, latitude: Optional[float] = None,
											longitude: Optional[float] = None, db: Optional[str] = None) -> Tuple[Optional[ProgeoLocation], bool]:
	db_name = db or getattr(account, "db_name", None) or "default"
	return _safe_get_or_create(
		ProgeoLocation,
		db_name,
		lookup={"account": account, "address": address},
		defaults={"latitude": latitude, "longitude": longitude},
	)


def create_progeo_device_safe(location: ProgeoLocation, hardware: Optional[str] = None, version: Optional[str] = None,
							  has_internet: bool = False, data_interval: int = 3600,
							  raw_hash: Optional[str] = None, db: Optional[str] = None) -> Tuple[Optional[ProgeoDevice], bool]:
	db_name = db or getattr(getattr(location, "account", None), "db_name", None) or "default"
	if not raw_hash:
		raw_hash = _calc_hash({
			"location_id": location.pk,
			"hardware": hardware or "",
			"version": version or "",
			"data_interval": data_interval,
		})

	return _safe_get_or_create(
		ProgeoDevice,
		db_name,
		lookup={"raw_hash": raw_hash},
		defaults={
			"location": location,
			"hardware": hardware,
			"version": version,
			"has_internet": has_internet,
			"data_interval": data_interval,
		},
	)


def create_progeo_measurement_safe(device: ProgeoDevice, raw_data: Optional[dict] = None,
									   db: Optional[str] = None) -> Tuple[Optional[ProgeoMeasurement], bool]:
	db_name = db or getattr(getattr(getattr(device, "location", None), "account", None), "db_name", None) or "default"
	payload = raw_data or {}
	return _safe_get_or_create(
		ProgeoMeasurement,
		db_name,
		lookup={"device": device, "raw_data": payload},
		defaults={},
	)


def create_progeo_measure_point_safe(location: ProgeoLocation, sensor_order: int, x: float, y: float, nx: float, ny: float,
									  grid_x: Optional[float] = None, grid_y: Optional[float] = None,
									  db: Optional[str] = None) -> Tuple[Optional[ProgeoMeasurePoint], bool]:
	db_name = db or getattr(getattr(location, "account", None), "db_name", None) or "default"
	return _safe_get_or_create(
		ProgeoMeasurePoint,
		db_name,
		lookup={"location": location, "sensor_order": sensor_order, "nx": nx, "ny": ny},
		defaults={"x": x, "y": y, "grid_x": grid_x, "grid_y": grid_y},
	)


def save_location_lageplan(location: ProgeoLocation, source: Union[bytes, Any], original_name: str,
							db: Optional[str] = None) -> str:
	"""Store a lageplan image for a location and persist the reference.

	``source`` is either raw bytes or a Django uploaded file (anything with ``.chunks()``).
	"""
	db_name = "default"

	save_check_dir(UPLOAD_DIR, "lageplan")
	suffix = os.path.splitext(original_name)[1] or ".png"
	filename = os.path.join("lageplan", f"{location.id}_{location.project_id or ''}_{int(time.time())}{suffix}").replace(os.sep, "/")

	chunks = [bytes(source)] if isinstance(source, (bytes, bytearray)) else source.chunks()

	fs = FileSystemStorage(location=UPLOAD_DIR)
	with tempfile.NamedTemporaryFile() as temporary_file:
		for chunk in chunks:
			temporary_file.write(chunk)
		temporary_file.flush()
		temporary_file.seek(0)
		new_file = fs.save(filename, File(temporary_file, name=original_name))

	location.lageplan = new_file
	try:
		location.save(using=db_name)
	except Exception as exc:
		elog(f"Failed saving location lageplan for project {location.project_id}: {exc}")
	return new_file


def _alarm_window_end(alarm) -> Any:
	"""Effective end of an alarm's active window: normalized_at, or now if still active."""
	if alarm.normalized_at is not None:
		return alarm.normalized_at
	return timezone.now()


def _alarm_start(alarm) -> Any:
	"""Effective start of an alarm's window: triggered_at, with a fallback for legacy rows."""
	if alarm.triggered_at is not None:
		return alarm.triggered_at
	if alarm.measurement is not None:
		return alarm.measurement.last_updated or alarm.measurement.last_fetched or alarm.last_fetched
	return alarm.last_fetched


def find_overlapping_alarms(device, triggered_at, db: str):
	"""
	Return all alarms of `device` whose active window [start, end] overlaps the given
	trigger time. Includes still-active (unnormalized) alarms AND recently normalized
	alarms whose window still covers the trigger time - both must be prolonged/merged
	instead of creating a duplicate alarm.
	"""
	if device is None or triggered_at is None:
		return []
	return list(
		ProgeoAlarm.objects.using(db)
		.select_related("measurement")
		.filter(measurement__device=device)
		.filter(Q(normalized_at__isnull=True) | Q(normalized_at__gte=triggered_at))
		.order_by("triggered_at", "id")
	)


def merge_alarm_into(target: ProgeoAlarm, source: ProgeoAlarm, db: str) -> ProgeoAlarm:
	"""
	Merge `source` into `target` (union of windows, max_values and max_value) and delete
	`source`. `target` keeps its identity, measurement FK and earliest trigger time.
	Used by create_progeo_alarm_safe and the cleanup_alarms management command.
	"""
	if target is None or source is None or target.pk == source.pk:
		return target

	# Earliest trigger wins.
	target_start = _alarm_start(target)
	source_start = _alarm_start(source)
	if source_start is not None and (target_start is None or source_start < target_start):
		target.triggered_at = source.triggered_at

	# Latest end wins: any still-active alarm keeps the merged alarm still active.
	target_still = target.still_active_at or target_start
	source_still = source.still_active_at or source_start
	if source_still is not None and (target_still is None or source_still > target_still):
		target.still_active_at = source_still
	if target.normalized_at is not None and source.normalized_at is not None:
		if source.normalized_at > target.normalized_at:
			target.normalized_at = source.normalized_at
	# If either alarm is still active, the merged alarm is still active.
	elif target.normalized_at is None or source.normalized_at is None:
		target.normalized_at = None

	# Highest peak value wins, together with its sensor.
	if source.max_value is not None:
		if target.max_value is None or source.max_value > target.max_value:
			target.max_value = source.max_value
			if source.sensor_id is not None:
				target.sensor_id = source.sensor_id

	# Union of development history, sorted by timestamp, deduplicated.
	merged_values = list(target.max_values or []) + list(source.max_values or [])
	seen = set()
	unique_values = []
	for entry in sorted(merged_values, key=lambda e: str(e.get("ts", ""))):
		key = (entry.get("ts"), entry.get("sensor_id"), entry.get("value"))
		if key in seen:
			continue
		seen.add(key)
		unique_values.append(entry)
	target.max_values = unique_values

	# Union of over-threshold sensor pairs (highest value per sensor).
	target.sensor_max_values = merge_sensor_max_values(
		target.sensor_max_values, source.sensor_max_values
	)

	# Keep acknowledgement data if either alarm has it; severity (2 stoerung) dominates.
	if source.status == 2:
		target.status = 2
	if target.evaluated_at is None and source.evaluated_at is not None:
		target.evaluated_at = source.evaluated_at
		target.evaluated_by = source.evaluated_by

	target.save(using=db, update_fields=[
		"triggered_at", "still_active_at", "normalized_at",
		"max_value", "sensor_id", "max_values", "sensor_max_values", "status",
		"evaluated_at", "evaluated_by",
	])
	source.delete(using=db)
	return target


def merge_sensor_max_values(existing: list, incoming: Optional[list]) -> list:
	"""Merge (sensor_id, max_value) pairs, keeping the highest value per sensor."""
	merged = list(existing or [])
	by_sensor = {}
	for entry in merged:
		sid = entry.get("sensor_id")
		if sid is not None:
			by_sensor[sid] = max(by_sensor.get(sid, 0), float(entry.get("max_value") or 0))
	for entry in incoming or []:
		sid = entry.get("sensor_id")
		if sid is None:
			continue
		value = float(entry.get("max_value") or 0)
		if sid in by_sensor:
			by_sensor[sid] = max(by_sensor[sid], value)
		else:
			by_sensor[sid] = value
	return [{"sensor_id": sid, "max_value": value} for sid, value in by_sensor.items()]


def create_progeo_alarm_safe(measurement: ProgeoMeasurement, sensor_id: Optional[int] = None,
							  threshold: Optional[float] = None, max_value: Optional[float] = None, triggered_at=None, status: int = 0,
							  evaluated_by: Optional[User] = None, normalized_at=None,
							  sensor_max_values: Optional[list] = None,
							  db: Optional[str] = "default") -> Tuple[Optional[ProgeoAlarm], bool]:
	if measurement is None:
		return None, False

	db_name = db

	# `triggered_at` is crucial for the alarm timeline. When the caller does not
	# provide it, fall back to the measurement's own timestamps so the alarm is
	# never created without a trigger time.
	if triggered_at is None:
		triggered_at = measurement.last_updated or measurement.last_fetched or timezone.now()

	# Record this measurement in the alarm's development history, so the
	# timeline can color-code the alarm's progress over time like the heatmap.
	max_value_entry = None
	if max_value is not None:
		ts = measurement.last_fetched or measurement.last_updated or triggered_at
		max_value_entry = {
			"ts": ts.isoformat() if hasattr(ts, "isoformat") else ts,
			"value": float(max_value),
			"sensor_id": sensor_id,
		}

	if isinstance(measurement, ProgeoMeasurement):
		device = measurement.device
		# Any alarm of this device whose window [triggered_at, normalized_at] still
		# covers the new trigger time must be prolonged/merged instead of creating a
		# duplicate: this includes still-active alarms AND recently normalized alarms
		# (re-evaluation of an older measurement after check_existing_alarms
		# normalized the alarm must not spawn a second, overlapping alarm).
		existing_alarms = find_overlapping_alarms(device, triggered_at, db_name)
		if len(existing_alarms) > 0:
			# `last_updated` is not set for every measurement; fall back to
			# `last_fetched` so the still-active alarm is always prolonged to a real time.
			still_active_at = measurement.last_fetched or measurement.last_updated or timezone.now()
			target = existing_alarms[0]
			# Merge leftover duplicates into the earliest alarm of the group.
			for other in existing_alarms[1:]:
				merge_alarm_into(target, other, db_name)
			update_fields = ["still_active_at"]
			if target.still_active_at is None or still_active_at > target.still_active_at:
				target.still_active_at = still_active_at
			if max_value_entry is not None:
				# The same measurement is re-evaluated by later hourly runs, so only
				# append the entry if its timestamp is not already tracked.
				existing_ts = {str(e.get("ts")) for e in (target.max_values or [])}
				if str(max_value_entry.get("ts")) not in existing_ts:
					target.max_values = list(target.max_values or []) + [max_value_entry]
					update_fields.append("max_values")
			if sensor_max_values:
				merged = merge_sensor_max_values(target.sensor_max_values, sensor_max_values)
				if merged != list(target.sensor_max_values or []):
					target.sensor_max_values = merged
					update_fields.append("sensor_max_values")
			if target.triggered_at is None or (triggered_at is not None and triggered_at < target.triggered_at):
				# Backfill the trigger time for legacy alarms without one, or move it
				# earlier when an older measurement of the same episode is re-evaluated.
				target.triggered_at = triggered_at
				update_fields.append("triggered_at")
			target.save(using=db_name, update_fields=update_fields)
			okaylog(f"Existing alarm {target.pk} for device {device.id} prolonged/merged. (found={len(existing_alarms)})", tag="[CREATOR]")
			return target, False

	return _safe_get_or_create(
		ProgeoAlarm,
		db_name,
		lookup={
			"measurement": measurement,
			"threshold": threshold,
			"max_value": max_value,
			"sensor_id": sensor_id,
			"status": status,
		},
		defaults={
			"triggered_at": triggered_at,
			"still_active_at": triggered_at,
			"sensor_max_values": list(sensor_max_values or []),
			"max_values": [max_value_entry] if max_value_entry is not None else [],
			"evaluated_by": evaluated_by,
			"normalized_at": normalized_at,
		},
	)


def create_email_safe(sent_to: str, message: str, files: str = "", subject: str = "",
					  raw_hash: Optional[str] = None, db: str = "default") -> Tuple[Optional[EMail], bool]:
	if not raw_hash:
		raw_hash = _calc_hash({
			"sent_to": sent_to,
			"subject": subject,
			"message": message,
			"files": files,
		})

	return _safe_get_or_create(
		EMail,
		db,
		lookup={"raw_hash": raw_hash},
		defaults={
			"sent_to": sent_to,
			"subject": subject,
			"message": message,
			"files": files,
		},
	)


def create_limited_token_safe(account: Account, user: Optional[User] = None, purpose: str = "",
							  raw_data: Optional[dict] = None, valid_until=None,
							  raw_hash: Optional[str] = None, db: Optional[str] = None) -> Tuple[Optional[LimitedToken], bool]:
	db_name = db or getattr(account, "db_name", None) or "default"
	payload = raw_data or {}
	if not raw_hash:
		raw_hash = _calc_hash({"account_id": account.pk, "purpose": purpose, "raw_data": payload})
	if valid_until is None:
		valid_until = timezone.now()

	return _safe_get_or_create(
		LimitedToken,
		db_name,
		lookup={"raw_hash": raw_hash},
		defaults={
			"account": account,
			"user": user,
			"purpose": purpose,
			"raw_data": payload,
			"valid_until": valid_until,
		},
	)


def create_backup_safe(account: Account, name: str, user: Optional[User] = None,
					   db: Optional[str] = None) -> Tuple[Optional[Backup], bool]:
	_db = db or account.db_name
	return _safe_get_or_create(
		Backup,
		_db,
		lookup={"account": account, "name": name},
		defaults={"user": user},
	)


def create_mfs_log_safe(account: Account, url: str, data: Optional[dict] = None, user: Optional[User] = None,
						created=None, db: Optional[str] = None) -> Tuple[Optional[MfSLog], bool]:
	_db = db or account.db_name
	payload = data or {}
	if created is None:
		created = timezone.now()

	# Keep logs idempotent for identical request payload/time bucket.
	return _safe_get_or_create(
		MfSLog,
		_db,
		lookup={"account": account, "url": url, "data": payload, "created": created},
		defaults={"user": user},
	)


def create_all_models_safe(account_name: str, db_name: str, user: Optional[User] = None) -> dict[str, Any]:
	account, _ = create_account_safe(name=account_name, db_name=db_name)
	if not account:
		return {"account": None}

	location, _ = create_progeo_location_safe(account=account, address="unknown")
	device, _ = create_progeo_device_safe(location=location) if location else (None, False)
	measurement, _ = create_progeo_measurement_safe(device=device, raw_data={}) if device else (None, False)
	measure_point, _ = create_progeo_measure_point_safe(device=device, sensor_order=1, x=0.0, y=0.0, nx=0.0, ny=0.0) if device else (None, False)
	alarm, _ = create_progeo_alarm_safe(measurement=measurement, threshold=100.0, max_value=0.0) if measurement else (None, False)
	email, _ = create_email_safe(sent_to="unknown@example.com", message="initialized", db="default")
	token, _ = create_limited_token_safe(account=account, user=user, purpose="init")
	backup, _ = create_backup_safe(account=account, name="initial.backup", user=user)
	mfs_log, _ = create_mfs_log_safe(account=account, user=user, url="http://localhost/init", data={"init": True})

	return {
		"account": account,
		"location": location,
		"device": device,
		"measurement": measurement,
		"measure_point": measure_point,
		"alarm": alarm,
		"email": email,
		"limited_token": token,
		"backup": backup,
		"mfs_log": mfs_log,
	}
