from django.apps import AppConfig


class ProgeoConfig(AppConfig):
    name = "progeo"

    def ready(self):
        # Registers the deployment checks (progeo/checks.py).
        from progeo import checks  # noqa: F401
