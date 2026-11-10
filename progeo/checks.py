"""System checks for the deployment configuration (registered in apps.py).

They run with every management command - also `migrate` in run-server.sh on
each start - so a misconfigured server says so in its log right away.
Warnings, not errors: an error would stop the backend from starting at all.
"""
from django.conf import settings
from django.core.checks import Tags, Warning, register

# Keys shorter than this are guessable (HS256 wants at least 256 bits).
MIN_KEY_LENGTH = 32


def _key_problem(value):
    """Why `value` is no usable secret key, None if it is one."""
    if not value:
        return "is empty"
    # The templates ship "~~~~": a server that copied them signs with a public key.
    if set(str(value)) <= {"~"}:
        return "is still the placeholder of django.env.template"
    if len(str(value)) < MIN_KEY_LENGTH:
        return f"is shorter than {MIN_KEY_LENGTH} characters"
    return None


@register(Tags.security, deploy=False)
def check_secret_keys(app_configs, **kwargs):
    if settings.DEBUG:
        return []
    keys = (
        ("SECRET_KEY", settings.SECRET_KEY, "progeo.W001"),
        # Signs the JWTs: whoever knows it can log in as anyone.
        ("SIGNING_KEY", getattr(settings, "SIMPLE_JWT", {}).get("SIGNING_KEY"), "progeo.W002"),
    )
    warnings = []
    for name, value, check_id in keys:
        problem = _key_problem(value)
        if problem:
            warnings.append(Warning(
                f"{name} {problem}.",
                hint=f"Set a random {name} in django.env, e.g. "
                     "python -c \"import secrets; print(secrets.token_urlsafe(64))\". "
                     "Changing SIGNING_KEY logs every user out.",
                id=check_id,
            ))
    if "*" in settings.ALLOWED_HOSTS:
        warnings.append(Warning(
            "ALLOWED_HOSTS contains '*': any Host header is accepted.",
            hint="List the server names in DJANGO_ALLOWED_HOSTS.",
            id="progeo.W010",
        ))
    return warnings
