"""
Django settings for progeo project.
"""
import os
import sys
from datetime import timedelta
from pathlib import Path

from progeo.helper.basics import flog, read_env
from progeo.sentry import init_sentry
from progeo.v1.helper import parse_boolean, parse_int, parse_split_str

BASE_DIR = Path(__file__).resolve(strict=True).parent.parent

ENV_FILE_PATH = os.path.join(BASE_DIR, "django.env")
read_env(ENV_FILE_PATH)

# SECURITY WARNING: keep the secret key used in production secret!
SECRET_KEY = os.getenv("SECRET_KEY")

# SECURITY WARNING: don't run with debug turned on in production!
DEBUG = parse_boolean(os.getenv("DEBUG"))

_raw_allowed_hosts = parse_split_str(os.getenv("DJANGO_ALLOWED_HOSTS", ""), ",")
ALLOWED_HOSTS = [host.strip() for host in _raw_allowed_hosts if host.strip()]

# Hosts the legacy GPRS controllers send to (GET /gprs_<project>.php, see
# progeo/v1/legacy/gprs.py). Their firmware is fixed, so they are always allowed.
LEGACY_GPRS_HOSTS = parse_split_str(os.getenv("LEGACY_GPRS_HOSTS", "data-progeo.net,www.data-progeo.net"), ",")
if ALLOWED_HOSTS and "*" not in ALLOWED_HOSTS:
    ALLOWED_HOSTS += [host.strip() for host in LEGACY_GPRS_HOSTS if host.strip()]

# ########################################################################
# Server role / feature flags (see django.env.template)
#
# A deployment can act as a ROOT server (full system), a NODE server
# (subordinate, reports to a root server) or both/neither. Mailing and
# measurement evaluation can be switched off per server.
# ########################################################################
# Whether this server is configured as a root server.
PROGEO_CONFIG_IS_ROOT_SERVER = parse_boolean(os.getenv("PROGEO_CONFIG_IS_ROOT_SERVER"))
# Whether this server is configured as a node server.
PROGEO_CONFIG_IS_NODE_SERVER = parse_boolean(os.getenv("PROGEO_CONFIG_IS_NODE_SERVER"))
# IP/hostname of the root server this node reports to; empty when unset.
PROGEO_CONFIG_HAS_ROOT_SERVER = (os.getenv("PROGEO_CONFIG_HAS_ROOT_SERVER") or "").strip()
# Whether mails may be sent (daily reports, disconnect notifications, ...).
PROGEO_CONFIG_ENABLE_MAILING = parse_boolean(os.getenv("PROGEO_CONFIG_ENABLE_MAILING"))
# Whether celery evaluates measurements / raises alarms on this server.
PROGEO_CONFIG_ENABLE_MEASUREMENTS = parse_boolean(os.getenv("PROGEO_CONFIG_ENABLE_MEASUREMENTS"))
# Evaluate every measurement for alarms as soon as it is stored instead of the
# hourly evaluate_measurements beat task (meant for low-traffic servers).
PROGEO_CONFIG_EVALUATE_INSTANTLY = parse_boolean(os.getenv("PROGEO_CONFIG_EVALUATE_INSTANTLY"))
# Periodic celery tasks celery beat must not start (progeo/celery.py), comma
# separated: schedule names ("check-existing-alarms-quarter-hourly"), task
# names ("check_existing_alarms") or "all" - e.g. while split_project_dbs runs.
CELERY_DISABLED_TASKS = [name.strip() for name in os.getenv("CELERY_DISABLED_TASKS", "").split(",") if name.strip()]
# Bearer token Prometheus scrapes /metrics with (progeo/metrics.py); empty = /metrics answers 404.
METRICS_TOKEN = (os.getenv("METRICS_TOKEN") or "").strip()

