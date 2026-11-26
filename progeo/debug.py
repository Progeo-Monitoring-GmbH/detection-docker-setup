from debug_toolbar.panels.history import HistoryPanel as ToolbarHistoryPanel
from django.conf import settings


def show_toolbar(request):
    """Only with DEBUG (local machines only, settings.py) and only for a client
    on this machine or its private network: the toolbar shows SQL, headers,
    cookies and the requests of others (its history) - 2026-11-26 leak."""
    from progeo.security import client_is_local

    if request.path.endswith("all/qrcodes/"):
        return False
    return bool(settings.DEBUG) and client_is_local(request)


def hide_toolbar(request):
    """The test settings' callback: the toolbar is never shown."""
    return False


class HistoryPanel(ToolbarHistoryPanel):
    """The toolbar's history panel (DEBUG_TOOLBAR_PANELS), without the 500 it
    caused: on a request without GET/POST data it reads request.body, and
    under ASGI (daphne) that stream can be closed already - "ValueError: I/O
    operation on closed file" (seen on /ui). It only catches
    RawPostDataException. Such a request is left out of the history.
    Keeps the name HistoryPanel: the toolbar finds the panel by it."""

    def generate_stats(self, request, response):
        try:
            super().generate_stats(request, response)
        except ValueError:
            pass
