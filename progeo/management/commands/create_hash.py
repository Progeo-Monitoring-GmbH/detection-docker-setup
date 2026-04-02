from django.core.management.base import BaseCommand

from progeo.v1.helper import generate_hash


class Command(BaseCommand):
    help = 'Creates a random hash-string'

    def handle(self, *args, **options):
        print(generate_hash())
        print(generate_hash())
        print(generate_hash())
