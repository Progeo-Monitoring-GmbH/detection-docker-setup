from progeo.management.commands._base import BaseCommand

from progeo.v1.helper import generate_hash


class Command(BaseCommand):
    help = (
        'Creates a random hash-string: prints three fresh hashes (e.g. for '
        'SECRET_KEY / SIGNING_KEY / VERIFYING_KEY).\n\n'
        'Examples:\n'
        '  python manage.py create_hash'
    )

    def handle(self, *args, **options):
        print(generate_hash())
        print(generate_hash())
        print(generate_hash())
