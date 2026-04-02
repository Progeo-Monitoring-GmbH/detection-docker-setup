from django.contrib.auth.models import Permission
from django.contrib.contenttypes.models import ContentType
from django.core.management import call_command
from django.core.management.base import BaseCommand
from django.apps import apps

from progeo.helper.basics import dlog, okaylog, ilog, elog


class Command(BaseCommand):
    help = "Added missing permissions"

    def handle(self, *args, **options):
        _app = "progeo"
        has_created = None

        permissions = [
            {"codename": "add", "name": "Can add"},
            {"codename": "change", "name": "Can change"},
            {"codename": "delete", "name": "Can delete"},
            {"codename": "view", "name": "Can view"},
        ]

        current_app_config = apps.get_containing_app_config(_app)

        if not current_app_config:
            elog("Skipping App", _app)
        else:
            for _model in current_app_config.get_models():
                contenttype, created = ContentType.objects.get_or_create(app_label=_app,
                                                                         model=_model._meta.object_name.lower())
                if created:
                    has_created = True
                    okaylog("Contenttype", contenttype, tag="[CREATED]")

        for con_type in ContentType.objects.filter(app_label="progeo"):
            for perm in permissions:
                _codename = perm.get("codename")
                _name = perm.get("name")
                permission, created = Permission.objects.get_or_create(name=f"{_name} {con_type.model}",
                                                                       content_type=con_type,
                                                                       codename=f"{_codename}_{con_type.model}")
                if created:
                    has_created = True
                    okaylog("Permission", permission, tag="[CREATED]")

        if has_created:
            ilog("Run sync_default!")
            call_command("sync_default")

        dlog("DONE!")
