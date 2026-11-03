"""The portal as OpenID Connect provider for the Matrix Authentication Service
(progeo/oidc.py) and the Matrix names of portal users
(helper/matrix_accounts.py)."""
import base64
import hashlib
import json
import secrets
from urllib.parse import parse_qs, urlparse

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from jwcrypto import jwk, jwt

from progeo.helper.matrix_accounts import MAS_PROVIDER_ID, matrix_localpart
from progeo.tests import factories as f

ISSUER = "https://dashboard.progeo.com/auth/oidc"
REDIRECT = f"https://auth.matrix.progeo.com/upstream/callback/{MAS_PROVIDER_ID}"
SECRET = "client-secret-for-tests"


@pytest.fixture(autouse=True)
def no_debug_toolbar(monkeypatch):
    """With DEBUG the toolbar's redirect panel replaces every 302 by a page."""
    monkeypatch.setattr("progeo.debug.DEBUG", False)


@pytest.fixture
def mas_client(monkeypatch):
    """The MAS client as `manage.py matrix_oidc_client` registers it."""
    monkeypatch.setenv("MATRIX_OIDC_CLIENT_SECRET", SECRET)
    call_command("matrix_oidc_client")


def _pkce():
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def _authorize(client, challenge=None, **extra):
    params = {"response_type": "code", "client_id": "progeo-matrix", "redirect_uri": REDIRECT,
              "scope": "openid profile", "state": "st4te", "nonce": "n0nce", **extra}
    if challenge:
        params.update(code_challenge=challenge, code_challenge_method="S256")
    return client.get("/auth/oidc/authorize/", params)


# -- Matrix names ------------------------------------------------------------

@pytest.mark.parametrize("username, expected", [
    ("lea.localpart-test", "lea.localpart-test"),
    # Other users may be called "lea.localpart-test2": a suffix keeps them apart.
    ("Lea.Localpart-Test2", "lea.localpart-test2={pk}"),
    ("lea@localpart-test.de", "lea_localpart-test.de={pk}"),
    ("progeo-bot", "progeo-bot={pk}"),
    ("signal_localpart_test", "signal_localpart_test={pk}"),
])
def test_matrix_localpart_is_valid_and_unique(username, expected):
    user = f.make_user(username=username)
    assert matrix_localpart(user) == expected.format(pk=user.pk)


# -- discovery ---------------------------------------------------------------

def test_discovery_names_the_issuer_and_pkce(client):
    data = client.get("/auth/oidc/.well-known/openid-configuration").json()

    assert data["issuer"] == ISSUER
    assert data["authorization_endpoint"] == "https://dashboard.progeo.com/auth/oidc/authorize/"
    assert data["token_endpoint"] == "https://dashboard.progeo.com/auth/oidc/token/"
    assert "S256" in data["code_challenge_methods_supported"]
    keys = client.get("/auth/oidc/.well-known/jwks.json").json()["keys"]
    assert keys and keys[0]["kty"] == "RSA"


def test_application_management_is_not_routed(client):
    client.force_login(f.make_user())
    assert client.get("/auth/oidc/applications/").status_code == 404


# -- authorization -----------------------------------------------------------

def test_without_a_portal_session_the_portal_login_comes_first(client, mas_client):
    _verifier, challenge = _pkce()

    response = _authorize(client, challenge, login_hint="kai")

    assert response.status_code == 302
    target = urlparse(response["Location"])
    assert target.path == "/login"
    forward = parse_qs(target.query)["forward"][0]
    assert forward.startswith("/auth/oidc/authorize/?") and "login_hint=kai" in forward


def test_code_flow_with_pkce_signs_the_user_in(client, mas_client):
    user = f.make_user(username="kai.mueller", first_name="Kai", last_name="Müller")
    client.force_login(user)
    verifier, challenge = _pkce()

    response = _authorize(client, challenge)

    assert response.status_code == 302, response.content
    redirect = urlparse(response["Location"])
    assert f"{redirect.scheme}://{redirect.netloc}{redirect.path}" == REDIRECT
    query = parse_qs(redirect.query)
    assert query["state"] == ["st4te"]

    client.logout()  # MAS calls the token endpoint itself, without a session
    basic = base64.b64encode(f"progeo-matrix:{SECRET}".encode()).decode()
    token = client.post("/auth/oidc/token/", {
        "grant_type": "authorization_code", "code": query["code"][0], "redirect_uri": REDIRECT,
        "code_verifier": verifier,
    }, HTTP_AUTHORIZATION=f"Basic {basic}")
    assert token.status_code == 200, token.content

    keys = jwk.JWKSet.from_json(json.dumps(client.get("/auth/oidc/.well-known/jwks.json").json()))
    claims = json.loads(jwt.JWT(jwt=token.json()["id_token"], key=keys).claims)
    assert claims["iss"] == ISSUER
    assert claims["aud"] == "progeo-matrix"
    assert claims["sub"] == str(user.pk)
    assert claims["nonce"] == "n0nce"
    assert claims["preferred_username"] == "kai.mueller"
    assert claims["name"] == "Kai Müller"


