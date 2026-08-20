#!/bin/bash

set -euo pipefail
shopt -s nullglob

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKUP_DIR="${PROJECT_ROOT}/media/backup"
KEEP=10
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: bash scripts/cleanup_media_backup.sh [options]

Delete old *.psql backups (and their .metadata files) in media/backup,
keeping only the latest N backups per database.

Options:
  --dir=PATH   Backup directory to clean (default: media/backup).
  --keep=N     Number of most recent backups to keep per database (default: 10).
  --dry-run    Show what would be deleted without deleting anything.
  --help       Show this help message.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dir=*)
      BACKUP_DIR="${arg#*=}"
      ;;
    --keep=*)
      KEEP="${arg#*=}"
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: ${arg}" >&2
      usage
      exit 1
      ;;
  esac
done

if ! [[ "${KEEP}" =~ ^[0-9]+$ ]] || [[ "${KEEP}" -lt 1 ]]; then
  echo "Error: --keep must be a positive integer" >&2
  exit 1
fi

if [[ ! -d "${BACKUP_DIR}" ]]; then
  echo "Error: backup directory not found: ${BACKUP_DIR}" >&2
  exit 1
fi

echo "[CLEANUP] Backup dir: ${BACKUP_DIR}"
echo "[CLEANUP] Keeping latest ${KEEP} backup(s) per database"

# Backup files are named "<db>-<host>-<date>-<time>.psql", so group by the
# part before the first '-' and rank by modification time (not filename,
# since the host segment breaks alphabetical/date ordering across hosts).
declare -A DB_ENTRIES

for file in "${BACKUP_DIR}"/*.psql; do
  base="$(basename "${file}")"
  db_name="${base%%-*}"
  mtime="$(stat -c '%Y' "${file}" 2>/dev/null || stat -f '%m' "${file}")"
  echo "[CLEANUP] Found backup: ${file} (db: ${db_name}, mtime: ${mtime})"
  DB_ENTRIES["${db_name}"]+="${mtime}"$'\t'"${file}"$'\n'
done

for db_name in "${!DB_ENTRIES[@]}"; do
  mapfile -t files < <(printf '%s' "${DB_ENTRIES[${db_name}]}" | sort -rn -k1,1 | cut -f2-)
  count=${#files[@]}
  if (( count <= KEEP )); then
    continue
  fi

  for ((i = KEEP; i < count; i++)); do
    file="${files[$i]}"
    metadata="${file}.metadata"

    if [[ "${DRY_RUN}" -eq 1 ]]; then
      echo "[DRY-RUN] Would delete: ${file}"
      [[ -e "${metadata}" ]] && echo "[DRY-RUN] Would delete: ${metadata}"
      continue
    fi

    echo "[CLEANUP] Deleting: ${file}"
    rm -f "${file}"
    if [[ -e "${metadata}" ]]; then
      echo "[CLEANUP] Deleting: ${metadata}"
      rm -f "${metadata}"
    fi
  done
done

echo "[CLEANUP] Done"
read  -n 1 -p "Press any key to continue..."
