# Pre-built base for docker/backend/Dockerfile, published to Docker Hub.
# Build & push (from repo root), then bump the FROM tag in docker/backend/Dockerfile:
#   docker build --platform linux/amd64 -f docker/backend-base/Dockerfile \
#     -t progeomonitoring/detection-docker-setup:backend-base-py3.13.7-alpine3.21-cv4.12.0.88 docker/backend-base
#   docker push progeomonitoring/detection-docker-setup:backend-base-py3.13.7-alpine3.21-cv4.12.0.88
# Host-specific users/groups (DOCKER_UID etc.) must NOT go here, they are created in docker/backend/Dockerfile.
FROM python:3.13.7-alpine3.21

RUN apk update && apk add --no-cache  \
                      ffmpeg \
                      nano \
                      iputils-ping \
                      lsb-release \
                      gnupg \
                      wget \
                      curl \
                      ca-certificates \
                      git \
                      supervisor \
                      dcron \
                      rsync \
                      libpq-dev \
                      gcc \
                      python3-dev \
                      musl-dev \
                      linux-headers \
                      make \
                      automake \
                      g++ \
                      bash \
                      postgresql-client \
                      geos \
                      geos-dev \
                      build-base \
                      proj \
                      proj-dev

ENV PROJECT_ROOT=/home/progeo/detection-docker-setup
ENV VENV_ROOT=/opt/venv

WORKDIR ${PROJECT_ROOT}

RUN wget https://raw.githubusercontent.com/vishnubob/wait-for-it/master/wait-for-it.sh -O wait-for-it.sh

RUN python3 -m venv $VENV_ROOT
ENV PATH="$VENV_ROOT/bin:$PATH"

#Temp hotfix see https://github.com/pypa/setuptools/issues/4519
RUN pip install -U certifi setuptools pip
RUN pip install opencv-python-headless==4.12.0.88 --use-feature=fast-deps
