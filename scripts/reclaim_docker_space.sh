#!/bin/bash

set -euo pipefail

SHOW_USAGE=0
PRUNE_VOLUMES=0
PRUNE_ALL_IMAGES=0
SKIP_DOCKER=0

usage() {
  cat <<'EOF'
Usage: bash scripts/reclaim_docker_space.sh [options]

Reclaim unused disk space from Docker and common host caches/temp files.

Options:
  --volumes     Also remove unused volumes.
  --all-images  Remove all unused images, not only dangling ones.
  --skip-docker Skip Docker cleanup and only reclaim host disk space.
  --help        Show this help message.

Notes:
  - Safe default: keeps unused volumes unless --volumes is passed.
  - Running containers are not touched.
  - Host cleanup targets apt caches, temp files, old journals, and trash.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --volumes)
      PRUNE_VOLUMES=1
      ;;
    --all-images)
      PRUNE_ALL_IMAGES=1
      ;;
    --skip-docker)
      SKIP_DOCKER=1
      ;;
    --help|-h)
      SHOW_USAGE=1
      ;;
    *)
      echo "Unknown option: $arg"
      usage
      exit 1
      ;;
  esac
done

if [[ "$SHOW_USAGE" -eq 1 ]]; then
  usage
  exit 0
fi

cleanup_temp_dirs() {
  echo "Cleaning temporary files..."
  rm -rf /tmp/* /var/tmp/* 2>/dev/null || true
}

cleanup_apt() {
  if command -v apt-get >/dev/null 2>&1; then
    echo "Running apt autoremove/autoclean/clean..."
    apt-get autoremove -y || true
    apt-get autoclean -y || true
    apt-get clean || true
  fi
}

cleanup_journal() {
  if command -v journalctl >/dev/null 2>&1; then
    echo "Vacuuming old systemd journal files..."
    journalctl --vacuum-time=7d >/dev/null 2>&1 || true
  fi
}

cleanup_trash() {
  echo "Cleaning user trash directories..."
  find /home -mindepth 2 -maxdepth 4 \( -path '*/.local/share/Trash/files' -o -path '*/.local/share/Trash/info' \) -exec rm -rf {}/* \; 2>/dev/null || true
  rm -rf /root/.local/share/Trash/files/* /root/.local/share/Trash/info/* 2>/dev/null || true
}

cleanup_docker() {
  if [[ "$SKIP_DOCKER" -eq 1 ]]; then
    echo "Skipping Docker cleanup."
    return
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed or not in PATH. Skipping Docker cleanup."
    return
  fi

  echo "Docker disk usage before cleanup:"
  docker system df
  echo

  echo "Pruning stopped containers, unused networks, and build cache..."
  docker container prune -f
  docker network prune -f
  docker builder prune -f

  if [[ "$PRUNE_ALL_IMAGES" -eq 1 ]]; then
    echo "Pruning all unused images..."
    docker image prune -a -f
  else
    echo "Pruning dangling images..."
    docker image prune -f
  fi

  if [[ "$PRUNE_VOLUMES" -eq 1 ]]; then
    echo "Pruning unused volumes..."
    docker volume prune -f
  else
    echo "Skipping volume prune. Use --volumes to remove unused volumes."
  fi

  echo
  echo "Docker disk usage after cleanup:"
  docker system df
}

if [[ "${EUID}" -ne 0 ]]; then
  echo "Error: run this script as root (use sudo)."
  exit 1
fi

cleanup_temp_dirs
cleanup_apt
cleanup_journal
cleanup_trash
cleanup_docker