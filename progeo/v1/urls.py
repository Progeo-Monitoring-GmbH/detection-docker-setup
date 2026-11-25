from django.urls import include, re_path

from progeo.routers import CustomRouter
from progeo.v1.viewsets.activity_viewset import ActivityViewSet
from progeo.v1.viewsets.alarm_report_viewset import AlarmReportViewSet
from progeo.v1.viewsets.alarm_viewset import AlarmViewSet
from progeo.v1.viewsets.backup_viewset import BackupViewSet
from progeo.v1.viewsets.data_transfer_viewset import DataTransferViewSet
from progeo.v1.viewsets.database_usage_viewset import DatabaseUsageViewSet
from progeo.v1.viewsets.demo_viewset import DemoViewSet
from progeo.v1.viewsets.device_viewset import DeviceViewSet
from progeo.v1.viewsets.e2e_viewset import E2EInfoView, E2ENotificationLinkView
from progeo.v1.viewsets.escalation_viewset import EscalationViewSet
from progeo.v1.viewsets.favorite_viewset import FavoriteViewSet
from progeo.v1.viewsets.firmware_viewset import (
    FirmwareBundleUploadView,
    FirmwareChannelUploadView,
)
from progeo.v1.viewsets.interface_viewset import InterfaceViewSet
from progeo.v1.viewsets.location_selection_viewset import LocationSelectionViewSet
from progeo.v1.viewsets.locations_viewset import LocationViewSet
from progeo.v1.viewsets.manusensor_views import (
    DmSensorImportView,
    DmSensorProjectsView,
    FactorySensorMeasurementsView,
    FactorySensorsView,
    ManuSensorMeasurementsView,
    ManuSensorProjectsView,
    ManuSensorSensorView,
)
from progeo.v1.viewsets.notification_viewset import (
    NotificationCaseViewSet,
    NotificationLocationViewSet,
)
from progeo.v1.viewsets.qa_viewset import QAViewSet
from progeo.v1.viewsets.screen_review_viewset import ScreenReviewViewSet
from progeo.v1.viewsets.setup_viewset import AccountViewSet, SetupViewSet
from progeo.v1.viewsets.status_viewset import StatusViewSet
from progeo.v1.viewsets.threshold_fine_tune_viewset import ThresholdFineTuneViewSet
from progeo.v1.viewsets.user_profile_viewset import UserProfileViewSet

progeo_router = CustomRouter()
progeo_router.register(r'account', AccountViewSet, basename='account')
progeo_router.register(r'setup', SetupViewSet, basename='setup')
progeo_router.register(r'backup', BackupViewSet, basename='backup')

device_router = CustomRouter()
device_router.register(r'', DeviceViewSet, basename='device')

location_router = CustomRouter()
location_router.register(r'', LocationViewSet, basename='location')

status_router = CustomRouter()
status_router.register(r'', StatusViewSet, basename='status')

user_router = CustomRouter()
user_router.register(r'', UserProfileViewSet, basename='user')

alarm_router = CustomRouter()
alarm_router.register(r'', AlarmViewSet, basename='alarm')

alarm_report_router = CustomRouter()
alarm_report_router.register(r'', AlarmReportViewSet, basename='alarm-report')

interface_router = CustomRouter()
interface_router.register(r'', InterfaceViewSet, basename='interface')

data_router = CustomRouter()
data_router.register(r'', DataTransferViewSet, basename='data')

demo_router = CustomRouter()
demo_router.register(r'', DemoViewSet, basename='demo')

escalation_router = CustomRouter()
escalation_router.register(r'', EscalationViewSet, basename='escalation')

favorite_router = CustomRouter()
favorite_router.register(r'', FavoriteViewSet, basename='favorite')

activity_router = CustomRouter()
activity_router.register(r'', ActivityViewSet, basename='activity')

notification_case_router = CustomRouter()
notification_case_router.register(r'', NotificationCaseViewSet, basename='notification-case')

notification_location_router = CustomRouter()
notification_location_router.register(r'', NotificationLocationViewSet, basename='notification-location')

