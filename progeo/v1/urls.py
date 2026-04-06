from django.urls import include, re_path

from progeo.v1.viewsets.backup_viewset import BackupViewSet
from progeo.v1.viewsets.setup_viewset import SetupViewSet, AccountViewSet, DeviceViewSet, StatusViewSet
from progeo.routers import CustomRouter

progeo_router = CustomRouter()
progeo_router.register(r'account', AccountViewSet, basename='account')
progeo_router.register(r'setup', SetupViewSet, basename='setup')
progeo_router.register(r'backup', BackupViewSet, basename='backup')

device_router = CustomRouter()
device_router.register(r'', DeviceViewSet, basename='device')

status_router = CustomRouter()
status_router.register(r'', StatusViewSet, basename='status')

urlpatterns = [
    re_path(r'^(?P<account_id>\d+)/', include(progeo_router.urls)),
    re_path(r'^device/(?P<device_hash>[a-zA-Z0-9]+)/', include(device_router.urls)),
    re_path(r'^status/', include(status_router.urls)),
]
