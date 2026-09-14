from progeo.helper.basics import okaylog
from progeo.management.commands._base import BaseCommand


class Command(BaseCommand):
    help = (
        'Just a simple ping command to check if the management command system is '
        'working.\n\n'
        'Examples:\n'
        '  python manage.py ping'
    )

    def handle(self, *args, **options):
        msg = "Pong! The ping command is working."
        print("FOR THE LOGS!!!", msg)
        okaylog(msg, tag="[NICE]")


