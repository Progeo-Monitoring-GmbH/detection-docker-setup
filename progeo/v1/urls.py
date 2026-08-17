from django.urls import include, re_path

from progeo.v1.viewsets.alarm_viewset import AlarmViewSet
from progeo.v1.viewsets.backup_viewset import BackupViewSet
from progeo.v1.viewsets.device_viewset import DeviceViewSet
from progeo.v1.viewsets.locations_viewset import LocationViewSet
from progeo.v1.viewsets.setup_viewset import SetupViewSet, AccountViewSet
from progeo.v1.viewsets.status_viewset import StatusViewSet
from progeo.v1.viewsets.user_profile_viewset import UserProfileViewSet
from progeo.routers import CustomRouter

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

urlpatterns = [
    re_path(r'^(?P<account_id>\d+)/', include(progeo_router.urls)),
    re_path(r'^device/', include(device_router.urls)),
    re_path(r'^location/', include(location_router.urls)),
    re_path(r'^status/', include(status_router.urls)),
    re_path(r'^user/', include(user_router.urls)),
    re_path(r'^alarm/', include(alarm_router.urls)),
    
]
