from django.core.cache import cache
from progeo.management.commands._base import BaseCommand
from progeo.helper.basics import dlog


class Command(BaseCommand):
    help = (
        'Clears the Django cache (cache.clear()).\n\n'
        'Examples:\n'
        '  python manage.py clear_cache'
    )

    def handle(self, *args, **options):
        cache.clear()
        dlog("DONE!")
