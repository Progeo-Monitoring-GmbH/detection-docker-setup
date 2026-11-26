from debug_toolbar.panels.history import HistoryPanel as ToolbarHistoryPanel
from django.conf import settings


def show_toolbar(request):
    if request.path.endswith("all/qrcodes/"):
        return False
    return settings.DEBUG


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
