#!/usr/bin/env bash
set -euo pipefail

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

export TESTS_ACTIVE=1
export DJANGO_SETTINGS_MODULE=progeo.tests.settings

pytest --ds=progeo.tests.settings "$@"
