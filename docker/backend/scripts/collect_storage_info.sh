#!/usr/bin/env bash

set -euo pipefail

DATE_FOLDER="$(date +%Y-%m-%d)"
PROJECT_ROOT="${PROJECT_ROOT:-/home/progeo/detection-docker-setup}"
OUTPUT_PATH="${OUTPUT_PATH:-${PROJECT_ROOT}/media/setup/${DATE_FOLDER}/storage_info.json}"
OUT_DIR="$(dirname "$OUTPUT_PATH")"
mkdir -p "$OUT_DIR"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

TIMESTAMP="$(date -Iseconds)"
HOST_NAME="$(hostname 2>/dev/null || echo unknown)"
KERNEL="$(uname -sr 2>/dev/null || echo unknown)"

read -r ROOT_FS ROOT_TOTAL ROOT_USED ROOT_AVAIL ROOT_PERCENT ROOT_MOUNT <<EOF
$(df -P -B1 / | awk 'NR==2 {print $1, $2, $3, $4, $5, $6}')
EOF

MEDIA_PATH="${PROJECT_ROOT}/media"
if [ ! -d "$MEDIA_PATH" ]; then
  MEDIA_PATH="/"
fi

read -r MEDIA_FS MEDIA_TOTAL MEDIA_USED MEDIA_AVAIL MEDIA_PERCENT MEDIA_MOUNT <<EOF
$(df -P -B1 "$MEDIA_PATH" | awk 'NR==2 {print $1, $2, $3, $4, $5, $6}')
EOF

MEDIA_SIZE_BYTES="0"
if [ -d "${PROJECT_ROOT}/media" ]; then
  MEDIA_SIZE_BYTES="$(du -sb "${PROJECT_ROOT}/media" | awk '{print $1}')"
fi

LOG_SIZE_BYTES="0"
if [ -d "/var/log/progeo" ]; then
  LOG_SIZE_BYTES="$(du -sb /var/log/progeo | awk '{print $1}')"
fi

ESCAPED_TIMESTAMP="$(json_escape "$TIMESTAMP")"
ESCAPED_HOST_NAME="$(json_escape "$HOST_NAME")"
ESCAPED_KERNEL="$(json_escape "$KERNEL")"
ESCAPED_ROOT_FS="$(json_escape "$ROOT_FS")"
ESCAPED_ROOT_MOUNT="$(json_escape "$ROOT_MOUNT")"
ESCAPED_ROOT_PERCENT="$(json_escape "$ROOT_PERCENT")"
ESCAPED_MEDIA_PATH="$(json_escape "$MEDIA_PATH")"
ESCAPED_MEDIA_FS="$(json_escape "$MEDIA_FS")"
ESCAPED_MEDIA_MOUNT="$(json_escape "$MEDIA_MOUNT")"
ESCAPED_MEDIA_PERCENT="$(json_escape "$MEDIA_PERCENT")"

cat > "$OUTPUT_PATH" <<EOF
{
  "generated_at": "$ESCAPED_TIMESTAMP",
  "host": {
    "hostname": "$ESCAPED_HOST_NAME",
    "kernel": "$ESCAPED_KERNEL"
  },
  "storage": {
    "root": {
      "filesystem": "$ESCAPED_ROOT_FS",
      "mount": "$ESCAPED_ROOT_MOUNT",
      "total_bytes": $ROOT_TOTAL,
      "used_bytes": $ROOT_USED,
      "available_bytes": $ROOT_AVAIL,
      "used_percent": "$ESCAPED_ROOT_PERCENT"
    },
    "media": {
      "path": "$ESCAPED_MEDIA_PATH",
      "filesystem": "$ESCAPED_MEDIA_FS",
      "mount": "$ESCAPED_MEDIA_MOUNT",
      "total_bytes": $MEDIA_TOTAL,
      "used_bytes": $MEDIA_USED,
      "available_bytes": $MEDIA_AVAIL,
      "used_percent": "$ESCAPED_MEDIA_PERCENT",
      "directory_size_bytes": $MEDIA_SIZE_BYTES
    },
    "logs": {
      "path": "/var/log/progeo",
      "directory_size_bytes": $LOG_SIZE_BYTES
    }
  }
}
EOF

echo "$OUTPUT_PATH"