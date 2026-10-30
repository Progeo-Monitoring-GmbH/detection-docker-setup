# Progeo Docker Setup

## TL;DR

Run this in an empty directory on a fresh Ubuntu/Debian host to clone the repo there and prepare the system:

```bash
curl -fsSL https://raw.githubusercontent.com/Progeo-Monitoring-GmbH/detection-docker-setup/main/scripts/install.sh | sudo bash
```

Then edit `.env` and `django.env` and build/start all containers:

```bash
sudo bash scripts/finalize-install.sh
```

Optional: `| sudo BRANCH=<branch> bash` to use another branch. Re-running the installer inside an existing checkout updates it via `git pull`.

## What gets started

`docker compose` runs these services:

- `progeo-database` (PostgreSQL)
- `progeo-redis` (Redis)
- `progeo-backend` (Django API)
- `progeo-frontend` (Frontend)
- `progeo-nginx` (reverse proxy, ports `80` and `443`)

The optional profile `monitoring` adds Prometheus, Grafana, Alertmanager, Flower and exporters (see [docker/monitoring/README.md](docker/monitoring/README.md)).

## 1) Prepare environment files

Required files in project root:

- `.env` (from `.env.template`)
- `django.env` (from `django.env.template`)

Neither file goes into an image (the images are public on Docker Hub). The backend mounts both read-only and reads them when the container starts. After changing them, `docker compose up -d --force-recreate progeo-backend` is enough; no rebuild is needed.

You can prepare system packages and env files with the setup script:

```bash
sudo bash scripts/setup_system.sh
```

The script will:

- install `git` and Docker Compose
- configure UFW to allow only `22`, `80`, `443`
- create `.env` / `django.env` from templates if missing
- replace all `~` placeholders in both env files with random characters

## 2) Build and start containers

```bash
docker compose build
docker compose up -d
```

## 3) Useful commands

```bash
# Follow backend logs
docker logs -f progeo-backend

# Enter backend container
docker exec -it progeo-backend bash

# Stop everything
docker compose down

# Full reset (removes DB container + volume, then rebuilds)
docker rm -f progeo-database
docker volume rm progeo_postgres_data
docker compose down
docker compose build
docker compose up -d

# Reclaim unused Docker disk space
bash scripts/reclaim_docker_space.sh

# Also remove unused volumes
bash scripts/reclaim_docker_space.sh --volumes

# Wired uplink: DHCP first, static fallback from .env (UPLINK_STATIC_*) when no DHCP server answers
sudo bash scripts/setup_uplink_network.sh

# Setup persistent reverse SSH shell tunnel (autossh + systemd)
sudo bash scripts/setup_reverse_ssh_shell.sh --server ubuntu@example.com --remote-port 22022

# Start cad_factory build in background so SSH disconnect does not kill it
bash scripts/build_progeo-cad_factory_resilient.sh start

# Check if background build is still running
bash scripts/build_progeo-cad_factory_resilient.sh status

# Follow background build logs
bash scripts/build_progeo-cad_factory_resilient.sh logs
```

## Backups

Every night at 23:53, the cron job `daily` ([docker/backend/cronjobs/daily.sh](docker/backend/cronjobs/daily.sh)) dumps every database into `media/backup`.
Right after that, `manage.py transfer_backups` sends the newest dump of each database to a backup server over SFTP:

- All dumps go as **one** tar file, `<BACKUP_REMOTE_PATH>/progeo-<YYYY-MM-DD-HHMMSS>.tar.gpg`, together with a `.sha256` file.
  - The tar is **OpenPGP-encrypted** (gpg, AES-256) for the public key(s) in `secrets/backup/backup-public-key.asc` before it leaves the host. Only the matching private key can open it. That key lives neither on this host nor on the backup server.
  - Without a usable public key, nothing is sent. Backups are never transferred unencrypted.
  - The file is streamed through gpg straight to the server, so it needs no extra local disk space. Nothing unencrypted is written along the way.
  - It is uploaded as `.part` and renamed once complete, so a bundle with its final name is always whole.
- Only dumps from the last 20 hours are sent. A database whose dump failed that night is reported, not sent with an older dump.
- The server keeps the newest `BACKUP_REMOTE_KEEP` bundles (default 14). Older ones are deleted.
- Each run writes its result to `logs/backend/backup_transfer.json`. With the monitoring profile, the alerts `BackupTransferFailed`, `BackupTransferStale` (no success for 30h) and `BackupTransferIncomplete` fire from it.

### Setup

1. Create the SSH key on the host. `secrets/` is git-ignored and mounted read-only into the backend:
   ```bash
   mkdir -p secrets/backup
   ssh-keygen -t ed25519 -N "" -C "progeo-backup" -f secrets/backup/id_ed25519
   ```
