import json
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from progeo.management.commands._base import BaseCommand


from progeo.helper.basics import dlog, elog, ilog
from progeo.helper.legacy.geo import GeoHelper
from progeo.v1.creator import save_location_lageplan
from progeo.v1.legacy.executor import fetch_legacy_data, parse_sample_timestamp
from progeo.v1.legacy.helper_resistance import MAX_JSON_SAFE_RESISTANCE_OHM
from progeo.v1.models import Account, ProgeoDevice, ProgeoLocation, ProgeoMeasurement, ProgeoLageplan



def fetch_device_locations():
    devices = ProgeoDevice.objects.filter(location__isnull=True).all()
    dlog(f"Found {len(devices)} devices without location")  
    for device in devices:
        if device.project_id:
            pid = device.project_id
        elif device.raw_hash:
            pid = device.raw_hash
        else:
            dlog(f"Skipping device {device.raw_hash} without project_id or raw_hash")
            continue

        if not isinstance(pid, int):
            try:
                pid = int(pid)
            except ValueError:
                dlog(f"Skipping device {device.raw_hash} with non-integer project_id: {pid}")
                continue

        location = ProgeoLocation.objects.filter(project_id=pid).first()
        if location:
            device.location = location
            device.save()
            dlog(f"Assigned location {location} to device {device.raw_hash}")


