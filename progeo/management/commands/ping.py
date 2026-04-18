from django.core.management.base import BaseCommand

from progeo.helper.basics import okaylog

class Command(BaseCommand):
    help = 'Just a simple ping command to check if the management command system is working'

    def handle(self, *args, **options):
        msg = "Pong! The ping command is working."
        print("FOR THE LOGS!!!", msg)
        okaylog(msg, tag="[NICE]")