# ########################################################################
# Outbound mail / SMS safety (see django.env.template, helper/outbound.py)
#
# Safe by default: unless the env explicitly says MAIL_TEST_MODE=0 every mail
# goes to MAIL_TEST_RECIPIENT, and unless SMS_DRY_RUN=0 SMS are only logged.
# ########################################################################
MAIL_TEST_MODE = parse_boolean(os.getenv("MAIL_TEST_MODE", "1"))
MAIL_TEST_RECIPIENT = (os.getenv("MAIL_TEST_RECIPIENT") or "test-mails@progeo.com").strip()
SMS_DRY_RUN = parse_boolean(os.getenv("SMS_DRY_RUN", "1"))
# Envelope sender (Return-Path) - bounces land in this mailbox. Empty = the
# SMTP login (MAIL_USER) when it is an address, else the From address.
MAIL_ENVELOPE_FROM = (os.getenv("MAIL_ENVELOPE_FROM") or "").strip()
# Hard limits - we never mass send. Hitting a global limit trips the
# circuit breaker: all sending stops until staff reset it.
OUTBOUND_LIMITS = {
    "mail_max_recipients": parse_int(os.getenv("MAIL_MAX_RECIPIENTS"), 5),
    "mail_per_recipient_hour": parse_int(os.getenv("MAIL_LIMIT_PER_RECIPIENT_HOUR"), 20),
    "mail_per_recipient_day": parse_int(os.getenv("MAIL_LIMIT_PER_RECIPIENT_DAY"), 100),
    "mail_global_hour": parse_int(os.getenv("MAIL_LIMIT_GLOBAL_HOUR"), 100),
    "sms_per_recipient_hour": parse_int(os.getenv("SMS_LIMIT_PER_RECIPIENT_HOUR"), 3),
    "sms_per_recipient_day": parse_int(os.getenv("SMS_LIMIT_PER_RECIPIENT_DAY"), 10),
    "sms_global_hour": parse_int(os.getenv("SMS_LIMIT_GLOBAL_HOUR"), 20),
    "sms_global_day": parse_int(os.getenv("SMS_LIMIT_GLOBAL_DAY"), 50),
    # Longer SMS are cut to this many segments (160 GSM-7 chars each).
    "sms_max_segments": parse_int(os.getenv("SMS_MAX_SEGMENTS"), 1),
}
# Mails triggered by requests (alarms of instantly evaluated uploads, access
# requests, login links) are handed to celery so the request never waits on
# SMTP; inside celery tasks they are sent right away.
OUTBOUND_ASYNC = parse_boolean(os.getenv("OUTBOUND_ASYNC", "1"))
# Alarm notifications: one per location and channel within the cooldown;
# alarms older than MAX_AGE (backfills, re-evaluations) notify nobody.
ALARM_NOTIFY_COOLDOWN_MINUTES = parse_int(os.getenv("ALARM_NOTIFY_COOLDOWN_MINUTES"), 60)
ALARM_NOTIFY_MAX_AGE_HOURS = parse_int(os.getenv("ALARM_NOTIFY_MAX_AGE_HOURS"), 6)
# One-time links (helper/login_links.py).
MAGIC_LINK_LOGIN_MINUTES = parse_int(os.getenv("MAGIC_LINK_LOGIN_MINUTES"), 15)
MAGIC_LINK_INVITE_HOURS = parse_int(os.getenv("MAGIC_LINK_INVITE_HOURS"), 72)
ACCESS_REQUEST_VERIFY_HOURS = parse_int(os.getenv("ACCESS_REQUEST_VERIFY_HOURS"), 48)
# Login links for staff/superusers: off - a mailbox must not be an admin login.
MAGIC_LINK_ALLOW_STAFF = parse_boolean(os.getenv("MAGIC_LINK_ALLOW_STAFF", "0"))
# Password reset links (helper/password_reset.py) - only for users with 2FA.
PASSWORD_RESET_MINUTES = parse_int(os.getenv("PASSWORD_RESET_MINUTES"), 30)
# Failed password/2FA checks before a login name / client IP is locked for
# 15 minutes (helper/login_throttle.py).
LOGIN_MAX_FAILURES_PER_NAME = parse_int(os.getenv("LOGIN_MAX_FAILURES_PER_NAME"), 10)
LOGIN_MAX_FAILURES_PER_IP = parse_int(os.getenv("LOGIN_MAX_FAILURES_PER_IP"), 50)
# DRF tokens of /auth/login/ (ExpiringTokenAuthentication); 0 = no expiry.
DRF_TOKEN_MAX_AGE_DAYS = parse_int(os.getenv("DRF_TOKEN_MAX_AGE_DAYS"), 30)
# Two-factor authentication (helper/two_factor.py): the name authenticator
# apps show, and whether staff/superusers must set it up before they can use
# the portal (TwoFactorRequiredMiddleware) - switch on once staff know.
TWO_FACTOR_ISSUER = os.getenv("TWO_FACTOR_ISSUER", "ProGeo")
# Encrypts the stored 2FA keys; empty = derived from SECRET_KEY. Set it once and
# keep it - changing it (or SECRET_KEY without it) invalidates every 2FA device.
TWO_FACTOR_ENCRYPTION_KEY = os.getenv("TWO_FACTOR_ENCRYPTION_KEY", "")
TWO_FACTOR_REQUIRED_FOR_STAFF = parse_boolean(os.getenv("TWO_FACTOR_REQUIRED_FOR_STAFF", "0"))
# Who is told about new access requests; empty = DJANGO_SUPERUSER_EMAIL.
ACCESS_REQUEST_NOTIFY = (os.getenv("ACCESS_REQUEST_NOTIFY") or os.getenv("DJANGO_SUPERUSER_EMAIL") or "").strip()
# Bounce mailbox (helper/bounces.py); user/password default to the SMTP login.
BOUNCE_IMAP_HOST = (os.getenv("BOUNCE_IMAP_HOST") or "").strip()
BOUNCE_IMAP_PORT = parse_int(os.getenv("BOUNCE_IMAP_PORT"), 993)
BOUNCE_IMAP_USER = (os.getenv("BOUNCE_IMAP_USER") or "").strip()
BOUNCE_IMAP_PASSWORD = os.getenv("BOUNCE_IMAP_PASSWORD") or ""
BOUNCE_IMAP_FOLDER = (os.getenv("BOUNCE_IMAP_FOLDER") or "INBOX").strip()
BOUNCE_IMAP_PROCESSED_FOLDER = (os.getenv("BOUNCE_IMAP_PROCESSED_FOLDER") or "progeo-bounces").strip()

