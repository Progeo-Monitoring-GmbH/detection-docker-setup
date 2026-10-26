from django.contrib import admin
from django.contrib.admin.models import LogEntry

from progeo.admin_login import AdminTwoFactorAuthenticationForm
from progeo.v1.admin import MultiDBModelAdmin, models
from progeo.v1.models import Backup

# ==============================================================================================


MultiDBModelAdmin.handle_register_django(models)
# The per-database models (locations, devices, measurements, ...) at startup:
# the admin builds its URLs once - registering them only when someone first
# picks another database left them without URLs.
MultiDBModelAdmin.handle_register_custom("default")
MultiDBModelAdmin.handle_register_custom("default")

admin.site.register(Backup)


admin.site.register(LogEntry)


# Admin login with the 2FA code (progeo/admin_login.py).
admin.site.login_form = AdminTwoFactorAuthenticationForm
