import os

from django.conf import settings
from django.core.management.base import CommandError

from progeo.helper.matrix_accounts import MAS_PROVIDER_ID, OIDC_CLIENT_ID
from progeo.management.commands._base import BaseCommand


class Command(BaseCommand):
    help = (
        "Register (or update) the Matrix Authentication Service as the only "
        "OpenID Connect client of the portal (progeo/oidc.py): client id "
        f"'{OIDC_CLIENT_ID}', secret MATRIX_OIDC_CLIENT_SECRET, redirect URI "
        "https://<MATRIX_AUTH_DOMAIN>/upstream/callback/<provider id>. Run it "
        "once after setting up the messenger profile and whenever the secret "
        "or MATRIX_AUTH_DOMAIN changes (docker/matrix/README.md).\n\n"
        "Example:\n"
        "  python manage.py matrix_oidc_client"
    )

    def handle(self, *args, **options):
        from oauth2_provider.models import Application

        secret = (os.getenv("MATRIX_OIDC_CLIENT_SECRET") or "").strip()
        auth_domain = settings.MATRIX_AUTH_DOMAIN
        if not secret or not auth_domain:
            raise CommandError("MATRIX_OIDC_CLIENT_SECRET and MATRIX_AUTH_DOMAIN must be set (.env).")
        if not settings.PORTAL_OIDC_ENABLED:
            raise CommandError("The OpenID Connect provider is off: set PORTAL_OIDC_ISSUER and create "
                               "the signing key (PORTAL_OIDC_KEY_FILE).")

        _application, created = Application.objects.update_or_create(
            client_id=OIDC_CLIENT_ID,
            defaults={
                "name": "ProGeo Matrix (MAS)",
                "client_type": Application.CLIENT_CONFIDENTIAL,
                "authorization_grant_type": Application.GRANT_AUTHORIZATION_CODE,
                "redirect_uris": f"https://{auth_domain}/upstream/callback/{MAS_PROVIDER_ID}",
                "client_secret": secret,
                "hash_client_secret": True,
                # Our own service: no "allow access?" page for the user.
                "skip_authorization": True,
                "algorithm": Application.RS256_ALGORITHM,
            },
        )
        self.stdout.write(f"{'Created' if created else 'Updated'} the OpenID Connect client '{OIDC_CLIENT_ID}'.")