# Airtable (pyairtable) integration - see django.env.template. The API key is
# a placeholder until a real personal access token is configured.
AIRTABLE_API_KEY = (os.getenv("AIRTABLE_API_KEY") or "").strip()
AIRTABLE_BASE_ID = (os.getenv("AIRTABLE_BASE_ID") or "").strip()
AIRTABLE_PROJECTS_TABLE = (os.getenv("AIRTABLE_PROJECTS_TABLE") or "Projects").strip()

# Origin the provisioned controllers send their samples to (control.url of the
# config, helper/device_provisioning.py) - on a local dev system e.g. the LAN
# address of the backend.
DEVICE_SAMPLE_BASE_URL = (os.getenv("DEVICE_SAMPLE_BASE_URL") or "").strip().rstrip("/") or "https://api.progeo.com"

PRETTY_DATE_FORMAT = "%d.%m.%Y, %H:%M"
DATETIME_FORMAT = PRETTY_DATE_FORMAT

# Application definition
INSTALLED_APPS = [
    "daphne",

    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # ArrayField (ProgeoMeasurement.eigenpotenzial / wirkpotenzial).
    "django.contrib.postgres",

    "rest_framework",
    "rest_framework.authtoken",
    "rest_framework_simplejwt",
    "rest_framework_simplejwt.token_blacklist",

    "dbbackup",
    "corsheaders",

    "channels",
    "django_celery_results",
    "debug_toolbar",

    "colorfield",
    "progeo",
]

MIDDLEWARE = [
    # First: the measured duration covers every other middleware, and it
    # answers /metrics before SecurityMiddleware and the host check.
    "progeo.metrics.MetricsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "debug_toolbar.middleware.DebugToolbarMiddleware",
    # "silk.middleware.SilkyMiddleware",
    "progeo.middlewares.AdminGetParamMiddleware",
    "progeo.middlewares.AccountMiddleware",
    "progeo.middlewares.DemoReadOnlyMiddleware",
    "progeo.middlewares.PendingAccessMiddleware",
    "progeo.middlewares.ImpersonationMiddleware",
    "progeo.middlewares.TwoFactorRequiredMiddleware",
]

