from django.apps import AppConfig


class WerkConfig(AppConfig):
    """ProGeo's factory (Werk): the dm sensors' factory values and site
    measurements (manuSensor app) and the digital production record - data
    linked with Airtable, kept in "default" only (never in a project
    database, the template or the demo - progeo/router.py)."""

    name = "progeo.werk"
    label = "werk"
    verbose_name = "Werk"
    default_auto_field = "django.db.models.AutoField"
