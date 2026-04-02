from django.core.management.base import BaseCommand
from django.db import connections

from progeo.helper.basics import okaylog
from progeo.settings import DATABASES


class Command(BaseCommand):
    help = 'Recreates db-schema'

    def handle(self, *args, **options):
        for db in DATABASES.keys():
            with connections[db].cursor() as cursor:
                cursor.execute("DROP SCHEMA public CASCADE;")
                cursor.execute("CREATE SCHEMA public;")
                okaylog(f"DB '{db}' cleared!")
