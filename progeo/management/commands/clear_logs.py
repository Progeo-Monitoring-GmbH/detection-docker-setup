from django.contrib.admin.models import LogEntry
from django.core.management.base import BaseCommand
from progeo.helper.basics import dlog


class Command(BaseCommand):
    help = 'Clear LogEntry'

    def handle(self, *args, **options):
        LogEntry.objects.all().delete()
        dlog("Cleared LogEntry")
