# Matrix homeserver (compose profile `messenger`)

Our own [Synapse](https://element-hq.github.io/synapse/) on `matrix.progeo.com`. The backend sends
Matrix notifications through a bot account on it (`progeo/helper/messenger.py`). Users either get
an account here or keep their own account on any other homeserver (federation).

| Container | Purpose |
| --- | --- |
| `progeo-matrix` | Synapse, plain HTTP on port 8008 in `default_net`. `entrypoint.sh` writes `homeserver.yaml` from `.env` on every start. |
| `progeo-matrix-db` | Synapse's own Postgres (C collation), only in the internal `matrix_db_net`. |
| `progeo-signal` | The Signal gateway, in the same profile. |

`progeo-nginx` terminates TLS for clients and federation, both on 443. It also serves
`/.well-known/matrix/server` and `/.well-known/matrix/client`, so port 8448 and an SRV record are not
needed. The admin API (`/_synapse/admin`) is not reachable from outside.

## Setup

1. **DNS:** add a CNAME to the host the other names already point to:

   ```
   matrix.progeo.com.   3600   IN   CNAME   api.progeo.com.
   ```

   Check it with `dig +short matrix.progeo.com`. It must return the server's address.

2. **Certificate:** all server blocks share one certificate, so add the name to it. Put the
   certificate's current first domain first, because it decides the directory and thus
   `CERT_PATH`. Check it with `sudo certbot certificates`.

   ```
   sudo bash scripts/setup_certbot.sh admin@progeo.com api.progeo.com dashboard.progeo.com matrix.progeo.com
   ```

3. **`.env`:** set `MATRIX_DOMAIN=matrix.progeo.com`, generate the four secrets with
   `openssl rand -hex 32` and add `messenger` to `COMPOSE_PROFILES`, e.g. `COMPOSE_PROFILES=monitoring,messenger`.
   `MATRIX_DOMAIN` becomes part of every user and room ID. Never change it once users exist.

4. **Start:** `docker compose up -d`. nginx needs a restart too, because it reads `MATRIX_DOMAIN`
   only at start: `docker compose up -d --force-recreate progeo-nginx`.

5. **Check federation:** https://federationtester.matrix.org/#matrix.progeo.com

## Bot account for the backend

```
docker compose exec progeo-matrix register_new_matrix_user -c /data/homeserver.yaml \
    -u progeo-bot --no-admin http://localhost:8008
docker compose exec progeo-backend curl -s -X POST http://progeo-matrix:8008/_matrix/client/v3/login \
    -H 'Content-Type: application/json' \
    -d '{"type": "m.login.password", "identifier": {"type": "m.id.user", "user": "progeo-bot"}, "password": "<password>"}'
```

Enter the `access_token` from the answer under Schnittstelle → Matrix, with homeserver
`http://progeo-matrix:8008`. The backend talks to the container directly, not through nginx. Instead,
`MATRIX_HOMESERVER` / `MATRIX_ACCESS_TOKEN` in `django.env` work until something is saved there.

## User accounts

There is no self sign-up (`enable_registration: false`). Staff create accounts:

```
docker compose exec progeo-matrix register_new_matrix_user -c /data/homeserver.yaml \
    -u <name> --no-admin http://localhost:8008
```

The user logs in with Element (or any Matrix client) on homeserver `matrix.progeo.com` and enters
`@<name>:matrix.progeo.com` as Matrix ID under Mein Konto → Messenger. The first notification arrives
as an invitation from `@progeo-bot:matrix.progeo.com`, which the user has to accept.

## Backups

The volumes `matrix_data` (signing key, media) and `matrix_db_data` are **not** part of the ProGeo
backups. If the signing key is lost, other servers reject ours until their key caches expire.
