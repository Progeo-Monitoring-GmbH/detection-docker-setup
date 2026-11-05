"""django-oauth-toolkit settings for RFC 9700 (OAuth 2.0 Security Best
Current Practice) - the defaults of django-oauth-toolkit 4.0, adopted early.
Shared by progeo/settings.py and progeo/tests/settings.py, so the OIDC tests
run against the production posture."""

OAUTH2_RFC9700 = {
    # RFC 9700 (OAuth 2.0 Security BCP), the defaults of django-oauth-toolkit
    # 4.0. The only client - MAS, confidential, authorization code + PKCE S256,
    # bearer header - uses none of what they switch off.
    "COMPLIANT_BCP_RFC9700_IMPLICIT_GRANT": True,
    "COMPLIANT_BCP_RFC9700_PASSWORD_GRANT": True,
    "COMPLIANT_BCP_RFC9700_PKCE_METHOD": True,  # S256 only, no "plain"
    "COMPLIANT_BCP_RFC9700_ACCESS_TOKEN_TRANSPORT": True,  # no tokens in the query string
    # RFC 9207 `iss` in the authorization response = OIDC_ISS_ENDPOINT, the
    # issuer of the discovery document.
    "COMPLIANT_BCP_RFC9700_AUTHZ_RESPONSE_ISS": True,
    # New tokens are stored as a checksum only; existing ones keep working.
    "COMPLIANT_BCP_RFC9700_TOKEN_STORAGE": True,
    # A replayed refresh token revokes its whole family.
    "REFRESH_TOKEN_REUSE_PROTECTION": True,
    # Config gates: `check --deploy` fails instead of warning should one of
    # these settings ever be weakened (refresh token reuse, http redirect
    # URIs, wildcard redirect URIs, PKCE optional).
    "COMPLIANT_BCP_RFC9700_REFRESH_TOKEN": True,
    "COMPLIANT_BCP_RFC9700_REDIRECT_URI_SCHEME": True,
    "COMPLIANT_BCP_RFC9700_REDIRECT_URI_MATCHING": True,
    "COMPLIANT_BCP_RFC9700_PKCE_REQUIRED": True,
}