2. Add `secrets/backup/id_ed25519.pub` to `~/.ssh/authorized_keys` of the user on the backup server.
   - Ideally that user is SFTP-only.
3. Get the server's host key. Only this key is accepted, so a changed or spoofed server is refused:
   ```bash
   ssh-keyscan -p 22 -t ed25519 <backup-host>
   ```
4. Create the encryption key pair on an **admin machine**, not on this host and not on the backup server:
   ```bash
   gpg --quick-generate-key "Progeo Backup <backup@progeo.com>" ed25519 cert never   # asks for a passphrase
   gpg --quick-add-key <fingerprint> cv25519 encr never                              # fingerprint from the line above
   gpg --armor --export backup@progeo.com > backup-public-key.asc
   gpg --armor --export-secret-keys backup@progeo.com > backup-private-key.asc
   ```
   - Copy **only** `backup-public-key.asc` to `secrets/backup/` on this host. A private key there is refused.
   - Store `backup-private-key.asc` and its passphrase offline, in two separate places (e.g. password manager and safe). **Without it, no backup can be restored.**
   - Several admins: put all their public keys into the one `.asc` file (`gpg --armor --export <fpr1> <fpr2>`). Any one of them can then decrypt.
5. In `.env`, fill in `BACKUP_REMOTE_HOST`, `BACKUP_REMOTE_USER`, `BACKUP_REMOTE_HOST_KEY` (the line from step 3) and `BACKUP_REMOTE_PATH`.
   - Use `BACKUP_REMOTE_PASSWORD` only if the server has no key login.
6. Rebuild and restart the backend (it needs `paramiko` and `gpg`), then test:
   ```bash
   docker compose build progeo-backend && docker compose up -d progeo-backend
   docker exec progeo-backend python manage.py transfer_backups --dry-run   # what would be sent, for which key
   docker exec progeo-backend python manage.py transfer_backups             # send now
   ```
7. Do a test restore once (see below), so you know the private key and passphrase work.

### Restore from the backup server

On the admin machine with the private key (`gpg --import backup-private-key.asc` once):

```bash
sha256sum -c progeo-2026-10-26-235301.tar.gpg.sha256
gpg --decrypt progeo-2026-10-26-235301.tar.gpg | tar -x -C restore/
```

Then copy the dumps from `restore/` into `media/backup` on the host and restore them:

```bash
docker exec progeo-backend python manage.py handle_all_dbs --command=dbrestore
```

Bundles from before the encryption are plain `progeo-*.tar` files. Unpack those with `tar -xf`. They are deleted as they age out of `BACKUP_REMOTE_KEEP`.

## Staging server

The staging server runs under `staging.api.progeo.com` and `staging.dashboard.progeo.com`. It holds a copy of the live databases:

- Every night the live server sends tonight's dumps to it (`transfer_backups --target staging`, right after the backup transfer in `daily.sh`).
- The dumps are encrypted for the staging server's **own** key pair. That key opens these bundles only, never the backup server's.
- On the staging server, `import_live_backup` checks, decrypts and unpacks a bundle into `media/backup` and restores exactly those dumps (`restore_backups`).
- Live connects to staging, never the other way round. The staging server needs no access to the live server or the backup server.

### .env / django.env of the staging server

The databases hold real customers. In `django.env` and `.env` of the staging server, set:

| Setting | Value | Why |
| --- | --- | --- |
| `MAIL_TEST_MODE` / `SMS_DRY_RUN` | `1` | Alarms and reports go to `MAIL_TEST_RECIPIENT`; SMS are only logged. |
| `BACKUP_REMOTE_HOST` | empty | Otherwise staging's dumps land between the live bundles on the backup server and push them out. |
| `STAGING_REMOTE_HOST` | empty | Staging sends nothing anywhere. |
| `DNS_FRONT_NAMES` / `DNS_BACK_NAMES` | `"staging.dashboard.progeo.com localhost"` / `"staging.api.progeo.com"` | nginx `server_name`. |
| `FRONTEND_URL`, `FULL_BACKEND_URL`, `BACKEND_URL`, `MONITORING_URL` | the `staging.` names | Links in mails, Grafana. |
| `DEVICE_SAMPLE_BASE_URL` | `https://staging.api.progeo.com` | Device configs made on staging must not point at live. |
| `ALLOWED_ORIGINS` | the `staging.` origins | CORS / CSRF. |
| `CERT_PATH` | `/etc/letsencrypt/live/staging.api.progeo.com` | See below. |
| `SENTRY_ENVIRONMENT`, `ALERT_SERVER_NAME` | `staging` | Errors and alerts must not look like live. |

Also check the jobs that talk to the outside world, e.g. the Airtable sync (`AIRTABLE_*`). Switch them off with `CELERY_DISABLED_TASKS` / `CRON_DISABLED_JOBS` where staging must not write.

