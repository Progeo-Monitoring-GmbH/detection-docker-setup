from django.contrib import admin
from django.contrib.admin.models import LogEntry

from progeo.v1.admin import MultiDBModelAdmin, models
from progeo.v1.models import Backup

# ==============================================================================================


MultiDBModelAdmin.handle_register_django(models)
MultiDBModelAdmin.handle_register_custom("default")

admin.site.register(Backup)


admin.site.register(LogEntry)
