import sys

from progeo.helper import threshold_fine_tune as ft
from progeo.management.commands._base import BaseCommand

LATEST = "__latest__"


class Command(BaseCommand):
    help = (
        "Fine-tune the global alarm threshold (ProgeoLocation.alarm_threshold) of projects from the true\n"
        "maximum their sensors measured (helper/threshold_fine_tune.py):\n"
        "  proposed = max(ceil(max * (1 + buffer)), minimum)\n"
        "lowered whenever possible, raised only by less than --max-raise (bigger jumps: review).\n"
        "Locations with an active alarm are skipped; sensors with their own threshold or disabled\n"
        "don't count. The findings are written to media/fine-tune/ - nothing changes until --apply.\n\n"
        "Examples:\n"
        "  python manage.py fine_tune_thresholds                          # every project, last 30 days\n"
        "  python manage.py fine_tune_thresholds --project 4700 4701 --days 60 --step 1h\n"
        "  python manage.py fine_tune_thresholds --apply                  # the newest findings file\n"
        "  python manage.py fine_tune_thresholds --apply media/fine-tune/fine_tune_20261120_120000.json --yes\n"
        "  python manage.py fine_tune_thresholds --revert media/fine-tune/fine_tune_20261120_120000.json"
    )

    def add_arguments(self, parser):
        parser.add_argument("--project", type=int, nargs="+", action="extend", default=None,
                            help="Only these project numbers (default: all).")
        parser.add_argument("--days", type=int, default=ft.DEFAULT_DAYS,
                            help=f"Scan the last N days (default {ft.DEFAULT_DAYS}).")
        parser.add_argument("--step", default=None,
                            help="Sampling step per device, e.g. 15m, 1h, 1d (default: every measurement). "
                                 "Faster, but a peak between two samples is missed.")
        parser.add_argument("--buffer", type=float, default=ft.DEFAULT_BUFFER * 100,
                            help=f"Buffer above the maximum in percent (default {ft.DEFAULT_BUFFER * 100:g}).")
        parser.add_argument("--minimum", type=int, default=ft.DEFAULT_MINIMUM,
                            help=f"Never propose a threshold below this (default {ft.DEFAULT_MINIMUM}).")
        parser.add_argument("--max-raise", type=float, default=ft.DEFAULT_MAX_RAISE * 100,
                            help="Raise only by less than this percent - more is left for review "
                                 f"(default {ft.DEFAULT_MAX_RAISE * 100:g}).")
        parser.add_argument("--include-active-alarms", action="store_true",
                            help="Also tune locations with an active alarm (default: skipped).")
        parser.add_argument("--output", default=None, help="Write the findings here instead of media/fine-tune/.")
        parser.add_argument("--verbose", action="store_true", help="List every location, not only the changes.")
        parser.add_argument("--apply", nargs="?", const=LATEST, default=None, metavar="FILE",
                            help="Write the proposals of FILE (default: the newest findings in media/fine-tune/).")
        parser.add_argument("--revert", default=None, metavar="FILE",
                            help="Undo an applied findings FILE (locations still at the proposed threshold).")
        parser.add_argument("--max-age-days", type=int, default=ft.DEFAULT_MAX_AGE_DAYS,
                            help=f"--apply refuses findings older than this (default {ft.DEFAULT_MAX_AGE_DAYS}).")
        parser.add_argument("--yes", action="store_true", help="Apply / revert without asking.")

    def handle(self, *args, **options):
        try:
            if options["apply"] and options["revert"]:
                raise ft.FineTuneError("--apply and --revert exclude each other")
            if options["apply"]:
                self._apply(options)
            elif options["revert"]:
                self._revert(options)
            else:
                self._scan(options)
        except ft.FineTuneError as exc:
            self.stderr.write(self.style.ERROR(str(exc)))
            sys.exit(2)

    # -- scan --------------------------------------------------------------------

    def _scan(self, options):
        step = ft.parse_step(options["step"])
        if options["days"] < 1:
            raise ft.FineTuneError("--days must be at least 1")
        verbose = options["verbose"]

        def progress(entry):
            if verbose or entry["action"] in (*ft.CHANGES, ft.REVIEW):
                self.stdout.write(self._line(entry))

        findings = ft.scan(
            projects=options["project"], days=options["days"], step=step, buffer=options["buffer"] / 100,
            minimum=options["minimum"], max_raise=options["max_raise"] / 100,
            include_active=options["include_active_alarms"], progress=progress,
        )
        path = ft.export(findings, options["output"])
        summary = findings["summary"]
        counts = " | ".join(f"{action}: {summary.get(action, 0)}" for action in
                            (ft.LOWER, ft.RAISE, ft.KEEP, ft.REVIEW, ft.ACTIVE_ALARM, ft.NO_DATA))
        warned = sum(1 for entry in findings["locations"] if entry["warnings"] and entry["action"] in ft.CHANGES)
        self.stdout.write("")
        sampling = f", one measurement per {options['step']}" if step else ""
        self.stdout.write(self.style.SUCCESS(
            f"{len(findings['locations'])} location(s), last {options['days']} day(s){sampling} - {counts}"))
        if warned:
            self.stdout.write(self.style.WARNING(f"{warned} proposed change(s) with warnings - see the file"))
        self.stdout.write(f"Findings: {path}")
        if summary.get(ft.LOWER) or summary.get(ft.RAISE):
            self.stdout.write("Apply with: python manage.py fine_tune_thresholds --apply")

    @staticmethod
    def _line(entry):
        arrow = (f"{entry['current_threshold']} -> {entry['proposed']} ({entry['change_percent']:+g}%)"
                 if entry["proposed"] is not None and entry["change_percent"] is not None
                 else f"{entry['current_threshold']}")
        peak = entry["max_at"]
        where = f"max {peak['value']} at sensor {peak['sensor_order']}" if peak else "no data"
        warn = f"  ! {'; '.join(entry['warnings'])}" if entry["warnings"] else ""
        return (f"{entry['action']:<20} #{entry['project_id'] or '-':<6} {(entry['name'] or '')[:32]:<32} "
                f"{arrow:<22} {where}{warn}")

    # -- apply / revert ----------------------------------------------------------

    def _confirm(self, options, question):
        if options["yes"]:
            return True
        if not sys.stdin.isatty():
            raise ft.FineTuneError("Not a terminal - confirm with --yes")
        return input(f"{question} [y/N] ").strip().lower() in ("y", "yes", "j", "ja")

    def _show(self, plan, verb):
        for entry in plan["changes"]:
            self.stdout.write(self._line(entry))
        for entry, reason in plan["skipped"]:
            self.stdout.write(self.style.WARNING(
                f"skip {'':<15} #{entry['project_id'] or '-':<6} {(entry['name'] or '')[:32]:<32} {reason}"))
        self.stdout.write(f"{len(plan['changes'])} location(s) to {verb}, {len(plan['skipped'])} skipped")

    def _apply(self, options):
        path = ft.latest_file() if options["apply"] == LATEST else options["apply"]
        findings = ft.load(path)
        self.stdout.write(f"Findings: {path} (scanned {findings['created_at']})")
        plan = ft.plan_apply(findings, max_age_days=options["max_age_days"])
        self._show(plan, "change")
        if not plan["changes"]:
            return
        if not self._confirm(options, f"Change {len(plan['changes'])} threshold(s)?"):
            self.stdout.write("Nothing changed.")
            return
        record = ft.apply(path, plan["changes"])
        self.stdout.write(self.style.SUCCESS(f"{len(plan['changes'])} threshold(s) changed - record: {record}"))
        self.stdout.write(f"Undo with: python manage.py fine_tune_thresholds --revert {path}")

    def _revert(self, options):
        path = options["revert"]
        findings = ft.load(path)
        plan = ft.plan_revert(findings)
        self._show(plan, "revert")
        if not plan["changes"]:
            return
        if not self._confirm(options, f"Set {len(plan['changes'])} threshold(s) back?"):
            self.stdout.write("Nothing changed.")
            return
        record = ft.revert(path, plan["changes"])
        self.stdout.write(self.style.SUCCESS(f"{len(plan['changes'])} threshold(s) set back - record: {record}"))
