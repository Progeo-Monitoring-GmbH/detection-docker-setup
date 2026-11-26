"""The manuSensor app's endpoints (helper/manusensor.py, SPEC.md section 5 of
progeo-manusensor). Every error is {"fehler", "meldung"[, "feld"]}, as the
app reads it - not the {"success", "reason"} of the other views.

- GET  /v1/location/<projekt>/sensor/<sensor>/   (or .../sensor/?tag_uid=)
- GET  /v1/location/<projekt>/sensor/   every factory sensor of the project
- POST /v1/location/<projekt>/messungen
  module_manusensor_enabled and access to the location of the project number.
- GET  /v1/werk/projekte/   the projects with factory sensors whose location
  the user may open - module_manusensor_enabled, the same location access.
- POST /v1/werk/sensoren/   the factory values (factory app) - factory accounts.
- GET  /v1/werk/sensoren/   the staff page (/staff/sensors/) - factory accounts.
- GET  /v1/werk/sensoren/airtable/             projects to import (staff)
- GET  /v1/werk/sensoren/airtable/<projekt>/   preview of the import (staff)
- POST /v1/werk/sensoren/airtable/<projekt>/   import "dm Sensoren" (staff)
- GET  /v1/werk/auftraege/[<ID>/]   the dm production orders from Airtable
  (helper/dm_orders.py) - factory accounts.
Factory accounts: staff, superuser or group "Werk" (helper/werk_users.py).
"""

from rest_framework.authentication import SessionAuthentication
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.decorator import has_module_permissions
from progeo.helper import airtable_dm_sensors, dm_orders, manusensor, production
from progeo.helper.manusensor import ManuSensorError

PERMISSION = "module_manusensor_enabled"


def _error(error: ManuSensorError):
    return Response(error.body(), status=error.status)


class _ManuSensorView(APIView):
    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    # Checked in check_user - the answers must be the app's error format.
    permission_classes = []

    @staticmethod
    def check_user(request, allowed):
        user = getattr(request, "user", None)
        if not getattr(user, "is_authenticated", False):
            raise ManuSensorError(401, "nicht_angemeldet", "Bitte anmelden.")
        if not allowed(user):
            raise ManuSensorError(403, "keine_berechtigung", "Keine Berechtigung für die manuSensor-App.")
        return user

    @classmethod
    def check_app_user(cls, request):
        """Signed in with the app's permission (staff always)."""
        return cls.check_user(request, lambda user: has_module_permissions(user, PERMISSION))

    def location_of(self, request, projekt):
        """The user's location with project number `projekt` (as the portal
        finds it - every account of the user, staff any), else 404."""
        from progeo.v1.viewsets.locations_viewset import LocationViewSet

        self.check_app_user(request)
        project_id = manusensor.parse_project(projekt)
        location = None
        if project_id is not None:
            location, _account = LocationViewSet._find_location(request, project_id=project_id)
        if location is None:
            raise ManuSensorError(404, "projekt_unbekannt", f"Projekt {projekt} nicht gefunden.")
        return project_id, location


class ManuSensorSensorView(_ManuSensorView):
    """The factory values of a sensor: by its number or its tag (B2: does it
    belong to the project? R_Werk to show). With neither: every factory
    sensor of the project with its newest site measurement (the app's list)."""

    def get(self, request, projekt, sensor=None):
        try:
            project_id, _location = self.location_of(request, projekt)
            if sensor is not None:
                number = manusensor.normalize_sensor(sensor)
                factory = manusensor.find_factory_sensor(project_id, sensor=number) if number else None
            elif "tag_uid" in request.query_params:
                tag_uid = manusensor.normalize_tag_uid(request.query_params.get("tag_uid"))
                if tag_uid is None:
                    raise manusensor.invalid("tag_uid", "Tag-UID muss Hex sein (8-20 Zeichen).")
                factory = manusensor.find_factory_sensor(project_id, tag_uid=tag_uid)
            else:
                return Response(manusensor.project_sensors(project_id))
            if factory is None:
                raise ManuSensorError(404, "sensor_unbekannt", "Sensor nicht im Projekt")
        except ManuSensorError as error:
            return _error(error)
        return Response(manusensor.sensor_info(factory))


class ManuSensorMeasurementsView(_ManuSensorView):
    """A site measurement: 201 stored, 200 the same one again (same answer),
    409 its mess_id with other content, 422 invalid."""

    def post(self, request, projekt):
        try:
            project_id, location = self.location_of(request, projekt)
            measurement, created = manusensor.record_measurement(request.data, project_id, location, request.user)
        except ManuSensorError as error:
            return _error(error)
        return Response(manusensor.answer(measurement), status=201 if created else 200)


