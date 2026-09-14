from django.contrib.admin.models import LogEntry

from progeo.helper.basics import dlog
from progeo.management.commands._base import BaseCommand


class Command(BaseCommand):
    help = (
        'Clear LogEntry: deletes all django admin log entries.\n\n'
        'Examples:\n'
        '  python manage.py clear_logs'
    )

    def handle(self, *args, **options):
        LogEntry.objects.all().delete()
        dlog("Cleared LogEntry")