def test_pkce_is_required(client, mas_client):
    client.force_login(f.make_user())

    response = _authorize(client)

    assert response.status_code == 302
    assert "error=invalid_request" in response["Location"]


def test_wrong_secret_gets_no_token(client, mas_client):
    client.force_login(f.make_user())
    verifier, challenge = _pkce()
    code = parse_qs(urlparse(_authorize(client, challenge)["Location"]).query)["code"][0]
    basic = base64.b64encode(b"progeo-matrix:wrong").decode()

    response = client.post("/auth/oidc/token/", {"grant_type": "authorization_code", "code": code,
                                                 "redirect_uri": REDIRECT, "code_verifier": verifier},
                           HTTP_AUTHORIZATION=f"Basic {basic}")

    assert response.status_code == 401


def test_foreign_redirect_uris_are_refused(client, mas_client):
    client.force_login(f.make_user())
    _verifier, challenge = _pkce()

    response = _authorize(client, challenge, redirect_uri="https://evil.example/callback")

    assert response.status_code == 400


@pytest.mark.parametrize("kind", ["demo", "pending"])
def test_demo_and_pending_users_get_no_chat(client, mas_client, monkeypatch, kind):
    from progeo.helper.demo import DEMO_PERMISSION

    if kind == "demo":
        user = f.make_user(perms=(DEMO_PERMISSION,))
    else:
        user = f.make_user()
        pending = user.pk
        monkeypatch.setattr("progeo.helper.access_requests.is_pending_user",
                            lambda candidate: getattr(candidate, "pk", candidate) == pending)
    client.force_login(user)
    _verifier, challenge = _pkce()

    assert _authorize(client, challenge).status_code == 403


def test_client_command_needs_its_secret(monkeypatch):
    monkeypatch.delenv("MATRIX_OIDC_CLIENT_SECRET", raising=False)

    with pytest.raises(CommandError, match="MATRIX_OIDC_CLIENT_SECRET"):
        call_command("matrix_oidc_client")


def test_oauth_tables_stay_out_of_project_databases(settings):
    from django.db import router

    from progeo.helper.project_dbs import project_alias, template_alias

    assert router.allow_migrate("default", "oauth2_provider") is True
    assert router.allow_migrate("unit_tests", "oauth2_provider") is True
    for alias in (project_alias(4711), template_alias(), settings.DEMO_DATABASE):
        assert router.allow_migrate(alias, "oauth2_provider") is False
    assert router.allow_migrate(project_alias(4711), "progeo") is True


def test_a_chat_login_is_remembered_and_confirmed(client, mas_client, api_client):
    from progeo.v1.models import UserProfile

    user = f.make_user()
    api_client.force_authenticate(user=user)
    assert api_client.get("/v1/user/matrix/").json()["connected_at"] is None

    client.force_login(user)
    verifier, challenge = _pkce()
    code = parse_qs(urlparse(_authorize(client, challenge)["Location"]).query)["code"][0]
    client.logout()
    basic = base64.b64encode(f"progeo-matrix:{SECRET}".encode()).decode()
    assert client.post("/auth/oidc/token/", {"grant_type": "authorization_code", "code": code,
                                             "redirect_uri": REDIRECT, "code_verifier": verifier},
                       HTTP_AUTHORIZATION=f"Basic {basic}").status_code == 200

    connected = UserProfile.objects.using(f.DB).get(user_id=user.pk).matrix_connected_at
    assert connected is not None
    user.refresh_from_db()
    assert api_client.get("/v1/user/matrix/").json()["connected_at"] is not None
    # A profile that only holds the connection is not "empty".
    assert not UserProfile.objects.using(f.DB).get(user_id=user.pk).is_empty()
