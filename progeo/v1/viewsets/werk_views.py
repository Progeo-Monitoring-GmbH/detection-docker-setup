"""The digital production record dm (docs/fertigung.md): the manuSensor app's
Produktion area. Factory accounts only (staff, superuser or group "Werk" -
helper/werk_users.py); errors as {"fehler", "meldung"[, "feld"]}.

- GET  /v1/werk/ich/
- PUT|GET /v1/werk/auftraege/<auftrag>/eintraege/
- POST /v1/werk/auftraege/<auftrag>/blaetter/<blatt>/freigabe/
- POST /v1/werk/auftraege/<auftrag>/fortschritt/
- GET|POST /v1/werk/rollen/, PATCH /v1/werk/rollen/<nummer>/,
  GET /v1/werk/rollen/suche/?code=, POST /v1/werk/rollen/<nummer>/foto/,
  GET /v1/werk/rollen/fotos/<foto_id>/
- POST /v1/werk/benutzer/sync/   (staff) the accounts from Airtable "Ressourcen"
"""

from django.http import FileResponse
from rest_framework.response import Response

from progeo.helper import production, rolls, werk_users
from progeo.helper.manusensor import ManuSensorError
from progeo.v1.viewsets.manusensor_views import _error, _factory, _ManuSensorView


def _body(request):
    return request.data if isinstance(request.data, dict) else None


class _WerkView(_ManuSensorView):
    def factory_user(self, request):
        return self.check_user(request, _factory)


class WerkMeView(_WerkView):
    """403 for every other account - the app shows Produktion only for factory accounts."""

    def get(self, request):
        try:
            user = self.factory_user(request)
        except ManuSensorError as error:
            return _error(error)
        return Response(werk_users.me(user))


class ProductionEntriesView(_WerkView):
    def get(self, request, auftrag):
        try:
            self.factory_user(request)
            return Response(production.entries(auftrag))
        except ManuSensorError as error:
            return _error(error)

    def put(self, request, auftrag):
        try:
            self.factory_user(request)
            return Response(production.save_entries(auftrag, _body(request)))
        except ManuSensorError as error:
            return _error(error)


class ProductionSheetReleaseView(_WerkView):
    def post(self, request, auftrag, blatt):
        try:
            self.factory_user(request)
            return Response(production.release_sheet(auftrag, int(blatt), _body(request)))
        except ManuSensorError as error:
            return _error(error)


class ProductionProgressView(_WerkView):
    def post(self, request, auftrag):
        try:
            self.factory_user(request)
            return Response(production.report_progress(auftrag, _body(request)))
        except ManuSensorError as error:
            return _error(error)


class RollsView(_WerkView):
    def get(self, request):
        try:
            self.factory_user(request)
            return Response(rolls.roll_list(request.query_params.get("typ"), request.query_params.get("leer")))
        except ManuSensorError as error:
            return _error(error)

    def post(self, request):
        try:
            user = self.factory_user(request)
            return Response(rolls.create(_body(request), user), status=201)
        except ManuSensorError as error:
            return _error(error)


class RollView(_WerkView):
    def get(self, request, nummer):
        try:
            self.factory_user(request)
            return Response(rolls.roll_json(rolls.get_roll(nummer)))
        except ManuSensorError as error:
            return _error(error)

    def patch(self, request, nummer):
        try:
            self.factory_user(request)
            return Response(rolls.patch(nummer, _body(request)))
        except ManuSensorError as error:
            return _error(error)


class RollSearchView(_WerkView):
    def get(self, request):
        try:
            self.factory_user(request)
            return Response(rolls.find_by_code(request.query_params.get("code")))
        except ManuSensorError as error:
            return _error(error)


class RollPhotoUploadView(_WerkView):
    def post(self, request, nummer):
        try:
            user = self.factory_user(request)
            return Response(rolls.add_photo(nummer, _body(request), user))
        except ManuSensorError as error:
            return _error(error)


class RollPhotoView(_WerkView):
    def get(self, request, foto_id):
        try:
            self.factory_user(request)
            path, mime = rolls.photo_file(foto_id)
        except ManuSensorError as error:
            return _error(error)
        return FileResponse(open(path, "rb"), content_type=mime)


class WerkUsersSyncView(_WerkView):
    """The staff page's button: `manage.py sync_werk_users` in celery."""

    def post(self, request):
        try:
            self.check_user(request, lambda user: user.is_staff or user.is_superuser)
        except ManuSensorError as error:
            return _error(error)
        from progeo.tasks import sync_werk_users

        sync_werk_users.delay()
        return Response({"ok": True}, status=202)
