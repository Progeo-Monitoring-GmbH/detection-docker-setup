from progeo.helper.project_db_stats import refresh_project_db_stats
from progeo.management.commands._base import BaseCommand


def _mb(value):
    return f"{value / 1024 / 1024:.1f} MB"


class Command(BaseCommand):
    help = (
        "Measure every project database (size, exact measurement count, highest "
        "measurement id, size per yearly partition) and store size/count on the "
        "project's locations. Runs daily as the celery task refresh_project_db_stats.\n\n"
        "Examples:\n"
        "  python manage.py project_db_stats"
    )

    def handle(self, *args, **options):
        results = refresh_project_db_stats()
        total = 0
        for alias, stats in results.items():
            total += stats["size"]
            years = ", ".join(f"{year}: {_mb(size)}" for year, size in sorted(stats["years"].items(), key=str))
            self.stdout.write(
                f"{alias:<12} {_mb(stats['size']):>10}  measurements={stats['count']:<8} "
                f"max_id={stats['max_id']}  [{years}]"
            )
        self.stdout.write(self.style.SUCCESS(f"{len(results)} project databases, {_mb(total)} in total."))
