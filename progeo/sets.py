from rest_framework.authtoken.admin import User
from rest_framework.authtoken.models import Token
from progeo.v1.models import Account

DJANGO_MODELS = [
    (User, "auth_user"),
    (Account, "progeo_account"),
    (Token, "authtoken_token"),
]
