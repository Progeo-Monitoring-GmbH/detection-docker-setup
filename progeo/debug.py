from progeo.settings import DEBUG


def show_toolbar(request):
    if request.path.endswith("all/qrcodes/"):
        return False
    return DEBUG
