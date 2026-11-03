# ProGeo chat: Matrix server (compose profile `messenger`)

Our own Matrix server on `matrix.progeo.com`. **Every portal user can use it with their ProGeo
login**: the chat apps sign in through the portal, and the account (`@<name>:matrix.progeo.com`) is
created on the first login. Mein Konto shows the user's Matrix ID and a QR code that opens Element X
with our server preset.

The backend sends Matrix notifications through a bot account. **Signal notifications go through
Matrix too**: a Signal bridge linked to ProGeo's Signal number. WhatsApp stays on Meta's official
Cloud API (a bridge would use a normal WhatsApp account, and automated messages to non-contacts get
numbers banned).

| Container | Purpose |
| --- | --- |
| `progeo-matrix` | Synapse, the homeserver. `entrypoint.sh` writes `homeserver.yaml` from `.env` on every start. |
| `progeo-mas` | Matrix Authentication Service on `MATRIX_AUTH_DOMAIN`: logins and accounts. Its only login is the portal (OpenID Connect, `progeo/oidc.py`); it has no passwords of its own. |
| `progeo-matrix-db` | Postgres for Synapse and MAS (C collation), only in the internal `matrix_db_net`. |
| `progeo-signal-bridge` | mautrix-signal. Its only user is the bot, linked to ProGeo's Signal number. |
| `progeo-matrix-init`, `progeo-signal-bridge-init` | One-shot, before the others on every `docker compose up`: MAS's config, signing key and database (`mas_init.py`), the bridge's config and appservice registration (`signal_bridge_init.sh`). |

## How a login works

1. The user scans the QR code in Mein Konto. It holds Element's provisioning link
   (`https://mobile.element.io/element?account_provider=matrix.progeo.com&login_hint=<name>`) and
   opens Element X, or its store page, with our server preset.
2. Element asks MAS, and MAS asks the portal (`/auth/oidc/authorize/`).
3. Without a portal session, the portal's login page comes first: password, then 2FA if the user has
   it. The name is filled in from the link.
4. The portal returns the user to MAS. On the first login MAS creates the account; the name comes
   from `matrix_localpart()`: the username, or a cleaned-up version of it with a `=<id>` suffix.
5. Back in the app.

The public demo user and users with a pending access request get no chat.

## What is public

| Path | Public | Why |
| --- | --- | --- |
| `matrix.progeo.com/_matrix/client/…` | yes | The client API. `/_matrix/client/versions` answers without a login on every Matrix server. Everything else needs a token. |
| `…/login`, `…/logout`, `…/refresh`, `…/register` | rate limited | 10 per minute and address. Login, logout and refresh go to MAS; registration is closed. |
| `matrix.progeo.com/.well-known/matrix/client` | yes | Names the homeserver and MAS. |
| `auth.matrix.progeo.com/…` | yes | MAS's login pages and OAuth endpoints. |
| `dashboard.progeo.com/auth/oidc/…` | yes | The portal as OpenID Connect provider, with a single client (MAS). The application management pages are not routed. |
| federation, `/_matrix/key/…`, `/.well-known/matrix/server` | only with `MATRIX_FEDERATION=1` | Off by default: only `@name:matrix.progeo.com` accounts. |
| `/_synapse/admin/…`, `/_synapse/client/…`, `/_matrix/media/…` | no | Admin work runs inside the containers. Media go through the authenticated client API. |
| the bridge (`progeo-signal-bridge:29328`) | no | Only Synapse and the backend reach it, with a shared secret. Only the bot may use it. |

Synapse itself has no guests, no identity-server lookups, no public room list, no aliases, no link
previews, no dynamic thumbnails and no metrics. Profiles and the user directory are only visible to
users who share a room. All containers run with `no-new-privileges` and only the capabilities they
need to switch to their own user. MAS needs none.

Messages of the bot are **not end-to-end encrypted** (the server can read them). Users' own chats in
Element are encrypted.

## Setup

1. **DNS:** two CNAMEs to the host the other names already point to:

   ```text
   matrix.progeo.com.        3600   IN   CNAME   api.progeo.com.
   auth.matrix.progeo.com.   3600   IN   CNAME   api.progeo.com.
   ```

2. **Certificate:** all server blocks share one certificate. Add both names, and put the
   certificate's current first domain first (`sudo certbot certificates`):

   ```sh
   sudo bash scripts/setup_certbot.sh admin@progeo.com api.progeo.com dashboard.progeo.com \
       matrix.progeo.com auth.matrix.progeo.com
   ```

3. **Portal signing key** (OpenID Connect): `openssl genrsa -out secrets/oidc/private.pem 4096`. The
   backend reads it from `/etc/progeo/oidc/private.pem`.

4. **`.env`** (see `.env.template`, section Messenger):
   - `MATRIX_DOMAIN=matrix.progeo.com` and `MATRIX_AUTH_DOMAIN=auth.matrix.progeo.com`
   - `PORTAL_OIDC_ISSUER=https://dashboard.progeo.com/auth/oidc`
   - every secret generated with `openssl rand -hex 32`. Never change `MATRIX_MAS_ENCRYPTION` after
     the first start: it encrypts data in MAS's database.
   - `messenger` added to `COMPOSE_PROFILES`.

   `MATRIX_DOMAIN` becomes part of every Matrix ID. Never change it once users exist.

5. **Start:** `docker compose up -d`, then `docker compose up -d --force-recreate progeo-nginx
   progeo-backend` (both read the new variables only at start).

6. **Register MAS at the portal** (after `migrate`, once and whenever the secret changes):
   `docker compose exec progeo-backend python manage.py matrix_oidc_client`

7. **Bot account for the backend:**

   ```sh
   docker compose exec progeo-mas mas-cli manage register-user --config /mas/config.yaml --yes progeo-bot
   docker compose exec progeo-mas mas-cli manage issue-compatibility-token --config /mas/config.yaml progeo-bot
   ```

   Enter the token (`mct_…`) under Schnittstelle → Matrix. The homeserver stays
   `http://progeo-matrix:8008`: the backend talks to the container directly.

8. **Link ProGeo's Signal number:** Schnittstelle → Signal → "Link Signal number". Scan the QR code
   with ProGeo's phone in Signal (Settings → Linked devices → Link new device).

MAS fetches the portal's OpenID configuration from `PORTAL_OIDC_ISSUER`, so the server must reach its
own public URL. It usually can. If not, add the dashboard name to the server's `/etc/hosts`.

### Coming from the first setup (Synapse with its own passwords)

Accounts created with `register_new_matrix_user` don't exist in MAS. With only test accounts, start
over: `docker compose down`, `docker volume rm detection-docker-setup_matrix_data
detection-docker-setup_matrix_db_data`, then the setup above. `MATRIX_REGISTRATION_SECRET` is no
longer used.

## Backups

The volumes `matrix_data` (Synapse's signing key, media), `matrix_db_data` (Synapse and MAS),
`mas_data` (MAS config and signing key) and `signal_bridge_data` (the bridge's Signal session) are
**not** part of the ProGeo backups. Without `signal_bridge_data` the Signal number has to be linked
again.
