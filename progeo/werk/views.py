"""The digital production record dm (docs/fertigung.md): the manuSensor app's
Produktion area. Factory accounts only (staff, superuser or group "Werk" -
werk/werk_users.py); errors as {"fehler", "meldung"[, "feld"]}.

- GET  /v1/werk/ich/
- PUT|GET /v1/werk/auftraege/<auftrag>/eintraege/
- POST /v1/werk/auftraege/<auftrag>/blaetter/<blatt>/freigabe/
- POST /v1/werk/auftraege/<auftrag>/fortschritt/
- GET|POST /v1/werk/rollen/, PATCH /v1/werk/rollen/<nummer>/,
  GET /v1/werk/rollen/suche/?code=, POST /v1/werk/rollen/<nummer>/foto/,
  GET /v1/werk/rollen/fotos/<foto_id>/
- POST /v1/werk/benutzer/sync/   (staff) the accounts from Airtable "Ressourcen"
- GET  /v1/werk/produktion/      (staff) the overview of the staff page /staff/production/
- POST /v1/werk/produktion/qs/   (staff) the QS check of produced sensors
"""

from django.http import FileResponse
from rest_framework.response import Response

from progeo.werk import production, production_overview, rolls, werk_users
from progeo.werk.manusensor_views import _factory, _ManuSensorView, _staff


def _body(request):
    return request.data if isinstance(request.data, dict) else None


class _WerkView(_ManuSensorView):
    """Errors (ManuSensorError) become answers in _ManuSensorView.handle_exception."""

    def factory_user(self, request):
        return self.check_user(request, _factory)


class WerkMeView(_WerkView):
    """403 for every other account - the app shows Produktion only for factory accounts."""

    def get(self, request):
        return Response(werk_users.me(self.factory_user(request)))


class ProductionEntriesView(_WerkView):
    def get(self, request, auftrag):
        self.factory_user(request)
        return Response(production.entries(auftrag))

    def put(self, request, auftrag):
        self.factory_user(request)
        return Response(production.save_entries(auftrag, _body(request)))


class ProductionSheetReleaseView(_WerkView):
    def post(self, request, auftrag, blatt):
        self.factory_user(request)
        return Response(production.release_sheet(auftrag, int(blatt), _body(request)))


class ProductionProgressView(_WerkView):
    def post(self, request, auftrag):
        self.factory_user(request)
        return Response(production.report_progress(auftrag, _body(request)))


class RollsView(_WerkView):
    def get(self, request):
        self.factory_user(request)
        return Response(rolls.roll_list(request.query_params.get("typ"), request.query_params.get("leer")))

    def post(self, request):
        user = self.factory_user(request)
        return Response(rolls.create(_body(request), user), status=201)


class RollView(_WerkView):
    def get(self, request, nummer):
        self.factory_user(request)
        return Response(rolls.roll_json(rolls.get_roll(nummer)))

    def patch(self, request, nummer):
        self.factory_user(request)
        return Response(rolls.patch(nummer, _body(request)))


class RollSearchView(_WerkView):
    def get(self, request):
        self.factory_user(request)
        return Response(rolls.find_by_code(request.query_params.get("code")))


class RollPhotoUploadView(_WerkView):
    def post(self, request, nummer):
        user = self.factory_user(request)
        return Response(rolls.add_photo(nummer, _body(request), user))


class RollPhotoView(_WerkView):
    def get(self, request, foto_id):
        self.factory_user(request)
        path, mime = rolls.photo_file(foto_id)
        return FileResponse(open(path, "rb"), content_type=mime)


class WerkUsersSyncView(_WerkView):
    """The staff page's button: `manage.py sync_werk_users` in celery."""

    def post(self, request):
        from progeo.werk.tasks import sync_werk_users

        self.check_user(request, _staff)
        sync_werk_users.delay()
        return Response({"ok": True}, status=202)


class ProductionOverviewView(_WerkView):
    """The staff page /staff/production/ (werk/production_overview.py)."""

    def get(self, request):
        self.check_user(request, _staff)
        return Response(production_overview.overview(request.query_params))


class ProductionQsView(_WerkView):
    def post(self, request):
        user = self.check_user(request, _staff)
        return Response(production_overview.decide(_body(request), user))