DEBUG_TOOLBAR_CONFIG = {
    "SHOW_TOOLBAR_CALLBACK": "progeo.debug.show_toolbar",
    "DISABLE_PANELS": {}
}

DEBUG_TOOLBAR_PANELS = [
    'debug_toolbar.panels.timer.TimerPanel',
    'debug_toolbar.panels.history.HistoryPanel',
    #'debug_toolbar.panels.versions.VersionsPanel',
    #'debug_toolbar.panels.settings.SettingsPanel',
    #'debug_toolbar.panels.headers.HeadersPanel',
    'debug_toolbar.panels.request.RequestPanel',
    'debug_toolbar.panels.sql.SQLPanel',
    'debug_toolbar.panels.templates.TemplatesPanel',
    'debug_toolbar.panels.cache.CachePanel',
    'debug_toolbar.panels.signals.SignalsPanel',
    #'debug_toolbar.panels.redirects.RedirectsPanel',
    #'debug_toolbar.panels.profiling.ProfilingPanel',
]

REST_FRAMEWORK = {
    "DATETIME_FORMAT": PRETTY_DATE_FORMAT,

    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_AUTHENTICATION_CLASSES": [
        # DRF tokens (/auth/login/) expire after DRF_TOKEN_MAX_AGE_DAYS.
        "progeo.authentication.ExpiringTokenAuthentication",
        "rest_framework.authentication.BasicAuthentication",
        "rest_framework_simplejwt.authentication.JWTAuthentication",
        # Not progeo.authentication.TransferTokenAuthentication: device tokens
        # (?token= in URLs) only count on the ingest actions that list it.
        # Last: header-based auth (JWT/Token) must win. The SPA is same-origin, so
        # the browser also sends the sessionid cookie set at login; if the session
        # matched first, DRF would enforce CSRF and reject the POST (403).
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PARSER_CLASSES": [
        "rest_framework.parsers.JSONParser",
        "rest_framework.parsers.FormParser",
        "rest_framework.parsers.MultiPartParser"
    ],
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=60),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=1),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
    "UPDATE_LAST_LOGIN": True,

    "ALGORITHM": "HS256",
    "SIGNING_KEY": os.getenv("SIGNING_KEY", None),
    "VERIFYING_KEY": os.getenv("VERIFYING_KEY", None),
    "AUDIENCE": None,
    "ISSUER": None,
    "JWK_URL": None,
    "LEEWAY": 0,

    "AUTH_HEADER_TYPES": ("Bearer",),
    "AUTH_HEADER_NAME": "HTTP_AUTHORIZATION",
    "AUTH_COOKIE_SAMESITE": "samesite",
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "user_id",
    "USER_AUTHENTICATION_RULE": "rest_framework_simplejwt.authentication.default_user_authentication_rule",

    "AUTH_TOKEN_CLASSES": ("rest_framework_simplejwt.tokens.AccessToken",),
    "TOKEN_TYPE_CLAIM": "token_type",

    "JTI_CLAIM": "jti",

}

ROOT_URLCONF = "progeo.urls"
ASGI_APPLICATION = "progeo.routing.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        # Before the apps' templates: progeo comes after django.contrib.admin in
        # INSTALLED_APPS, so its admin/base_site.html (database dropdown) would lose.
        "DIRS": [BASE_DIR / "progeo" / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

# Database
# https://docs.djangoproject.com/en/4.2/ref/settings/#databases
DJANGO_DATABASES = parse_split_str(os.getenv("DJANGO_DATABASES", ""), ";")
if len(DJANGO_DATABASES) == 0:
    flog("DJANGO_DATABASES is empty")

# Names the process in pg_stat_activity / ps on the database server (e.g.
# "progeo manage.py split_project_dbs", "progeo celery worker"), so it shows
# who holds the connections. Project databases copy it from "default".
_process_words = [os.path.basename(sys.argv[0]), *(arg for arg in sys.argv[1:] if not arg.startswith("-"))]
DB_APPLICATION_NAME = " ".join(["progeo", *_process_words[:3]])[:63]  # Postgres keeps 63 bytes

dyn_dbs = {}
for db in DJANGO_DATABASES:
    dyn_dbs.update({db: {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": db,
        "USER": os.getenv("POSTGRES_USER"),
        "PASSWORD": os.getenv("POSTGRES_PASSWORD"),
        "HOST": os.getenv("POSTGRES_HOST"),
        "PORT": os.getenv("POSTGRES_PORT"),
        "OPTIONS": {"application_name": DB_APPLICATION_NAME},
    }})

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.getenv("POSTGRES_DB"),
        "USER": os.getenv("POSTGRES_USER"),
        "PASSWORD": os.getenv("POSTGRES_PASSWORD"),
        "HOST": os.getenv("POSTGRES_HOST"),
        "PORT": os.getenv("POSTGRES_PORT"),
        "OPTIONS": {"application_name": DB_APPLICATION_NAME},
    },
    **dyn_dbs
}

