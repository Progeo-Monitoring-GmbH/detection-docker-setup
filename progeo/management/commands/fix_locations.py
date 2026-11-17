from django.db.models import Q

from progeo.helper.basics import dlog, elog, ilog
from progeo.helper.legacy.geo import GeoHelper
from progeo.management.commands._base import BaseCommand
from progeo.v1.models import ProgeoLocation

# Nominatim's usage policy: at most one request per second.
NOMINATIM_DELAY_SECONDS = 1.0


def _blank(value) -> bool:
    return value is None or str(value).strip() == ""


def missing_position_q():
    """Locations without a usable GPS position: no coordinates, or 0/0 -
    what old imports wrote for "unknown" (a point in the Atlantic)."""
    return Q(latitude__isnull=True) | Q(longitude__isnull=True) | Q(latitude=0, longitude=0)


def _location_databases():
    """The databases holding the locations themselves: those of the
    configured accounts. Project databases only hold mirrors, which follow
    "default" on save (project_db_signals)."""
    from progeo.helper.location_access import configured_accounts
    from progeo.helper.project_dbs import is_project_alias

    return sorted({account.db_name for account in configured_accounts() if not is_project_alias(account.db_name)})


class Command(BaseCommand):
    help = (
        "Finds locations without a GPS position - no coordinates or 0/0 - and looks\n"
        "their address up (Nominatim, at most one request per second). Reports per\n"
        "location: the position found, 'no address' (nothing to look up) or\n"
        "'not found' (the address could not be resolved - fix it in the Objekt tab).\n\n"
        "Dry run by default: nothing is written without --apply.\n\n"
        "Examples:\n"
        "  python manage.py fix_locations\n"
        "  python manage.py fix_locations --limit 20\n"
        "  python manage.py fix_locations --apply\n"
        "  python manage.py fix_locations --apply --db default"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--db",
            default=None,
            help="Only process this database (default: the databases of the configured accounts).",
        )
        parser.add_argument("--apply", action="store_true", help="Save the positions found.")
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report only (the default; kept for older call sites).",
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=None,
            help="Look up at most this many locations per database (e.g. for a first look).",
        )

    def handle(self, *args, **options):
        apply = options["apply"] and not options["dry_run"]
        db_names = [options["db"]] if options.get("db") else _location_databases()
        geo_helper = GeoHelper(logger=dlog, min_delay_seconds=NOMINATIM_DELAY_SECONDS)

        totals = {"found": 0, "no_address": 0, "not_found": 0}
        for db_name in db_names:
            try:
                counts = self._fix_db(db_name, geo_helper, apply=apply, limit=options["limit"])
            except Exception as exc:  # noqa: BLE001 - one failing database must not stop the others
                elog(f"[fix_locations] db={db_name} failed: {exc}")
                self.stdout.write(self.style.ERROR(f"db={db_name}: failed ({exc})"))
                continue
            for key, value in counts.items():
                totals[key] += value
            ilog(f"[fix_locations] db={db_name} {counts}")

        verb = "Set" if apply else "Would set"
        self.stdout.write(self.style.SUCCESS(
            f"{verb} {totals['found']} position(s); {totals['no_address']} location(s) without an address, "
            f"{totals['not_found']} whose address could not be resolved."
            + ("" if apply else " Dry run - nothing saved, use --apply.")
        ))

    def _fix_db(self, db: str, geo_helper: GeoHelper, apply: bool = False, limit=None) -> dict:
        """Looks up the missing positions of one database. Returns the counts
        {"found", "no_address", "not_found"}."""
        locations = list(ProgeoLocation.objects.using(db).filter(missing_position_q()).order_by("project_id", "pk"))
        counts = {"found": 0, "no_address": 0, "not_found": 0}
        looked_up = 0
        for location in locations:
            label = f"db={db} project={location.project_id} id={location.pk} '{location.name}'"
            if all(_blank(value) for value in (location.address, location.plz, location.city)):
                counts["no_address"] += 1
                self.stdout.write(f"{label}: no address")
                continue
            if limit is not None and looked_up >= limit:
                continue
            looked_up += 1
            lat, lon = geo_helper.fetch_lat_lon(
                location.project_id, location.address or "", location.plz or "", location.city or ""
            )
            if lat is None or lon is None:
                counts["not_found"] += 1
                self.stdout.write(
                    f"{label}: not found (address={location.address!r}, plz={location.plz!r}, city={location.city!r})"
                )
                continue
            counts["found"] += 1
            self.stdout.write(f"{label}: {lat}, {lon}" + ("" if apply else " (dry run)"))
            if apply:
                location.latitude = lat
                location.longitude = lon
                location.save(using=db, update_fields=["latitude", "longitude"])
        return counts
