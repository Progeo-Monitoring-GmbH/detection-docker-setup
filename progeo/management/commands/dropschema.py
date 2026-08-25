from django.core.management.base import BaseCommand
from django.db import connections

from progeo.helper.basics import okaylog
from progeo.settings import DATABASES


class Command(BaseCommand):
    help = (
        'Recreates db-schema: DROPs and recreates the public schema of every '
        'configured database (DESTRUCTIVE - all tables/data are lost).\n\n'
        'Examples:\n'
        '  python manage.py dropschema\n\n'
        'WARNING: drops all data in every configured database!'
    )

    def handle(self, *args, **options):
        for db in DATABASES.keys():
            with connections[db].cursor() as cursor:
                cursor.execute("DROP SCHEMA public CASCADE;")
                cursor.execute("CREATE SCHEMA public;")
                okaylog(f"DB '{db}' cleared!")