# Own database of the public demo (demo_account command, /v1/demo/): the demo
# account, its locations and generated data live there completely, so demo
# rows never show up between customer data. Same server and credentials as
# "default". Not listed in DATABASES on purpose: like the project databases
# it is registered only once it exists (helper/project_dbs.py:
# register_demo_db), so commands looping over DATABASES don't fail on a
# system where it was never created. prepare_databases, adv_migrate and
# demo_account create and migrate it.
DEMO_DATABASE = os.getenv("DEMO_DATABASE", "demo")

# Per-project databases (progeo/helper/project_dbs.py): one database per
# project, named "<PROJECT_DB_PREFIX><project_id>" or "<PROJECT_DB_PREFIX>unknown"
# (locations without project_id). The prefix is empty by default.
# PROJECT_DB_SPLIT routes the project models there - only switch it on after
# `split_project_dbs` copied the data. PROJECT_DB_STRICT raises on project-model
# queries without a project instead of falling back to default.
PROJECT_DB_PREFIX = os.getenv("PROJECT_DB_PREFIX", "")
PROJECT_DB_SPLIT = parse_boolean(os.getenv("PROJECT_DB_SPLIT", "False"))
PROJECT_DB_STRICT = parse_boolean(os.getenv("PROJECT_DB_STRICT", "False"))
# Threads for views spanning many project databases (project_dbs.map_databases);
# each holds its own connection while it runs.
PROJECT_DB_WORKERS = parse_int(os.getenv("PROJECT_DB_WORKERS"), 8)

DATABASE_ROUTERS = [
    #"progeo.router.DjangoRouter",
    "progeo.router.DemoRouter",
    "progeo.router.ProjectRouter",
    "progeo.router.AccountRouter",
]

# Login accepts the username or email, case-insensitively (see backend).
AUTHENTICATION_BACKENDS = [
    "progeo.authentication.CaseInsensitiveUsernameOrEmailBackend",
    "django.contrib.auth.backends.ModelBackend",
]

# Password validation
# https://docs.djangoproject.com/en/4.2/ref/settings/#auth-password-validators

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

PROTOCOL = os.getenv("PROTOCOL", "http")

_raw_allowed_origins = parse_split_str(os.getenv("ALLOWED_ORIGINS", ""), ",")
CORS_ALLOWED_ORIGINS = [
    origin.strip().rstrip("/")
    for origin in _raw_allowed_origins
    if origin.strip() and "@" not in origin
]
CORS_ALLOWED_ORIGIN_REGEXES = [
    r"^https?://localhost(?::\d+)?$",
    r"^https?://127\.0\.0\.1(?::\d+)?$",
    r"^https?://0\.0\.0\.0(?::\d+)?$",
    r"^https?://192\.168\.\d{1,3}\.\d{1,3}(?::\d+)?$"
]

CSRF_COOKIE_NAME = "csrftoken"
CSRF_TRUSTED_ORIGINS = CORS_ALLOWED_ORIGINS +CORS_ALLOWED_ORIGIN_REGEXES
CORS_ALLOW_CREDENTIALS = True
# CSRF_USE_SESSIONS = True