class Command(BaseCommand):
    help = (
        'Patches for live data. Selects the patch to run with -p/--patch.\n\n'
        'Available patches:\n'
        '  fix_dragino_usage         backfill last_updated / resistances for a dragino device\n'
        '  fetch_projects            import projects from data-progeo.net into locations\n'
        '  fetch_legacy_data         fetch legacy measurement data (dry run)\n'
        '  fetch_device_locations    assign locations to devices without one\n'
        '  fetch_lageplan            download lageplan images for locations without one\n'
        '  migrate_legacy_lageplan   convert old lageplan fields to new ProgeoLageplan model\n\n'
        'Examples:\n'
        '  python manage.py patch_live --patch fetch_projects\n'
        '  python manage.py patch_live --patch fix_dragino_usage\n'
        '  python manage.py patch_live --patch fetch_legacy_data\n'
        '  python manage.py patch_live --patch fetch_device_locations\n'
        '  python manage.py patch_live --patch fetch_lageplan\n'
        '  python manage.py patch_live --patch migrate_legacy_lageplan'
    )

    def add_arguments(self, parser):
        parser.add_argument("-p", "--patch",
                            help="Select a patch to run",
                            default=None)




    def handle(self, *args, **options):

        patch = options.get("patch")

        if patch == "fix_dragino_usage":
            imei = "863663069840180"

            measurements = ProgeoMeasurement.objects.filter(device__raw_hash=imei, last_updated__isnull=True)

            for m in measurements:
                data = m.raw_data
                row = data.get("raw", {}).get("1", [0, 0, 0])

                _, _, ts = row[0], row[1], row[2]
                m.last_updated = parse_sample_timestamp(ts)

                if len(data["resistance_rows"]) >= 1:
                    sample = data["resistance_rows"][0]
                    m.resistance_idc = sample.get("r_idc_ohm", MAX_JSON_SAFE_RESISTANCE_OHM)
                    m.resistance_vdc = sample.get("r_vdc_ohm", MAX_JSON_SAFE_RESISTANCE_OHM)
                    m.voltage = sample.get("vdc_intput", -1)

                m.save()

        if patch == "fetch_projects":
            url = "http://data-progeo.net/DB/admin/bad.php"
            dlog(f"Fetching projects from {url}")
            geo_helper = GeoHelper(logger=dlog)

            with urlopen(url, timeout=30) as response:
                payload = response.read().decode("utf-8", errors="replace")

            project_rows = json.loads(payload)
            if isinstance(project_rows, dict):
                # Allow wrapped responses like {"results": [...]}.
                for key in ("results", "data", "items"):
                    if isinstance(project_rows.get(key), list):
                        project_rows = project_rows[key]
                        break

            if not isinstance(project_rows, list):
                dlog(f"Unexpected payload format: {type(project_rows).__name__}")
                dlog("DONE!")
                return

            dlog(f"Parsed {len(project_rows)} project entries")

            account = Account.objects.get(pk=1)
            for row in project_rows:
                if not isinstance(row, dict):
                    continue

                project_id = row.get("project_ID")
                if project_id in (None, ""):
                    continue

                project_id = int(project_id)
                location, created = ProgeoLocation.objects.get_or_create(
                    account=account,
                    project_id=project_id,
                )

                location.name = row.get("project_name")
                location.plz = row.get("project_plz")
                location.city = row.get("project_ort")
                location.address = row.get("project_street")
                location.manager = row.get("project_manager")
                location.telefon = row.get("project_tel")
                location.mail = row.get("project_mail")

                has_geo_source = all([
                    location.city not in (None, ""),
                    location.plz not in (None, ""),
                    location.address not in (None, ""),
                ])

                if has_geo_source and (location.latitude is None or location.longitude is None):
                    lat, lon = geo_helper.fetch_lat_lon(
                        project_id=project_id,
                        address=location.address,
                        plz=location.plz,
                        city=location.city,
                    )
                    if lat is not None and lon is not None:
                        location.latitude = lat
                        location.longitude = lon

                location.save()

                if created:
                    dlog(f"Created new location for project {project_id}: {location.name}")

                devices = ProgeoDevice.objects.filter(raw_hash=project_id).all()
                if len(devices) == 1:
                    device = devices[0]
                    device.project_id = project_id
                    device.location = location
                    device.save()

        if patch == "fetch_legacy_data":
            fetch_legacy_data(dry_run=True)

        if patch == "fetch_device_locations":
            fetch_device_locations()

        if patch == "fetch_lageplan":
            locations = ProgeoLocation.objects.filter(lageplan__isnull=True).all()
            for location in locations:
                url = f"http://data-progeo.net/DB/upload/{location.project_id}/system/{location.project_id}.png"
                try:
                    with urlopen(url, timeout=1) as response:
                        content = response.read()
                except HTTPError as exc:
                    if exc.code == 404:
                        dlog(f"No lageplan found for project {location.project_id}")
                    else:
                        dlog(f"Failed fetching lageplan for project {location.project_id}: {exc}")
                    continue
                except URLError as exc:
                    dlog(f"Failed fetching lageplan for project {location.project_id}: {exc}")
                    continue

                if not content:
                    dlog(f"Empty lageplan response for project {location.project_id}")
                    continue

                save_location_lageplan(location, content, f"{location.project_id}.png")
                dlog(f"Fetched lageplan for project {location.project_id}")

        if patch == "fix_unknown_location":

            devices = ProgeoDevice.objects.filter(project_id__isnull=True).all()
            for device in devices:
                project_id = device.raw_hash
                try:
                    location = ProgeoLocation.objects.filter(project_id=device.raw_hash).first()
                    if location:
                        device.location = location
                        device.project_id = project_id
                        device.save()
                        ilog(f"Updated device {device.id} with project_id {project_id} and location {location.id}")
                except ValueError as exc:
                    elog(f"Failed to update device {device.id} with project_id {project_id}: {exc}")

            locations = ProgeoLocation.objects.filter(project_id__isnull=True).all()
            for location in locations:
                devices = ProgeoDevice.objects.filter(location=location).all()
                for device in devices:
                    if not device.project_id:
                        measurement = ProgeoMeasurement.objects.filter(device=device, project_id__isnull=True).first()
                        dlog(f"Device {device.id} has no project_id, skipping | {measurement}")

                        if not measurement:
                            continue
                        project_id = measurement.project_id
                    else:
                        project_id = device.project_id

                    if not project_id:
                        dlog(f"No project_id found for device {device.id}, skipping")
                        continue

                    dlog(f"Attempting to update location for device {project_id}")
                    try:
                        device.location = ProgeoLocation.objects.get(project_id=project_id)
                        device.save()
                        ilog(f"Updated location for device {project_id}")
                    except ProgeoLocation.DoesNotExist:
                        dlog(f"No location found for project {project_id}")
        
        if patch == "migrate_legacy_lageplan":
            """
            Convert legacy lageplan fields from ProgeoLocation to new ProgeoLageplan model.
            
            For each location with lageplan data, creates a ProgeoLageplan record with:
            - lageplan file
            - offset_x, offset_y (pixel offsets)
            - scale_x, scale_y (scaling factors)
            - flip_x, flip_y (transformations)
            - offset_latitude, offset_longitude (georeferencing)
            
            Marks new lageplan as active and logs progress.
            """
            locations_with_lageplan = ProgeoLocation.objects.filter(lageplan__isnull=False).exclude(lageplan='').all()
            total = locations_with_lageplan.count()
            created = 0
            skipped = 0
            
            ilog(f"Starting migration of {total} locations with legacy lageplan data")
            
            for location in locations_with_lageplan:
                # Check if this location already has a ProgeoLageplan (avoid duplicates)
                if ProgeoLageplan.objects.filter(location=location).exists():
                    skipped += 1
                    dlog(f"Location {location.id} ({location.project_id}) already has ProgeoLageplan, skipping")
                    continue
                
                try:
                    # Create ProgeoLageplan with the legacy data
                    lageplan = ProgeoLageplan(
                        location=location,
                        lageplan=location.lageplan,
                        name='',
                        offset_x=location.offset_x,
                        offset_y=location.offset_y,
                        scale_x=location.scale_x if location.scale_x else 1.0,
                        scale_y=location.scale_y if location.scale_y else 1.0,
                        flip_x=location.flip_x,
                        flip_y=location.flip_y,
                        offset_latitude=location.offset_latitude,
                        offset_longitude=location.offset_longitude,
                        is_active=True,
                    )
                    lageplan.save()
                    created += 1
                    ilog(f"✓ Migrated lageplan for location {location.id} ({location.name or location.project_id})")
                except Exception as exc:
                    elog(f"✗ Failed to migrate lageplan for location {location.id} ({location.project_id}): {exc}")
            
            ilog(f"Migration complete: {created} created, {skipped} skipped out of {total} locations")
                    
        dlog("DONE!")
