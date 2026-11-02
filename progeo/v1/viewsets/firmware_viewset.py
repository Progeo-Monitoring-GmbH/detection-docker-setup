"""Upload API of the flash bundles for the field app (STRATEGY.md section 4),
called by release.sh / promote.sh. nginx serves the stored files publicly at
/firmware/ (helper/firmware.py has the layout and the checks).

  POST bundles/              multipart: bundle (zip), sig, optional sha256
  POST channels/<channel>/   multipart: channel (json), sig

Each part may be a file (curl -F sig=@x.sig) or a plain field. No user login:
"Authorization: Bearer <FIRMWARE_UPLOAD_TOKEN>"; 404 while the token is empty.
"""
import hmac

from django.conf import settings
from rest_framework.exceptions import AuthenticationFailed, NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from progeo.helper import firmware
from progeo.helper.basics import RequestFailed, RequestSuccess, ilog


class _FirmwareUploadView(APIView):
    authentication_classes = []
    permission_classes = []

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        token = settings.FIRMWARE_UPLOAD_TOKEN
        if not token:
            raise NotFound()
        supplied = request.headers.get("Authorization", "").removeprefix("Bearer ")
        if not hmac.compare_digest(supplied.encode(), token.encode()):
            raise AuthenticationFailed("Invalid firmware upload token")

    def get_authenticate_header(self, request):
        return 'Bearer realm="firmware"'  # makes AuthenticationFailed a 401, not a 403

    def handle_exception(self, exc):
        if isinstance(exc, firmware.FirmwareError):
            return Response({"success": False, "reason": exc.reason}, status=exc.status)
        return super().handle_exception(exc)


def _part(request, name, limit):
    """A multipart part as bytes, at most `limit` + 1 (the size checks see
    "too large"); b"" if it is missing."""
    upload = request.FILES.get(name)
    if upload is not None:
        return upload.read(limit + 1)
    value = request.data.get(name)
    return value.encode()[:limit + 1] if isinstance(value, str) else b""


class FirmwareBundleUploadView(_FirmwareUploadView):
    def post(self, request, *args, **kwargs):
        upload = request.FILES.get("bundle")
        if upload is None:
            return RequestFailed({"reason": "Missing file 'bundle'"})
        # Either the hex digest or a whole sha256sum line ("<hex>  <name>").
        expected = _part(request, "sha256", 256).split()[:1]
        result = firmware.store_bundle(
            upload,
            _part(request, "sig", firmware.MAX_SIGNATURE_SIZE),
            expected[0].decode(errors="replace") if expected else "",
        )
        ilog(f"bundle {result['name']} {'stored' if result['created'] else 'was stored already'}"
             f" ({result['size']} bytes, sha256 {result['sha256']})", tag="[FIRMWARE]")
        return RequestSuccess(result)


class FirmwareChannelUploadView(_FirmwareUploadView):
    def post(self, request, channel=None, *args, **kwargs):
        content = _part(request, "channel", firmware.MAX_CHANNEL_SIZE)
        if not content:
            return RequestFailed({"reason": "Missing file 'channel'"})
        result = firmware.store_channel(channel, content, _part(request, "sig", firmware.MAX_SIGNATURE_SIZE))
        ilog(f"channel {channel} published: {result['bundles']} bundles, latest {result['latest']}",
             tag="[FIRMWARE]")
        return RequestSuccess(result)
