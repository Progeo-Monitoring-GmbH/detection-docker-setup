"""The manuSensor app's endpoints (helper/manusensor.py, SPEC.md section 5 of
progeo-manusensor). Every error is {"fehler", "meldung"[, "feld"]}, as the
app reads it - not the {"success", "reason"} of the other views.

- GET  /v1/location/<projekt>/sensor/<sensor>/   (or .../sensor/?tag_uid=)
- POST /v1/location/<projekt>/messungen
  module_manusensor_enabled and access to the location of the project number.
- POST /v1/werk/sensoren/   the factory values (factory app) - factory accounts.
- GET  /v1/werk/auftraege/[<ID>/]   the dm production orders from Airtable
  (helper/dm_orders.py) - factory accounts.
"""

from rest_framework.authentication import SessionAuthentication
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.decorator import has_module_permissions
from progeo.helper import dm_orders, manusensor
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

    def location_of(self, request, projekt):
        """The user's location with project number `projekt` (as the portal
        finds it - every account of the user, staff any), else 404."""
        from progeo.v1.viewsets.locations_viewset import LocationViewSet

        self.check_user(request, lambda user: has_module_permissions(user, PERMISSION))
        project_id = manusensor.parse_project(projekt)
        location = None
        if project_id is not None:
            location, _account = LocationViewSet._find_location(request, project_id=project_id)
        if location is None:
            raise ManuSensorError(404, "projekt_unbekannt", f"Projekt {projekt} nicht gefunden.")
        return project_id, location


class ManuSensorSensorView(_ManuSensorView):
    """The factory values of a sensor: by its number or its tag (B2: does it
    belong to the project? R_Werk to show)."""

    def get(self, request, projekt, sensor=None):
        try:
            project_id, _location = self.location_of(request, projekt)
            if sensor is not None:
                number = manusensor.normalize_sensor(sensor)
                factory = manusensor.find_factory_sensor(project_id, sensor=number) if number else None
            else:
                tag_uid = manusensor.normalize_tag_uid(request.query_params.get("tag_uid"))
                if tag_uid is None:
                    raise manusensor.invalid("tag_uid", "Sensornummer im Pfad oder ?tag_uid= angeben.")
                factory = manusensor.find_factory_sensor(project_id, tag_uid=tag_uid)
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


def _factory(user):
    """SPEC 1a: staff, superuser or group "Werk" (helper/werk_users.py)."""
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
            self.check_user(request, _factory)
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
            return Response(dm_orders.orders(dm_orders.parse_status(request.query_params.get("status"))))
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


class FactorySensorMeasurementsView(_ManuSensorView):
    """The staff page: the site measurements of one factory sensor."""

    def get(self, request, pk):
        try:
            self.check_user(request, _factory)
            return Response(manusensor.sensor_history(pk))
        except ManuSensorError as error:
            return _error(error)