### Certificate (on the staging server)

1. Point the DNS A records of `staging.api.progeo.com` and `staging.dashboard.progeo.com` to the staging server. Port 80 must be reachable.
2. Request the certificate while nginx still runs with the old config. It serves the ACME challenge from `/var/www/certbot`. Put `staging.api.progeo.com` first, because certbot names the directory after the first domain:
   ```bash
   sudo bash scripts/setup_certbot.sh admin@progeo.com staging.api.progeo.com staging.dashboard.progeo.com
   ```
3. Set the `.env` values above and recreate nginx, which reads `CERT_PATH` only at start: `docker compose up -d --force-recreate progeo-nginx`.
4. Remove the copied `api.progeo.com` certificate from the staging server. Its renewal can only fail there, because the challenge goes to the live server. Every failure counts against Let's Encrypt's per-account limit, which the copied account shares with the live server:
   ```bash
   sudo certbot delete --cert-name api.progeo.com   # local files only - check the name with: certbot certificates
   ```
   **Never `certbot revoke` there.** The copy may be the very certificate the live server uses.

### Data transfer setup

1. **Staging server**: make the key pair. The private key stays here, without a passphrase, so the import runs unattended. Otherwise set `STAGING_IMPORT_GPG_PASSPHRASE`.
   ```bash
   mkdir -p secrets/backup && cd secrets/backup
   export GNUPGHOME="$(mktemp -d)"
   gpg --batch --pinentry-mode loopback --passphrase "" --quick-generate-key "Progeo Staging <staging@progeo.com>" ed25519 cert never
   gpg --batch --pinentry-mode loopback --passphrase "" --quick-add-key "$(gpg --list-keys --with-colons | awk -F: '/^fpr/ {print $10; exit}')" cv25519 encr never
   gpg --armor --export > staging-public-key.asc
   gpg --batch --pinentry-mode loopback --passphrase "" --armor --export-secret-keys > staging-private-key.asc
   chmod 600 staging-private-key.asc && rm -rf "$GNUPGHOME"
   ```
2. **Staging server**: allow the live server's backup SSH key (`secrets/backup/id_ed25519.pub` on live) for the user `progeo`, restricted to SFTP. Add it as one line to `~progeo/.ssh/authorized_keys`:
   ```text
   restrict,command="/usr/lib/openssh/sftp-server" ssh-ed25519 AAAA... progeo-backup
   ```
3. **Live server**: copy `staging-public-key.asc` (the public key **only**) to `secrets/backup/`. In `.env`, set `STAGING_REMOTE_HOST`, `STAGING_REMOTE_USER=progeo` and `STAGING_REMOTE_HOST_KEY`:
   ```bash
   ssh-keyscan -p 22 -t ed25519 staging.api.progeo.com
   ```
   The bundles land in `~progeo/detection-docker-setup/media/staging` (`STAGING_REMOTE_PATH`). The newest 2 are kept.
   - If the staging server is a disk copy of the live server, both have the same SSH host key. Then the key pinning can't tell them apart. Make new host keys on staging first: `sudo rm /etc/ssh/ssh_host_* && sudo dpkg-reconfigure openssh-server`.
4. **Live server**: test, then restart the backend so `daily.sh` picks it up:
   ```bash
   docker exec progeo-backend python manage.py transfer_backups --target staging --dry-run
   docker exec progeo-backend python manage.py transfer_backups --target staging
   ```
   The result goes to `logs/backend/backup_transfer_staging.json`.

### Refresh the staging data

```bash
docker exec -it progeo-backend python manage.py import_live_backup --list    # what arrived
docker exec -it progeo-backend python manage.py import_live_backup           # unpack, show what restore would do
docker exec -it progeo-backend python manage.py import_live_backup --apply   # drop + restore (asks first)
docker compose restart progeo-backend
```

- The restore replaces **all** databases of the staging server, including users and test data made there. Project databases that live doesn't have are dropped.
- If the staging code is newer than live, run `migrate` afterwards.

## Notes

- Most service ports are controlled via `.env` variables.
- Public entry points are exposed by Nginx on `80`/`443`.
- PostgreSQL now binds to localhost by default through Compose. To intentionally expose it, set `LIMITED_ACCESS=0.0.0.0:` in `.env`.

## Local Network CORS (Lightweight)

To allow frontend apps from your LAN (e.g. `http://192.168.x.x:3000`) without opening CORS globally:

- Set `CORS_ALLOWED_ORIGIN_REGEXES="^https?://192\\.168\\.\\d{1,3}\\.\\d{1,3}(?::\\d+)?$"` in `django.env`
- Keep `CORS_ALLOW_PRIVATE_NETWORK=1` (helps modern browser local-network preflights)

This keeps `CORS_ALLOW_ALL_ORIGINS` disabled and only adds a local subnet regex.