DEFAULT_AUTO_FIELD = "django.db.models.AutoField"

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = os.getenv("REDIS_PORT", "6379")
REDIS_PASSWORD = os.getenv("REDIS_PASSWORD", "")
REDIS_AUTH = f":{REDIS_PASSWORD}@" if REDIS_PASSWORD else ""
REDIS_URL = f"redis://{REDIS_AUTH}{REDIS_HOST}:{REDIS_PORT}/1"

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [REDIS_URL],
        },
    },
}

CACHES = {
    "default": {
        "BACKEND": "django_redis.cache.RedisCache",
        "LOCATION": REDIS_URL,
        "OPTIONS": {
            "CLIENT_CLASS": "django_redis.client.DefaultClient",
        }
    }
}

# Internationalization
# https://docs.djangoproject.com/en/4.2/topics/i18n/

LANGUAGE_CODE = "de-DE"
TIME_ZONE = "Europe/Berlin"
USE_TZ = False
USE_I18N = False
USE_L10N = False

# Static files (CSS, JavaScript, Images)
# https://docs.djangoproject.com/en/4.2/howto/static-files/

STATIC_ROOT = os.path.join(BASE_DIR, "static")
STATIC_URL = "/static/"

MEDIA_ROOT = os.path.join(BASE_DIR, "media")
MEDIA_HIDDEN = os.path.join(BASE_DIR, "media", "hidden")
MEDIA_URL = "/media/"

# When set (e.g. "/protected-media"), AuthenticatedMediaView hands file
# downloads to nginx via X-Accel-Redirect instead of streaming them through
# Python - required for very large files (backups > 1GB). The nginx location
# must be `internal` so authentication stays enforced. Empty = serve through
# Django (dev / non-nginx deployments).
MEDIA_X_ACCEL = os.getenv("MEDIA_X_ACCEL", "").strip()

BACKUP_DIR = os.path.join(MEDIA_ROOT, os.getenv("BACKUP_DIR", "backup"))
# Daily copy of the dumps to a backup server over SFTP (helper/backup_transfer.py,
# run by the cron job daily.sh right after the dumps). Empty host = off.
BACKUP_REMOTE_HOST = os.getenv("BACKUP_REMOTE_HOST", "").strip()
BACKUP_REMOTE_PORT = int(os.getenv("BACKUP_REMOTE_PORT", "") or 22)
BACKUP_REMOTE_USER = os.getenv("BACKUP_REMOTE_USER", "").strip()
BACKUP_REMOTE_PASSWORD = os.getenv("BACKUP_REMOTE_PASSWORD", "")
BACKUP_REMOTE_KEY_FILE = os.getenv("BACKUP_REMOTE_KEY_FILE", "").strip() or "/etc/progeo/backup/id_ed25519"
BACKUP_REMOTE_HOST_KEY = os.getenv("BACKUP_REMOTE_HOST_KEY", "").strip()
BACKUP_REMOTE_PATH = os.getenv("BACKUP_REMOTE_PATH", "").strip() or "progeo-backups"
BACKUP_REMOTE_KEEP = int(os.getenv("BACKUP_REMOTE_KEEP", "") or 14)
# OpenPGP public key(s) every bundle is encrypted for - required, nothing is sent
# unencrypted. The private key never belongs on this host.
BACKUP_REMOTE_GPG_KEY_FILE = (os.getenv("BACKUP_REMOTE_GPG_KEY_FILE", "").strip()
                              or "/etc/progeo/backup/backup-public-key.asc")
# LIVE server: the same bundle, encrypted for the staging server's own key, to the
# staging server (`transfer_backups --target staging`, daily.sh). Empty host = off.
STAGING_REMOTE_HOST = os.getenv("STAGING_REMOTE_HOST", "").strip()
STAGING_REMOTE_PORT = int(os.getenv("STAGING_REMOTE_PORT", "") or 22)
STAGING_REMOTE_USER = os.getenv("STAGING_REMOTE_USER", "").strip()
STAGING_REMOTE_PASSWORD = os.getenv("STAGING_REMOTE_PASSWORD", "")
STAGING_REMOTE_KEY_FILE = os.getenv("STAGING_REMOTE_KEY_FILE", "").strip() or BACKUP_REMOTE_KEY_FILE
STAGING_REMOTE_HOST_KEY = os.getenv("STAGING_REMOTE_HOST_KEY", "").strip()
STAGING_REMOTE_PATH = os.getenv("STAGING_REMOTE_PATH", "").strip() or "detection-docker-setup/media/staging"
STAGING_REMOTE_KEEP = int(os.getenv("STAGING_REMOTE_KEEP", "") or 2)
STAGING_REMOTE_GPG_KEY_FILE = (os.getenv("STAGING_REMOTE_GPG_KEY_FILE", "").strip()
                               or "/etc/progeo/backup/staging-public-key.asc")
