from django.conf import settings


def show_toolbar(request):
    if request.path.endswith("all/qrcodes/"):
        return False
    return settings.DEBUG


def hide_toolbar(request):
    """The test settings' callback: the toolbar is never shown."""
    return False
