"""
Django settings for progeo project.
"""
from datetime import timedelta
import os

from pathlib import Path
from progeo.v1.helper import parse_int, parse_boolean, parse_split_str
from progeo.helper.basics import flog, read_env

BASE_DIR = Path(__file__).resolve(strict=True).parent.parent

ENV_FILE_PATH = os.path.join(BASE_DIR, "django.env")
read_env(ENV_FILE_PATH)

# SECURITY WARNING: keep the secret key used in production secret!
SECRET_KEY = os.getenv("SECRET_KEY")

# SECURITY WARNING: don't run with debug turned on in production!
DEBUG = parse_boolean(os.getenv("DEBUG"))

ALLOWED_HOSTS = [os.getenv("DJANGO_ALLOWED_HOSTS")]

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
        "rest_framework.authentication.SessionAuthentication",
        "rest_framework.authentication.TokenAuthentication",
        "rest_framework.authentication.BasicAuthentication",
        "rest_framework_simplejwt.authentication.JWTAuthentication",
        "progeo.authentication.LimitedTokenAuthentication",
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
        "DIRS": [],
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

dyn_dbs = {}
for db in DJANGO_DATABASES:
    dyn_dbs.update({db: {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": db,
        "USER": os.getenv("POSTGRES_USER"),
        "PASSWORD": os.getenv("POSTGRES_PASSWORD"),
        "HOST": os.getenv("POSTGRES_HOST"),
        "PORT": os.getenv("POSTGRES_PORT"),
    }})

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.getenv("POSTGRES_DB"),
        "USER": os.getenv("POSTGRES_USER"),
        "PASSWORD": os.getenv("POSTGRES_PASSWORD"),
        "HOST": os.getenv("POSTGRES_HOST"),
        "PORT": os.getenv("POSTGRES_PORT"),
    },
    **dyn_dbs
}

DATABASE_ROUTERS = [
    "progeo.router.DjangoRouter",
    "progeo.router.AccountRouter",
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
CORS_ALLOWED_ORIGINS = parse_split_str(os.getenv("ALLOWED_ORIGINS", ""), ",")
CSRF_COOKIE_NAME = "csrftoken"
CSRF_TRUSTED_ORIGINS = CORS_ALLOWED_ORIGINS
CORS_ALLOW_CREDENTIALS = True
# CSRF_USE_SESSIONS = True

DEFAULT_AUTO_FIELD = "django.db.models.AutoField"

REDIS_URL = f"redis://{os.getenv('REDIS_HOST')}:{os.getenv('REDIS_PORT', 6379)}/1"

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [(os.getenv("REDIS_HOST"), os.getenv("REDIS_PORT", 6379))],
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

BACKUP_DIR = os.path.join(MEDIA_ROOT, os.getenv("BACKUP_DIR", "backup"))
SETUP_DIR = os.path.join(MEDIA_ROOT, os.getenv("SETUP_DIR", "setup"))
UPLOAD_DIR = os.path.join(MEDIA_ROOT, os.getenv("UPLOAD_DIR", "uploads"))
UPLOAD_BASE_DIR = os.path.join(MEDIA_URL, os.getenv("UPLOAD_DIR", "uploads"))[1:]
EXPORT_DIR = os.path.join(MEDIA_ROOT, os.getenv("EXPORT_DIR", "export"))
STONKS_DIR = os.path.join(MEDIA_ROOT, os.getenv("STONKS_DIR", "stonks"))

dyn_backups = {}
for db in DJANGO_DATABASES:
    dyn_backups.update({db: {
        "USER": os.getenv("POSTGRES_USER"),
        "PASSWORD": os.getenv("POSTGRES_PASSWORD"),
        "HOST": os.getenv("POSTGRES_HOST"),
        "CONNECTOR": "dbbackup.db.postgresql.PgDumpConnector"
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

DBBACKUP_CONNECTORS = {
    "default": {
        "USER": os.getenv("POSTGRES_USER"),
        "PASSWORD": os.getenv("POSTGRES_PASSWORD"),
        "HOST": os.getenv("POSTGRES_HOST"),
        "CONNECTOR": "dbbackup.db.postgresql.PgDumpConnector"
    },
    **dyn_backups
}

# Security
# python manage.py check --deploy

if os.getenv("SECURE_PROXY_SSL_HEADER"):
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

if os.getenv("SECURE_REDIRECT_EXEMPT"):
    SECURE_REDIRECT_EXEMPT = []

SECURE_REFERRER_POLICY = os.getenv("SECURE_REFERRER_POLICY")
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = parse_boolean(os.getenv("SESSION_COOKIE_SECURE", False))
CSRF_COOKIE_SECURE = parse_boolean(os.getenv("CSRF_COOKIE_SECURE", False))
SECURE_HSTS_SECONDS = parse_int(os.getenv("SECURE_HSTS_SECONDS", 0))
SECURE_HSTS_PRELOAD = parse_boolean(os.getenv("SECURE_HSTS_PRELOAD", False))
SECURE_SSL_REDIRECT = parse_boolean(os.getenv("SECURE_SSL_REDIRECT", False))
SECURE_SSL_HOST = os.getenv("SECURE_SSL_HOST")
SECURE_HSTS_INCLUDE_SUBDOMAINS = True

X_FRAME_OPTIONS = "DENY"

# Additional security settings
SECURE_BROWSER_XSS_FILTER = True
SECURE_CONTENT_TYPE_NOSNIFF = True

DATA_UPLOAD_MAX_MEMORY_SIZE = 25 * 1024 * 1024  # 25MB
DATA_UPLOAD_MAX_NUMBER_FIELDS = 5000

SHOW_LAST_TAGS = 25

TIME_CALC_OFFSET = parse_int(os.getenv("TIME_CALC_OFFSET", 0))