# STAGING server: where the live server's bundles arrive (`import_live_backup`) and
# the private key that opens them - this key opens staging bundles only.
STAGING_IMPORT_DIR = os.path.join(MEDIA_ROOT, os.getenv("STAGING_IMPORT_DIR", "staging"))
STAGING_IMPORT_GPG_KEY_FILE = (os.getenv("STAGING_IMPORT_GPG_KEY_FILE", "").strip()
                               or "/etc/progeo/backup/staging-private-key.asc")
STAGING_IMPORT_GPG_PASSPHRASE = os.getenv("STAGING_IMPORT_GPG_PASSPHRASE", "")
SETUP_DIR = os.path.join(MEDIA_ROOT, os.getenv("SETUP_DIR", "setup"))
UPLOAD_DIR = os.path.join(MEDIA_ROOT, os.getenv("UPLOAD_DIR", "uploads"))
UPLOAD_REL_DIR = os.path.join(MEDIA_URL, os.getenv("UPLOAD_DIR", "uploads"))[1:]
EXPORT_DIR = os.path.join(MEDIA_ROOT, os.getenv("EXPORT_DIR", "export"))
STONKS_DIR = os.path.join(MEDIA_ROOT, os.getenv("STONKS_DIR", "stonks"))

dyn_backups = {}
for db in DJANGO_DATABASES:
    dyn_backups.update({db: {
        "USER": os.getenv("POSTGRES_USER"),
        "PASSWORD": os.getenv("POSTGRES_PASSWORD"),
        "HOST": os.getenv("POSTGRES_HOST"),
        "CONNECTOR": "progeo.dbbackup_connector.RestrictSafePgDumpConnector"
    }})


STORAGES = {
    "default": {
        "BACKEND": "django.core.files.storage.FileSystemStorage",
    },
    "dbbackup": {
        "BACKEND": "django.core.files.storage.FileSystemStorage",
        "OPTIONS": {
            "location": BACKUP_DIR,
        },
    },
    "staticfiles": {
        "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage",
    },
}

# Dumps kept per database (handle_all_dbs / backup_transfer.clean_old_dumps).
DBBACKUP_CLEANUP_KEEP = int(os.getenv("DBBACKUP_CLEANUP_KEEP", "") or 10)

DBBACKUP_CONNECTORS = {
    "default": {
        "USER": os.getenv("POSTGRES_USER"),
        "PASSWORD": os.getenv("POSTGRES_PASSWORD"),
        "HOST": os.getenv("POSTGRES_HOST"),
        "CONNECTOR": "progeo.dbbackup_connector.RestrictSafePgDumpConnector"
    },
    **dyn_backups
}

# Security
# python manage.py check --deploy

if os.getenv("SECURE_PROXY_SSL_HEADER"):
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# The legacy GPRS controllers speak plain HTTP and follow no redirects, so
# their endpoint must never be redirected to https (SECURE_SSL_REDIRECT).
SECURE_REDIRECT_EXEMPT = [r"^gprs_\d+\.php$"]

SECURE_REFERRER_POLICY = os.getenv("SECURE_REFERRER_POLICY")
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = parse_boolean(os.getenv("SESSION_COOKIE_SECURE", "False"))
CSRF_COOKIE_SECURE = parse_boolean(os.getenv("CSRF_COOKIE_SECURE", "False"))
SECURE_HSTS_SECONDS = parse_int(os.getenv("SECURE_HSTS_SECONDS", "0"))
SECURE_HSTS_PRELOAD = parse_boolean(os.getenv("SECURE_HSTS_PRELOAD", "False"))
SECURE_SSL_REDIRECT = parse_boolean(os.getenv("SECURE_SSL_REDIRECT", "False"))
SECURE_SSL_HOST = os.getenv("SECURE_SSL_HOST")
SECURE_HSTS_INCLUDE_SUBDOMAINS = True

