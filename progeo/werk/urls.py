"""The routes of the Werk app, under /v1/werk/ (progeo/v1/urls.py).

- baustelle/<projekt>/...   the manuSensor app on site (werk/manusensor.py):
                            the factory values of the project's sensors, site
                            measurements. <projekt> is the project number, not
                            a pk; POST .../messungen comes without the slash.
- projekte/, sensoren/...   the app's project picker, the factory values
                            (factory app, staff page /staff/sensors/) and the
                            import of the Airtable table "dm Sensoren"
- auftraege/..., ich/, benutzer/sync/, rollen/...
                            the digital production record (docs/fertigung.md)
- produktion/...            the staff page /staff/production/

Until 26.11.2026 the site routes were /v1/location/<projekt>/sensor/ and
/v1/location/<projekt>/messungen - removed, not redirected.
"""

from django.urls import re_path

from progeo.werk.manusensor_views import (
    DmOrdersView,
    DmOrderView,
    DmSensorImportView,
    DmSensorProjectsView,
    FactorySensorMeasurementsView,
    FactorySensorsView,
    ManuSensorMeasurementsView,
    ManuSensorProjectsView,
    ManuSensorSensorView,
)
from progeo.werk.views import (
    ProductionEntriesView,
    ProductionOverviewView,
    ProductionProgressView,
    ProductionQsView,
    ProductionSheetReleaseView,
    RollPhotoUploadView,
    RollPhotoView,
    RollSearchView,
    RollsView,
    RollView,
    WerkMeView,
    WerkUsersSyncView,
)

PROJECT = r'(?P<projekt>[A-Za-z0-9-]{1,12})'
ORDER = r'(?P<auftrag>[^/]{1,100})'

urlpatterns = [
    # The manuSensor app on site.
    re_path(rf'^baustelle/{PROJECT}/sensor/(?:(?P<sensor>[0-9]{{1,6}})/?)?$', ManuSensorSensorView.as_view()),
    re_path(rf'^baustelle/{PROJECT}/messungen/?$', ManuSensorMeasurementsView.as_view()),
    # The app's project picker: the projects with factory sensors.
    re_path(r'^projekte/?$', ManuSensorProjectsView.as_view()),
    # The factory values; the staff page (/staff/sensors/): the site measurements of a factory sensor.
    re_path(r'^sensoren/?$', FactorySensorsView.as_view()),
    re_path(r'^sensoren/(?P<pk>\d+)/messungen/?$', FactorySensorMeasurementsView.as_view()),
    # ... and the import of the Airtable table "dm Sensoren" (per project).
    re_path(r'^sensoren/airtable/?$', DmSensorProjectsView.as_view()),
    re_path(r'^sensoren/airtable/(?P<projekt>[0-9]{1,9})/?$', DmSensorImportView.as_view()),
    # The dm production orders ("PA: dm" in Airtable, werk/dm_orders.py).
    re_path(r'^auftraege/?$', DmOrdersView.as_view()),
    re_path(rf'^auftraege/{ORDER}/?$', DmOrderView.as_view()),
    # The digital production record (docs/fertigung.md, werk/views.py).
    re_path(r'^ich/?$', WerkMeView.as_view()),
    re_path(r'^benutzer/sync/?$', WerkUsersSyncView.as_view()),
    re_path(rf'^auftraege/{ORDER}/eintraege/?$', ProductionEntriesView.as_view()),
    re_path(rf'^auftraege/{ORDER}/blaetter/(?P<blatt>[0-9]{{1,5}})/freigabe/?$', ProductionSheetReleaseView.as_view()),
    re_path(rf'^auftraege/{ORDER}/fortschritt/?$', ProductionProgressView.as_view()),
    re_path(r'^rollen/?$', RollsView.as_view()),
    re_path(r'^rollen/suche/?$', RollSearchView.as_view()),
    re_path(r'^rollen/fotos/(?P<foto_id>[0-9a-fA-F-]{36})/?$', RollPhotoView.as_view()),
    re_path(r'^rollen/(?P<nummer>[^/]{1,32})/foto/?$', RollPhotoUploadView.as_view()),
    re_path(r'^rollen/(?P<nummer>[^/]{1,32})/?$', RollView.as_view()),
    # The staff page /staff/production/ (werk/production_overview.py).
    re_path(r'^produktion/?$', ProductionOverviewView.as_view()),
    re_path(r'^produktion/qs/?$', ProductionQsView.as_view()),
]
