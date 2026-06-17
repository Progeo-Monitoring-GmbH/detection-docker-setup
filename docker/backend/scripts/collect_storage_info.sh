#!/usr/bin/env bash

set -euo pipefail

DATE_FOLDER="$(date +%Y-%m-%d)"
OUTPUT_PATH="${PROJECT_ROOT}/media/setup/${DATE_FOLDER}/storage_info.json"
OUT_DIR="$(dirname "$OUTPUT_PATH")"
mkdir -p "$OUT_DIR"

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
  MEDIA_SIZE_BYTES="$(du -sb ${PROJECT_ROOT}/media | awk '{print $1}')"
fi

LOG_SIZE_BYTES="0"
if [ -d "/var/log/progeo" ]; then
  LOG_SIZE_BYTES="$(du -sb /var/log/progeo | awk '{print $1}')"
fi

cat > "$OUTPUT_PATH" <<EOF
{
  "generated_at": "$TIMESTAMP",
  "host": {
    "hostname": "$HOST_NAME",
    "kernel": "$KERNEL"
  },
  "storage": {
    "root": {
      "filesystem": "$ROOT_FS",
      "mount": "$ROOT_MOUNT",
      "total_bytes": $ROOT_TOTAL,
      "used_bytes": $ROOT_USED,
      "available_bytes": $ROOT_AVAIL,
      "used_percent": "$ROOT_PERCENT"
    },
    "media": {
      "path": "$MEDIA_PATH",
      "filesystem": "$MEDIA_FS",
      "mount": "$MEDIA_MOUNT",
      "total_bytes": $MEDIA_TOTAL,
      "used_bytes": $MEDIA_USED,
      "available_bytes": $MEDIA_AVAIL,
      "used_percent": "$MEDIA_PERCENT",
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