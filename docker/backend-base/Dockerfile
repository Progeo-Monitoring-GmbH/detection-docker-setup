# Pre-built base for docker/backend/Dockerfile, published to Docker Hub.
# Build & push (from repo root), then bump the FROM tag in docker/backend/Dockerfile:
#   docker build --pull --platform linux/amd64 -f docker/backend-base/Dockerfile \
#     -t progeomonitoring/detection-docker-setup:backend-base-py3.13-alpine3.24-v2.0.0 docker/backend-base
#   docker push progeomonitoring/detection-docker-setup:backend-base-py3.13-alpine3.24-v2.0.0
# Host-specific users/groups (DOCKER_UID etc.) must NOT go here, they are created in docker/backend/Dockerfile.
#
# Hardened (chosen with Docker Scout over Debian slim, Docker Hardened Images
# and Wolfi - see docker/backend-base/SECURITY.md): only what the backend
# runs, nothing to build with. No compilers, git, curl, wget, perl, nano -
# docker/backend/Dockerfile compiles the Python packages in a build stage
# and copies only the finished venv. Rebuild regularly (--pull): the apk
# upgrade below takes the fixes Alpine publishes in the meantime.
FROM python:3.13-alpine3.24

# bash: the start/cron scripts; dcron: the cron daemon supervisord runs;
# postgresql17-client: pg_dump/psql of dbbackup (same major as the server);
# ffmpeg: heatmap videos (helper/heatmap_video.py); gnupg: the encrypted
# backup transfer (helper/backup_transfer.py); iputils-ping: device checks
# (setup_viewset); tesseract: OCR of the Lageplan tables (helper/plan_ocr.py).
RUN apk upgrade --no-cache \
 && apk add --no-cache \
        bash \
        ca-certificates \
        dcron \
        ffmpeg \
        gnupg \
        iputils-ping \
        postgresql17-client \
        tesseract-ocr \
        tesseract-ocr-data-deu

ENV PROJECT_ROOT=/home/progeo/detection-docker-setup
ENV VENV_ROOT=/opt/venv
ENV PATH="$VENV_ROOT/bin:$PATH"

WORKDIR ${PROJECT_ROOT}

# Pinned upstream commit 81b1373 (vishnubob/wait-for-it, MIT) - kept in the
# repo instead of fetched from the master branch at every build.
COPY wait-for-it.sh ./wait-for-it.sh
