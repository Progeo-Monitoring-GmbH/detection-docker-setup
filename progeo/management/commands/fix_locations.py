import random

from django.core.management.base import BaseCommand
from django.db.models import Q

from progeo.helper.basics import dlog, elog, ilog, wlog
from progeo.helper.legacy.geo import GeoHelper
from progeo.settings import DATABASES
from progeo.v1.models import ProgeoLocation

DRY_RUN_SAMPLE_SIZE = 30


def _blank(value) -> bool:
    return value is None or str(value).strip() == ""


class Command(BaseCommand):
    help = (
        "Finds ProgeoLocation rows without coordinates and splits them into locations "
        "with no address data at all (nothing to geocode) and locations with address "
        "data that GeoHelper.fetch_lat_lon could not resolve. Locations that do resolve "
        "are patched with their new coordinates."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--db",
            default=None,
            help="Only process a single database (defaults to all configured databases).",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Only report findings without saving any coordinates.",
        )

    def handle(self, *args, **options):
        db_names = [options["db"]] if options.get("db") else list(DATABASES.keys())
        dry_run = options["dry_run"]

        geo_helper = GeoHelper(logger=dlog)

        total_missing_address = 0
        total_invalid = 0
        total_fixed = 0

        for db_name in db_names:
            try:
                missing_address, invalid, fixed = self._fix_db(db_name, geo_helper, dry_run=dry_run)
            except Exception as exc:
                elog(f"[fix_locations] db={db_name} failed: {exc}")
                continue

            total_missing_address += missing_address
            total_invalid += invalid
            total_fixed += fixed
            ilog(f"[fix_locations] db={db_name} no_address={missing_address} invalid={invalid} fixed={fixed}")

        self.stdout.write(
            self.style.SUCCESS(
                f"Fixed {total_fixed} location(s), {total_missing_address} without any address data, "
                f"{total_invalid} with address data that could not be geocoded."
                + (" (dry run, nothing changed)" if dry_run else "")
            )
        )

    def _fix_db(self, db: str, geo_helper: GeoHelper, dry_run: bool = False) -> tuple[int, int, int]:
        """Categorizes+fixes coordinate-less locations of one database. Returns (no_address, invalid, fixed)."""
        locations = list(ProgeoLocation.objects.using(db).filter(
            Q(latitude__isnull=True) | Q(longitude__isnull=True)
        ).distinct())

        if dry_run and len(locations) > DRY_RUN_SAMPLE_SIZE:
            locations = random.sample(locations, DRY_RUN_SAMPLE_SIZE)

        no_address = 0
        invalid = 0
        fixed = 0

        for location in locations:
            has_address = not any(_blank(v) for v in (location.address, location.plz, location.city))

            if not has_address:
                no_address += 1
                wlog(
                    f"[fix_locations] db={db} project={location.project_id} '{location.name}' "
                    f"has no address data (address={location.address!r}, plz={location.plz!r}, city={location.city!r})"
                )
                continue

            lat, lon = geo_helper.fetch_lat_lon(
                project_id=location.project_id,
                address=location.address,
                plz=location.plz,
                city=location.city,
            )

            if lat is None or lon is None:
                invalid += 1
                wlog(
                    f"[fix_locations] db={db} project={location.project_id} '{location.name}' "
                    f"has invalid/unresolvable address data (address={location.address!r}, "
                    f"plz={location.plz!r}, city={location.city!r})"
                )
                continue

            fixed += 1
            if dry_run:
                self.stdout.write(
                    f"[dry-run] would set project={location.project_id} '{location.name}' "
                    f"to lat={lat}, lon={lon}"
                )
            else:
                location.latitude = lat
                location.longitude = lon
                location.save(using=db, update_fields=["latitude", "longitude"])
                ilog(f"[fix_locations] db={db} project={location.project_id} fixed -> lat={lat}, lon={lon}")

        return no_address, invalid, fixed
