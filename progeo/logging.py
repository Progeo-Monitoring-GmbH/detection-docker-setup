import logging
from urllib.parse import urlsplit, parse_qsl, urlencode, urlunsplit

SENSITIVE_PARAMS = {
    "token",
}

class SanitizeURLFilter(logging.Filter):
    def filter(self, record):
        record.cleaned_path = "-"

        if hasattr(record, "request"):
            request = record.request

            get_full_path = getattr(request, "get_full_path", None)
            if callable(get_full_path):
                parts = urlsplit(get_full_path())
                query = parse_qsl(parts.query, keep_blank_values=True)

                cleaned = [
                    (k, "***" if k.lower() in SENSITIVE_PARAMS else v)
                    for k, v in query
                ]

                cleaned_path = urlunsplit((
                    "",
                    "",
                    parts.path,
                    urlencode(cleaned),
                    ""
                ))
                request.cleaned_path = cleaned_path
                record.cleaned_path = cleaned_path

        return True