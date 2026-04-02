from django.core.management.base import BaseCommand
from django.db import transaction


from progeo.helper.basics import dlog, okaylog, elog
from progeo.sets import DJANGO_MODELS
from progeo.settings import DJANGO_DATABASES



def copy_model_sets(model, db, from_db='default'):
    # We wrap everything in a transaction against the target DB:
    with transaction.atomic(using=db):

        # Get all objects from the source DB
        source_qs = model.objects.using(from_db).all()

        for source_obj in source_qs:
            # Now handle the many-to-many fields
            target_obj = model.objects.using(db).get(pk=source_obj.pk)
            for field in model._meta.get_fields():
                if field.many_to_many and not field.auto_created:
                    # Get M2M related objects from the source
                    m2m_manager = getattr(source_obj, field.name)
                    related_objs = m2m_manager.using(from_db).all()

                    # Set them in the target object
                    print(model._meta.object_name, "=>", field.name, "==>", len(related_objs), related_objs)
                    if field.name == "users":
                        target_obj.users.set(related_objs)
                    elif field.name == "groups":
                        target_obj.groups.set(related_objs)
                    elif field.name == "permissions":
                        target_obj.permissions.set(related_objs)
                    elif field.name == "user_permissions":
                        target_obj.user_permissions.set(related_objs)
                    elif field.name == "group_permissions":
                        target_obj.group_permissions.set(related_objs)
                    else:
                        elog(f"Unhandled field: {field.name}")

            target_obj.save()

    info = f"'{from_db}' => '{db}'"
    okaylog(f"{info: <45} Copied {len(source_qs)}x  > {model.__name__} <")


def copy_model(model, db, from_db='default'):
    """
    Copy all instances of `model_class` from `from_db` to `to_db`.
    If an object with the same PK exists in `to_db`, update it;
    otherwise, create it. Then copy M2M fields.

    :param model: The Django model class to copy.
    :param from_db: The source DB alias.
    :param db: The target DB alias.
    """

    # We wrap everything in a transaction against the target DB:
    with transaction.atomic(using=db):

        # Get all objects from the source DB
        source_qs = model.objects.using(from_db).all()
        print(f"Copying {len(source_qs)} objects of {model.__name__} from '{from_db}' to '{db}'")

        for source_obj in source_qs:
            # Build a dict of non-relational fields (exclude M2M, OneToMany, etc.)
            data = {}
            for field in model._meta.get_fields():
                # Exclude relationships or auto-created fields
                if field.is_relation or field.auto_created:
                    continue
                # Extract the field value from source_obj
                data[field.name] = getattr(source_obj, field.name)
                # print(field.name, "=>", data[field.name])

            try:
                # Create or update object in the target DB
                target_obj, created = model.objects.using(db).update_or_create(
                    pk=source_obj.pk,
                    defaults=data
                )

                # Explicitly save to ensure the object is persisted
                # (and has its PK in case the DB/backend requires it).
                target_obj.save(using=db)
            except Exception as e:
                elog(f"{model.__name__}: {e}")
                elog("DATA:", data)
                elog("source_obj:", source_obj)
                elog("get_fields:", model._meta.get_fields())

    info = f"'{from_db}' => '{db}'"
    okaylog(f"{info: <45} Copied {len(source_qs)}x  > {model.__name__} <")


class Command(BaseCommand):
    help = "Sync all"
    SHOW_LOG = True

    def handle(self, *args, **options):

        for db in DJANGO_DATABASES:
            for _model, _table in DJANGO_MODELS:
                if not _model:
                    continue
                copy_model(_model, db)

        # for db in ["soziales_zentrum"]:#DJANGO_DATABASES:
        #     for _model, _table in DJANGO_MODELS:
        #         if not _model:
        #             continue
        #         copy_model_sets(_model, db)

        dlog("DONE!", DJANGO_DATABASES)
