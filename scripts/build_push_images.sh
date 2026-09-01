#!/usr/bin/env bash
#
# build_push_images.sh - build, tag, sign and push all progeo images to Docker Hub.
#
# Usage:
#   VERSION=1.0.0 ./scripts/build_push_images.sh            # explicit version
#   ./scripts/build_push_images.sh                          # version = date (YYYY.MM.DD)
#   INCLUDE_CAD_FACTORY=1 ./scripts/build_push_images.sh    # also build + push the cad factory
#
# Resulting tags: progeomonitoring/detection-docker-setup:<service>-<VERSION>
# (database, backend, frontend, nginx, and optionally cad_factory).
#
# Signing (Docker Content Trust):
#   DOCKER_CONTENT_TRUST=1 is enabled for every push. Provide the key
#   passphrases via the environment (they are never stored or printed here):
#     DOCKER_CONTENT_TRUST_ROOT_PASSPHRASE
#     DOCKER_CONTENT_TRUST_REPOSITORY_PASSPHRASE
#     DOCKER_CONTENT_TRUST_TAGGING_PASSPHRASE
#   On the first push DCT creates the keys using those passphrases (or prompts
#   interactively when they are not set).
#
# Credentials:
#   docker login is performed securely - the password is piped via
#   --password-stdin and never appears on the command line or in the output.
#   Set DOCKER_USERNAME (and DOCKER_PASSWORD, e.g. from a secret manager) to
#   log in non-interactively; otherwise you are prompted. If you are already
#   logged in, your session is reused and left untouched.
#
#   NOTE: if your Docker Hub account has 2FA enabled, the account password
#   will NOT work for docker login - use a personal access token
#   (hub.docker.com -> Account Settings -> Personal access tokens) as the
#   password instead.
#
set -euo pipefail

REPO="${REPO:-progeomonitoring/detection-docker-setup}"
REGISTRY="${REGISTRY:-docker.io}"
VERSION="${VERSION:-$(date +%Y.%m.%d)}"
LOCAL_PREFIX="${LOCAL_PREFIX:-detection-docker-setup-progeo}"

# Services built from this repo (redis uses a public image and is not built).
SERVICES=(database backend frontend nginx)
if [ "${INCLUDE_CAD_FACTORY:-0}" = "1" ]; then
  SERVICES+=(cad_factory)
fi

say() { printf '\033[1;34m[build-push]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[build-push]\033[0m ERROR: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker is required"

# ---------------------------------------------------------------------------
# 1) Login (only when needed) - credentials never on the command line
# ---------------------------------------------------------------------------
LOGGED_IN_HERE=0
login_docker() { # $1 = username
  local username password login_output
  username="$(printf '%s' "$1" | xargs)"  # trim whitespace
  password="${DOCKER_PASSWORD:-}"
  if [ -z "${password}" ]; then
    if [ ! -t 0 ]; then
      fail "no password available and stdin is not a terminal - set DOCKER_USERNAME and DOCKER_PASSWORD (e.g. from a secret manager) or run this script interactively"
    fi
    read -r -s -p "Docker Hub password for ${username} (use an access token when 2FA is enabled): " password
    printf '\n'
  fi
  password="$(printf '%s' "${password}" | xargs)"  # trim whitespace/newlines
  if [ -z "${password}" ]; then
    fail "empty password - docker login aborted"
  fi

  login_output="$(printf '%s' "${password}" | docker login "${REGISTRY}" -u "${username}" --password-stdin 2>&1)" \
    || fail "docker login failed for user '${username}': ${login_output}"
  unset DOCKER_PASSWORD
  LOGGED_IN_HERE=1
}

if [ -n "${DOCKER_USERNAME:-}" ]; then
  # Explicit credentials: always perform a fresh login - never reuse a
  # possibly stale/malformed credential from ~/.docker/config.json.
  login_docker "${DOCKER_USERNAME}"
elif docker info 2>/dev/null | grep -qi 'username:'; then
  say "Already logged in to ${REGISTRY} - reusing session."
else
  read -r -p "Docker Hub username: " DOCKER_USERNAME
  login_docker "${DOCKER_USERNAME}"
fi

# ---------------------------------------------------------------------------
# 2) Build (cad_factory only when requested, via its compose profile)
# ---------------------------------------------------------------------------
say "Building images (version ${VERSION})..."
if [ "${INCLUDE_CAD_FACTORY:-0}" = "1" ]; then
  COMPOSE_PROFILES=cad_factory docker compose build
else
  docker compose build
fi

# ---------------------------------------------------------------------------
# 3) Tag, sign and push every image
# ---------------------------------------------------------------------------
export DOCKER_CONTENT_TRUST=1
export DOCKER_CONTENT_TRUST_SERVER="${DOCKER_CONTENT_TRUST_SERVER:-https://notary.docker.io}"

for SERVICE in "${SERVICES[@]}"; do
  LOCAL_IMAGE="${LOCAL_PREFIX}-${SERVICE}:latest"
  REMOTE_IMAGE="${REPO}:${SERVICE}-${VERSION}"
  say "Tagging ${LOCAL_IMAGE} -> ${REMOTE_IMAGE}"
  docker tag "${LOCAL_IMAGE}" "${REMOTE_IMAGE}"

  say "Signing + pushing ${REMOTE_IMAGE} (DCT enabled)"
  if ! PUSH_OUTPUT="$(docker push "${REMOTE_IMAGE}" 2>&1)"; then
    if printf '%s' "${PUSH_OUTPUT}" | grep -Eqi 'authentication|malformed|unauthorized|denied'; then
      fail "docker push failed for ${REMOTE_IMAGE} - auth problem. Run 'docker logout' once, then re-run this script (fresh login): ${PUSH_OUTPUT}"
    fi
    fail "docker push failed for ${REMOTE_IMAGE}: ${PUSH_OUTPUT}"
  fi
done

say "Done: signed images pushed to ${REPO} with tag suffix -${VERSION}"
say "Deploy with: IMAGE_VERSION=${VERSION} docker compose -f docker-compose.prod.yml up -d"

if [ "${LOGGED_IN_HERE}" = "1" ]; then
  docker logout "${REGISTRY}" >/dev/null 2>&1 || true
fi
