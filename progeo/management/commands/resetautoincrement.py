from django.apps import apps
from django.core.exceptions import FieldError
from django.core.management.base import BaseCommand
from django.db import ProgrammingError
from django.db import connections

from progeo.helper.basics import dlog
from progeo.helper.basics import okaylog, elog
from progeo.sets import DJANGO_MODELS
from progeo.settings import DATABASES


class Command(BaseCommand):
    help = "iterates over all models and resets the id if existing"

    @staticmethod
    def handle_model(_models_list):
        _models = list(_models_list)
        for db in DATABASES.keys():
            dlog(f"db={db: <20} | models={_models}")
            for _model in _models:
                if not _model:
                    continue
                try:
                    max_id = max([_id[0] for _id in _model.objects.using(db).values_list('id')])
                except ProgrammingError as e:
                    elog(e, tag="[ProgrammingError]")
                    continue
                except FieldError as e:
                    elog(e, tag="[FieldError]")
                    continue
                except ValueError as e:
                    elog(e, tag="[ValueError]")
                    continue

                if max_id:
                    _table = _model._meta.db_table
                    # .get_class_name()
                    with connections[db].cursor() as cursor:
                        try:
                            cursor.execute(f"SELECT setval('public.{_table}_id_seq', {max_id});")
                            okaylog(f"Set {_table} for db={db} => ID={max_id}")
                        except ProgrammingError as e:
                            elog(e, tag="[ProgrammingError]")

    def handle(self, *args, **options):
        # call_command("sqlsequencereset", "progeo") # NOT WOKRING CORRECTLY
        _apps = ["progeo"]
        self.handle_model([m for m, _ in DJANGO_MODELS])

        for _app in _apps:
            current_app_config = apps.get_containing_app_config(_app)

            if not current_app_config:
                elog("Skipping App", _app)
                continue

            all_models = current_app_config.get_models()
            self.handle_model(all_models)

        dlog("DONE!")