class ManuSensorProjectsView(_ManuSensorView):
    """The app's project picker: every project with factory sensors whose
    location the user may open (found as location_of finds it) - its number,
    the location's name, its sensors and how many of them were measured on
    site."""

    def get(self, request):
        from progeo.v1.viewsets.locations_viewset import LocationViewSet

        try:
            self.check_app_user(request)
        except ManuSensorError as error:
            return _error(error)
        counts = manusensor.project_counts()
        locations = LocationViewSet._find_project_locations(request, counts)
        return Response({"projekte": [
            {"projekt": str(project_id), "name": locations[project_id].name or None,
             "sensoren": sensors, "gemessen": measured}
            for project_id, (sensors, measured) in counts.items() if project_id in locations
        ]})


def _staff(user):
    return user.is_staff or user.is_superuser


def _factory(user):
    """docs/fertigung.md 1a: staff, superuser or group "Werk" (helper/werk_users.py)."""
    from progeo.helper.werk_users import is_factory_user

    return is_factory_user(user)


class FactorySensorsView(_ManuSensorView):
    """POST - the factory app: {"sensoren": [{projekt, sensor, band, tag_uid,
    r_werk_ohm, gemessen_am}]} - created or updated, all or none.
    GET - the staff page (/staff/sensors/): the sensors with their newest site
    measurement, the measurements without factory values, the counts
    (?projekt= only that project)."""

    def get(self, request):
        try:
            # The app's users have its permission, not a factory account:
            # tell them what the page needs instead of "no permission for the app".
            user = self.check_user(request, lambda u: _factory(u) or has_module_permissions(u, PERMISSION))
            if not _factory(user):
                raise ManuSensorError(403, "nur_mitarbeiter", "Nur für ProGeo-Mitarbeiter (Seite /staff/sensors/).")
            project = request.query_params.get("projekt")
            project_id = manusensor.parse_project(project) if project else None
            if project and project_id is None:
                raise manusensor.invalid("projekt", "Projektnummer ist keine Zahl.")
            return Response(manusensor.staff_overview(project_id))
        except ManuSensorError as error:
            return _error(error)

    def post(self, request):
        try:
            user = self.check_user(request, _factory)
            data = request.data if isinstance(request.data, dict) else {}
            result = manusensor.store_factory_sensors(data.get("sensoren"), user=user)
        except ManuSensorError as error:
            return _error(error)
        return Response(result)


class DmOrdersView(_ManuSensorView):
    """The dm production orders ("PA: dm" in Airtable, helper/dm_orders.py) -
    factory accounts. ?status= "zu Produzieren" (default), "Produziert", "alle"."""

    def get(self, request):
        try:
            self.check_user(request, _factory)
            return Response(production.augment_list(
                dm_orders.orders(dm_orders.parse_status(request.query_params.get("status")))))
        except ManuSensorError as error:
            return _error(error)


class DmOrderView(_ManuSensorView):
    """One dm production order (its ID or Airtable record id) with its sensors."""

    def get(self, request, auftrag):
        try:
            self.check_user(request, _factory)
            return Response(dm_orders.order_detail(auftrag))
        except ManuSensorError as error:
            return _error(error)


class DmSensorProjectsView(_ManuSensorView):
    """The staff page's Airtable import: the projects with production orders
    in Airtable (helper/airtable_dm_sensors.py)."""

    def get(self, request):
        try:
            self.check_user(request, _staff)
            return Response(airtable_dm_sensors.projects())
        except ManuSensorError as error:
            return _error(error)


class DmSensorImportView(_ManuSensorView):
    """GET - what importing the "dm Sensoren" rows of the project would do;
    POST - import them (reads Airtable again, all or none)."""

    def _project(self, projekt):
        project_id = manusensor.parse_project(projekt)
        if not project_id:
            raise manusensor.invalid("projekt", "Projektnummer ist keine Zahl.")
        return project_id

    def get(self, request, projekt):
        try:
            self.check_user(request, _staff)
            return Response(airtable_dm_sensors.preview(self._project(projekt)))
        except ManuSensorError as error:
            return _error(error)

    def post(self, request, projekt):
        try:
            user = self.check_user(request, _staff)
            return Response(airtable_dm_sensors.import_project(self._project(projekt), user=user))
        except ManuSensorError as error:
            return _error(error)


class FactorySensorMeasurementsView(_ManuSensorView):
    """The staff page: the site measurements of one factory sensor."""

    def get(self, request, pk):
        try:
            self.check_user(request, _factory)
            return Response(manusensor.sensor_history(pk))
        except ManuSensorError as error:
            return _error(error)
