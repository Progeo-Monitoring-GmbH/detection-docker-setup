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
	ProgeoDevice,
	ProgeoLocation,
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


def create_account_safe(name: str, db_name: str, raw_hash: Optional[str] = None, db: str = "default") -> Tuple[Optional[Account], bool]:
	if not raw_hash:
		raw_hash = _calc_hash({"name": name, "db_name": db_name})

	return _safe_get_or_create(
		Account,
		db,
		lookup={"raw_hash": raw_hash},
		defaults={"name": name, "db_name": db_name},
	)


def create_progeo_location_safe(account: Account, address: str, latitude: Optional[float] = None,
								longitude: Optional[float] = None, db: Optional[str] = None) -> Tuple[Optional[ProgeoLocation], bool]:
	_db = db or account.db_name
	return _safe_get_or_create(
		ProgeoLocation,
		_db,
		lookup={"account": account, "address": address},
		defaults={"latitude": latitude, "longitude": longitude},
	)


def create_progeo_device_safe(location: ProgeoLocation, hardware: Optional[str] = None, version: Optional[str] = None,
							  has_internet: bool = False, data_interval: int = 3600,
							  raw_hash: Optional[str] = None, db: Optional[str] = None) -> Tuple[Optional[ProgeoDevice], bool]:
	_db = db or location.account.db_name
	if not raw_hash:
		raw_hash = _calc_hash({
			"location_id": location.pk,
			"hardware": hardware or "",
			"version": version or "",
			"data_interval": data_interval,
		})

	return _safe_get_or_create(
		ProgeoDevice,
		_db,
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
	_db = db or device.location.account.db_name
	payload = raw_data or {}

	return _safe_get_or_create(
		ProgeoMeasurement,
		_db,
		lookup={"device": device, "raw_data": payload},
		defaults={},
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
	_db = db or account.db_name
	payload = raw_data or {}
	if not raw_hash:
		raw_hash = _calc_hash({"account_id": account.pk, "purpose": purpose, "raw_data": payload})
	if valid_until is None:
		valid_until = timezone.now()

	return _safe_get_or_create(
		LimitedToken,
		_db,
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
	account, _ = create_account_safe(name=account_name, db_name=db_name, db="default")
	if not account:
		return {"account": None}

	location, _ = create_progeo_location_safe(account=account, address="unknown")
	device, _ = create_progeo_device_safe(location=location) if location else (None, False)
	measurement, _ = create_progeo_measurement_safe(device=device, raw_data={}) if device else (None, False)
	email, _ = create_email_safe(sent_to="unknown@example.com", message="initialized", db="default")
	token, _ = create_limited_token_safe(account=account, user=user, purpose="init")
	backup, _ = create_backup_safe(account=account, name="initial.backup", user=user)
	mfs_log, _ = create_mfs_log_safe(account=account, user=user, url="http://localhost/init", data={"init": True})

	return {
		"account": account,
		"location": location,
		"device": device,
		"measurement": measurement,
		"email": email,
		"limited_token": token,
		"backup": backup,
		"mfs_log": mfs_log,
	}
