from progeo.management.commands._base import BaseCommand
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken, BlacklistedToken
from progeo.helper.basics import dlog


class Command(BaseCommand):
    help = (
        'Clear Tokens: deletes all blacklisted and outstanding JWT tokens.\n\n'
        'Examples:\n'
        '  python manage.py clear_token'
    )

    def handle(self, *args, **options):
        BlacklistedToken.objects.all().delete()
        OutstandingToken.objects.all().delete()
        dlog("Cleared Token")
