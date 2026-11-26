"""The debug toolbar's history panel (progeo/debug.py HistoryPanel): a
request whose body stream is already closed (ASGI) is no 500."""

import io
from types import SimpleNamespace

from django.http import HttpResponse
from django.test import RequestFactory

from progeo.debug import HistoryPanel


def _closed_body_request():
    request = RequestFactory().get("/ui")
    stream = io.BytesIO(b"")
    stream.close()
    request._stream = stream
    return request


def test_history_panel_skips_a_request_whose_body_is_closed():
    panel = HistoryPanel(SimpleNamespace(stats={}, server_timing_stats={}), lambda request: HttpResponse())

    # The toolbar's own panel raised "ValueError: I/O operation on closed file".
    panel.generate_stats(_closed_body_request(), HttpResponse(status=404))

    assert panel.get_stats() == {}
