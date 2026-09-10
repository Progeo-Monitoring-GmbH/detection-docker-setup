from django.contrib.auth import get_user_model
from django.contrib.auth.backends import ModelBackend
from django.db.models import Q
from django.utils.translation import gettext_lazy as _
from rest_framework import exceptions
from rest_framework.authentication import BaseAuthentication, get_authorization_header

from progeo.v1.models import LimitedToken


class CaseInsensitiveUsernameOrEmailBackend(ModelBackend):
    """Allows login with the username or email, case-insensitively."""

    def authenticate(self, request, username=None, password=None, **kwargs):
        UserModel = get_user_model()
        if username is None:
            username = kwargs.get(UserModel.USERNAME_FIELD)
        if username is None or password is None:
            return None

        user = (
            UserModel.objects.filter(
                Q(username__iexact=username) | Q(email__iexact=username)
            )
            .order_by("id")
            .first()
        )
        if user is None:
            # Run the default password hasher to mitigate user enumeration
            # via timing attacks (same behavior as ModelBackend).
            UserModel().set_password(password)
            return None

        if user.check_password(password) and self.user_can_authenticate(user):
            return user
        return None


class LimitedTokenAuthentication(BaseAuthentication):
    """
    Simple token based authentication.

    Clients should authenticate by passing the token raw_hash in the "Authorization"
    HTTP header, prepended with the string "Token ".  For example:

        Authorization: Token 401f7ac837da42b97f613d789819ff93537bee6a
    """

    keyword = "Token"
    model = LimitedToken

    def get_model(self):
        if self.model is not None:
            return self.model
        return LimitedToken

    """
    A custom token model may be used, but must have the following properties.

    * raw_hash -- The string identifying the token
    * user -- The user to which the token belongs
    """

    def authenticate(self, request):
        auth = get_authorization_header(request).split()

        if not auth or auth[0].lower() != self.keyword.lower().encode():
            # Support legacy device calls using ?token=<raw_hash>.
            token = request.query_params.get("token")
            if not token:
                return None
            return self.authenticate_credentials(request, token)

        if len(auth) == 1:
            msg = _("Invalid token header. No credentials provided.")
            raise exceptions.AuthenticationFailed(msg)
        elif len(auth) > 2:
            msg = _("Invalid token header. Token string should not contain spaces.")
            raise exceptions.AuthenticationFailed(msg)

        try:
            token = auth[1].decode()
        except UnicodeError:
            msg = _("Invalid token header. Token string should not contain invalid characters.")
            raise exceptions.AuthenticationFailed(msg)

        return self.authenticate_credentials(request, token)

    def authenticate_credentials(self, request, key):
        model = self.get_model()
        account = getattr(request, "account", None)
        using = account.db_name if account and getattr(account, "db_name", None) else "default"
        try:
            token = model.objects.using(using).select_related("user").get(raw_hash=key)
        except model.DoesNotExist:
            raise exceptions.AuthenticationFailed(_("Invalid token."))

        if not token.user.is_active:
            raise exceptions.AuthenticationFailed(_("User inactive or deleted."))

        return (token.user, token)

    def authenticate_header(self, request):
        return self.keyword