X_FRAME_OPTIONS = "DENY"

# Additional security settings
SECURE_BROWSER_XSS_FILTER = True
SECURE_CONTENT_TYPE_NOSNIFF = True

DATA_UPLOAD_MAX_MEMORY_SIZE = 25 * 1024 * 1024  # 25MB
DATA_UPLOAD_MAX_NUMBER_FIELDS = 5000

SHOW_LAST_TAGS = 25

TIME_CALC_OFFSET = parse_int(os.getenv("TIME_CALC_OFFSET", "0"))

# Log directory shared by all backend processes (bind-mounted to ./logs/backend in docker).
# Falls back to the repo's logs/backend when /var/log/progeo doesn't exist (local dev).
LOG_DIR = os.getenv("LOG_DIR", "/var/log/progeo")
if not (os.path.isdir(LOG_DIR) and os.access(LOG_DIR, os.W_OK)):
    LOG_DIR = os.path.join(BASE_DIR, "logs", "backend")

# stdout -> backend.log (INFO), stderr -> backend.err.log (WARNING+: 4xx/5xx requests, exceptions, security).
# Supervisor splits the two streams; see docker/backend/supervisord.conf.
# errors.jsonl: WARNING+ of every process (web, celery, cron commands, elog/wlog) as JSON lines,
# size-rotated and kept across container restarts.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {
        "below_warning": {
            "()": "progeo.logging.BelowWarningFilter",
        },
        "sanitize_url": {
            "()": "progeo.logging.SanitizeURLFilter",
        },
        "skip_client_errors": {
            "()": "progeo.logging.SkipClientErrorsFilter",
        },
    },
    "formatters": {
        "default": {
            "format": "[%(asctime)s] [%(levelname)s] [%(name)s] %(cleaned_path)s %(message)s",
            "datefmt": "%Y-%m-%d %H:%M:%S",
        },
        "json": {
            "()": "progeo.logging.JsonFormatter",
        },
    },
    "handlers": {
        "stdout": {
            "level": "INFO",
            "class": "logging.StreamHandler",
            "stream": "ext://sys.stdout",
            "formatter": "default",
            "filters": ["below_warning", "sanitize_url"],
        },
        "stderr": {
            "level": "WARNING",
            "class": "logging.StreamHandler",
            "stream": "ext://sys.stderr",
            "formatter": "default",
            "filters": ["sanitize_url"],
        },
        "errors_file": {
            "level": "WARNING",
            "class": "progeo.logging.SharedRotatingFileHandler",
            "filename": os.path.join(LOG_DIR, "errors.jsonl"),
            "max_bytes": 10 * 1024 * 1024,
            "backup_count": 5,
            "formatter": "json",
            "filters": ["sanitize_url", "skip_client_errors"],
        },
    },
    "root": {
        "handlers": ["stdout", "stderr", "errors_file"],
        "level": "INFO",
    },
    "loggers": {
        # elog/wlog/flog/ilog (progeo.helper.basics) already print to the console themselves;
        # their records only feed errors.jsonl and Sentry (breadcrumbs from INFO, events from ERROR).
        "progeo.console": {
            "handlers": ["errors_file"],
            "level": "INFO",
            "propagate": False,
        },
        # Django's defaults only print to the console when DEBUG=True; route through root instead.
        "django": {
            "handlers": [],
            "level": "INFO",
            "propagate": True,
        },
        "django.server": {
            "handlers": [],
            "level": "INFO",
            "propagate": True,
        },
    },
}

# Error tracking via sentry-sdk (GlitchTip on the main online system) - no-op unless SENTRY_DSN is set.
if PROGEO_CONFIG_IS_ROOT_SERVER:
    _server_role = "root"
elif PROGEO_CONFIG_IS_NODE_SERVER:
    _server_role = "node"
else:
    _server_role = "standalone"
init_sentry(server_role=_server_role)
