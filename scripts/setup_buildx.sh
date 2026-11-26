#!/bin/bash

# Open Wi-Fi Hotspot Setup Script for Raspberry Pi
# SSID and password are read from .env when available

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Error: run this script as root (use sudo)."
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f "$ROOT_DIR/venv/bin/activate" ]]; then
  # Linux/macOS venv
  # shellcheck disable=SC1091
  source "$ROOT_DIR/venv/bin/activate"
elif [[ -f "$ROOT_DIR/venv/Scripts/activate" ]]; then
  # Git-Bash/Windows venv
  # shellcheck disable=SC1091
  source "$ROOT_DIR/venv/Scripts/activate"
fi

echo "Perform backup? (y/n)"
read -r BACKUP_CONFIRMATION
if [[ "${BACKUP_CONFIRMATION}" == "y" ]]; then
  echo "Backing up Docker volumes..."
  python manage.py handle_all_dbs -c=dbbackup
fi

echo "Are you sure you want to remove Docker and Buildx? This will remove all Docker containers, images, and volumes. (y/n)"
read -r CONFIRMATION
if [[ "${CONFIRMATION}" != "y" ]]; then
  echo "Aborting."
  exit 0
fi

sudo systemctl stop docker docker.socket containerd
sudo apt-get purge -y docker.io docker-doc docker-compose podman-docker containerd runc
sudo apt-get autoremove -y
sudo rm -rf /var/lib/docker /var/lib/containerd
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/$(. /etc/os-release; echo $ID)/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$(. /etc/os-release; echo $ID) $(. /etc/os-release; echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
docker version
docker buildx version
docker compose version
DOCKER_BUILDKIT=1 COMPOSE_DOCKER_CLI_BUILD=1 docker compose build
echo "Docker and Buildx setup completed successfully."