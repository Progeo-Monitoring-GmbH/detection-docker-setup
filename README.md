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

## Notes

- Most service ports are controlled via `.env` variables.
- Public entry points are exposed by Nginx on `80`/`443`.
- PostgreSQL now binds to localhost by default through Compose. To intentionally expose it, set `LIMITED_ACCESS=0.0.0.0:` in `.env`.

## Local Network CORS (Lightweight)

To allow frontend apps from your LAN (e.g. `http://192.168.x.x:3000`) without opening CORS globally:

- Set `CORS_ALLOWED_ORIGIN_REGEXES="^https?://192\\.168\\.\\d{1,3}\\.\\d{1,3}(?::\\d+)?$"` in `django.env`
- Keep `CORS_ALLOW_PRIVATE_NETWORK=1` (helps modern browser local-network preflights)

This keeps `CORS_ALLOW_ALL_ORIGINS` disabled and only adds a local subnet regex.
