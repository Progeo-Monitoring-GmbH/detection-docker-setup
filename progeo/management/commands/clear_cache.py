from django.core.cache import cache
from django.core.management.base import BaseCommand
from progeo.helper.basics import dlog


class Command(BaseCommand):
    help = 'iterates over all models and resets the id if existing'

    def handle(self, *args, **options):
        cache.clear()
        dlog("DONE!")
