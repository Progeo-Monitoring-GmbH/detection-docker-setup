"""Django admin login with the 2FA step (helper/two_factor.py).

CaseInsensitiveUsernameOrEmailBackend lets a user with 2FA log in by
password on /aadmin/login/ only because this form checks the code as well.
With TWO_FACTOR_REQUIRED_FOR_STAFF, staff without 2FA are sent to the portal
to set it up first.
"""
from django import forms
from django.contrib.admin.forms import AdminAuthenticationForm
from django.core.exceptions import ValidationError


class AdminTwoFactorAuthenticationForm(AdminAuthenticationForm):
    otp = forms.CharField(
        label="2FA-Code", required=False, max_length=32,
        widget=forms.TextInput(attrs={"autocomplete": "one-time-code", "inputmode": "numeric"}),
        help_text="Nur wenn die Zwei-Faktor-Anmeldung eingerichtet ist.",
    )

    def clean(self):
        from progeo.helper.two_factor import check_login_code, is_required

        cleaned = super().clean()
        user = self.get_user()
        if user is None:
            return cleaned
        if is_required(user):
            raise ValidationError(
                "Bitte richten Sie zuerst im Portal unter „Profil“ die Zwei-Faktor-Anmeldung ein.",
                code="two_factor_setup_required",
            )
        error = check_login_code(user, cleaned.get("otp"), self.request)
        if error == "otp_required":
            raise ValidationError("Bitte geben Sie den Code aus Ihrer Authenticator-App ein.", code=error)
        if error:
            raise ValidationError("Der 2FA-Code ist ungültig.", code=error)
        return cleaned
