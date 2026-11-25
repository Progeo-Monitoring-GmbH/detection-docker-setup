from django.contrib import admin
from django.contrib.admin.models import LogEntry

from progeo.admin_login import AdminTwoFactorAuthenticationForm
from progeo.v1.admin import MultiDBModelAdmin, models

# ==============================================================================================


MultiDBModelAdmin.handle_register_django(models)
# The per-database models (locations, devices, measurements, ...) at startup:
# the admin builds its URLs once - registering them only when someone first
# picks another database left them without URLs. Backup's and Account's
# admins are in there too (Account isn't in `models`: it has its own admin).
MultiDBModelAdmin.handle_register_custom("default")

admin.site.register(LogEntry)


# Admin login with the 2FA code (progeo/admin_login.py).
admin.site.login_form = AdminTwoFactorAuthenticationForm
