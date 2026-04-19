# Progeo Docker Setup

## What gets started

`docker compose` runs these services:

- `progeo-database` (PostgreSQL)
- `progeo-redis` (Redis)
- `progeo-backend` (Django API)
- `progeo-frontend` (Frontend)
- `progeo-nginx` (reverse proxy, ports `80` and `443`)

## 1) Prepare environment files

Required files in project root:

- `.env` (from `.env.template`)
- `django.env` (from `django.env.template`)

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
```

## Notes

- Most service ports are controlled via `.env` variables.
- Public entry points are exposed by Nginx on `80`/`443`.
