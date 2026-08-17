from typing import Any, Optional, Tuple

from django.contrib.auth.models import User
from django.utils import timezone

from progeo.helper.basics import elog, okaylog
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


def create_progeo_alarm_safe(measurement: ProgeoMeasurement, sensor_id: Optional[int] = None,
							  threshold: Optional[float] = None, max_value: Optional[float] = None, triggered_at=None, status: int = 0,
							  evaluated_by: Optional[User] = None, normalized_at=None,
							  db: Optional[str] = "default") -> Tuple[Optional[ProgeoAlarm], bool]:
	if measurement is None:
		return None, False
	
	db_name = db

	if isinstance(measurement, ProgeoMeasurement):
		device = measurement.device
		existing_alarms = ProgeoAlarm.objects.using(db_name).filter(measurement__device=device, normalized_at__isnull=True)
		if len(existing_alarms) > 0:
			# `last_updated` is not set for every measurement; fall back to
			# `last_fetched` so the still-active alarm is always prolonged to a real time.
			still_active_at = measurement.last_fetched
			for alarm in existing_alarms:
				alarm.still_active_at = still_active_at
				alarm.save(using=db_name)
			#okaylog(f"Existing unnormalized alarms found for device {device.id}. Prolonged current alarm.", tag="[CREATOR]")
			return None, False

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