database_usage_router = CustomRouter()
database_usage_router.register(r'', DatabaseUsageViewSet, basename='database-usage')

qa_router = CustomRouter()
qa_router.register(r'', QAViewSet, basename='qa')

location_selection_router = CustomRouter()
location_selection_router.register(r'', LocationSelectionViewSet, basename='location-selection')

screen_review_router = CustomRouter()
screen_review_router.register(r'', ScreenReviewViewSet, basename='screen-review')

threshold_fine_tune_router = CustomRouter()
threshold_fine_tune_router.register(r'', ThresholdFineTuneViewSet, basename='threshold-fine-tune')

urlpatterns = [
    re_path(r'^(?P<account_id>\d+)/', include(progeo_router.urls)),
    re_path(r'^device/', include(device_router.urls)),
    # manuSensor app (helper/manusensor.py) - before the location routes:
    # <projekt> is the project number, not a pk; POST .../messungen comes
    # without the trailing slash.
    re_path(r'^location/(?P<projekt>[A-Za-z0-9-]{1,12})/sensor/(?:(?P<sensor>[0-9]{1,6})/?)?$',
            ManuSensorSensorView.as_view()),
    re_path(r'^location/(?P<projekt>[A-Za-z0-9-]{1,12})/messungen/?$', ManuSensorMeasurementsView.as_view()),
    # The app's project picker: the projects with factory sensors.
    re_path(r'^werk/projekte/?$', ManuSensorProjectsView.as_view()),
    re_path(r'^werk/sensoren/?$', FactorySensorsView.as_view()),
    # The staff page (/staff/sensors/): the site measurements of a factory sensor.
    re_path(r'^werk/sensoren/(?P<pk>\d+)/messungen/?$', FactorySensorMeasurementsView.as_view()),
    # ... and the import of the Airtable table "dm Sensoren" (per project).
    re_path(r'^werk/sensoren/airtable/?$', DmSensorProjectsView.as_view()),
    re_path(r'^werk/sensoren/airtable/(?P<projekt>[0-9]{1,9})/?$', DmSensorImportView.as_view()),
    re_path(r'^location/', include(location_router.urls)),
    re_path(r'^status/', include(status_router.urls)),
    re_path(r'^user/', include(user_router.urls)),
    re_path(r'^alarm/', include(alarm_router.urls)),
    re_path(r'^alarm-report/', include(alarm_report_router.urls)),
    re_path(r'^interface/', include(interface_router.urls)),
    re_path(r'^data/', include(data_router.urls)),
    re_path(r'^demo/', include(demo_router.urls)),
    re_path(r'^escalation/', include(escalation_router.urls)),
    re_path(r'^favorite/', include(favorite_router.urls)),
    re_path(r'^activity/', include(activity_router.urls)),
    re_path(r'^qa/', include(qa_router.urls)),
    re_path(r'^screen-review/', include(screen_review_router.urls)),
    re_path(r'^location-selection/', include(location_selection_router.urls)),
    re_path(r'^database-usage/', include(database_usage_router.urls)),
    re_path(r'^threshold-fine-tune/', include(threshold_fine_tune_router.urls)),
    re_path(r'^notification-case/', include(notification_case_router.urls)),
    re_path(r'^notification-location/', include(notification_location_router.urls)),
    # Flash bundle uploads (release.sh); nginx serves them at /firmware/.
    re_path(r'^firmware/bundles/$', FirmwareBundleUploadView.as_view(), name='firmware_bundle_upload'),
    re_path(r'^firmware/channels/(?P<channel>[^/]+)/$', FirmwareChannelUploadView.as_view(), name='firmware_channel_upload'),
    # UI tests on staging (helper/e2e.py) - 404 unless E2E_DEMO_PASSWORD is set.
    re_path(r'^e2e/info/$', E2EInfoView.as_view(), name='e2e_info'),
    re_path(r'^e2e/notification-link/$', E2ENotificationLinkView.as_view(), name='e2e_notification_link'),
]
