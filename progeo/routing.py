from channels.auth import AuthMiddlewareStack
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.security.websocket import AllowedHostsOriginValidator
from django.core.asgi import get_asgi_application
from django.urls import re_path

from progeo.consumer import (
    CadImportJobConsumer,
    CommandConsumer,
    LocationStatusConsumer,
    LogStreamConsumer,
    QaScoreboardConsumer,
)
from progeo.metrics import track_websocket

ws_pattern = [
    re_path(r'^ws/commands/list$', track_websocket("commands", CommandConsumer.as_asgi())),
    re_path(r'^ws/dev/$', track_websocket("dev", CommandConsumer.as_asgi())),
    re_path(r'^ws/logs/stream/$', track_websocket("logs", LogStreamConsumer.as_asgi())),
    re_path(r'^ws/cad_import/(?P<job_id>[0-9a-f]{32})/$', track_websocket("cad_import", CadImportJobConsumer.as_asgi())),
    # The readiness scoreboard's point changes (staff).
    re_path(r'^ws/qa/$', track_websocket("qa", QaScoreboardConsumer.as_asgi())),
    # New data (alarm=1 samples) of one location for its open status pages.
    re_path(r'^ws/location/(?P<location_id>\d+)/status/$',
            track_websocket("location_status", LocationStatusConsumer.as_asgi())),
]

application = ProtocolTypeRouter({
    "http": get_asgi_application(),

    "websocket": AllowedHostsOriginValidator(
        AuthMiddlewareStack(
            URLRouter(ws_pattern),
        ),
    ),
})
