# syntax=docker/dockerfile:1
# Pre-built base for docker/backend/Dockerfile, published to Docker Hub - two
# images from this file (build & push from the repo root, then bump the tags
# in docker/backend/Dockerfile):
#
# 1. The base (default target) - what the backend image runs on:
#   docker buildx build --pull --platform linux/amd64 --sbom=true --provenance=mode=max \
#     -f docker/backend-base/Dockerfile \
#     -t progeomonitoring/detection-docker-setup:backend-base-py3.13-alpine3.24-v2.0.0 --push docker/backend-base
#
# 2. The wheels (--target wheels) - only when OPENCV_VERSION or the Python /
#    Alpine version changes: opencv-python-headless has no wheel for musl
#    (Alpine) on PyPI, building it takes ~30 min - done once here instead of
#    in every backend build:
#   docker buildx build --platform linux/amd64 --target wheels \
#     -f docker/backend-base/Dockerfile \
#     -t progeomonitoring/detection-docker-setup:backend-wheels-py3.13-alpine3.24-opencv5.0.0.93 --push docker/backend-base
#
# Host-specific users/groups (DOCKER_UID etc.) must NOT go here, they are created in docker/backend/Dockerfile.
#
# Hardened (chosen with Docker Scout over Debian slim, Docker Hardened Images
# and Wolfi - see docker/backend-base/SECURITY.md): only what the backend
# runs, nothing to build with. No compilers, git, curl, wget, perl, nano -
# docker/backend/Dockerfile compiles the Python packages in a build stage
# and copies only the finished venv. Rebuild regularly (--pull): the apk
# upgrade below takes the fixes Alpine publishes in the meantime.
FROM python:3.13-alpine3.24 AS runtime

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

# --- The wheels: compiled once, on the same Python/Alpine as the base ------
FROM runtime AS wheel-build
ARG OPENCV_VERSION=5.0.0.93
RUN apk add --no-cache build-base linux-headers
RUN --mount=type=cache,target=/root/.cache/pip \
    pip wheel --no-deps --wheel-dir /wheels "opencv-python-headless==${OPENCV_VERSION}"

# Nothing but the wheel files - the backend build stage copies /wheels.
FROM scratch AS wheels
COPY --from=wheel-build /wheels /wheels

# --- The default target: the base itself (the wheel stages are skipped) ----
FROM runtime AS base
