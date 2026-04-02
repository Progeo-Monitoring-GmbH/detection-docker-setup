from channels.auth import AuthMiddlewareStack
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.security.websocket import AllowedHostsOriginValidator
from django.core.asgi import get_asgi_application
from django.urls import re_path

from progeo.consumer import CommandConsumer

ws_pattern = [
    re_path(r'^ws/commands/list$', CommandConsumer.as_asgi()),
    re_path(r'^ws/dev/$', CommandConsumer.as_asgi()),
]

application = ProtocolTypeRouter({
    "http": get_asgi_application(),

    "websocket": AllowedHostsOriginValidator(
        AuthMiddlewareStack(
            URLRouter(ws_pattern),
        ),
    ),
})
