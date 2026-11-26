#!/usr/bin/env bash
# Rotates the server's own secrets after a leak - safely: nothing stored
# encrypted is lost, nothing is printed, every step can be undone.
#
#   scripts/rotate_secrets.sh                    dry run: checks, shows WHICH keys it would rotate
#   scripts/rotate_secrets.sh --apply            rotates
#   scripts/rotate_secrets.sh --resume DIR       finishes an --apply that stopped (its backup DIR)
#   scripts/rotate_secrets.sh --rollback DIR     back to the values backed up in DIR
#
# Run on the server, in the repository, as the user that runs scripts/deploy.sh,
# AFTER the code with `manage.py rotate_encryption_keys` is deployed. It takes the
# deploy lock (logs/deploy/.lock): no deploy runs in between.
#
# What --apply does (a few minutes of downtime):
#   1. reads the current values from the running backend - exactly as Django uses them
#   2. backs up .env and django.env to secrets/rotation/<time>/ (mode 600)
#   3. stops progeo-backend (no writes while re-encrypting)
#   4. new password for the Postgres role POSTGRES_USER (ALTER ROLE, statement not logged)
#   5. writes the new values into .env / django.env (atomically, mode kept)
#   6. restarts redis, then in a one-off backend container:
#      manage.py rotate_encryption_keys --apply --logout-everyone [--superuser-password]
#      - re-encrypts the 2FA keys and device commands, logs every user out,
#        sets the superuser's new password
#   7. `docker compose up -d` (+ the backend recreated), Grafana's admin password reset
#   8. waits for /api/health/
# On a failure it stops and prints the rollback command.
#
# Rotated (generated here, hex - safe in .env, URLs and shell):
#   django.env: SECRET_KEY, SIGNING_KEY (JWT, HS256), TWO_FACTOR_ENCRYPTION_KEY,
#               DEVICE_COMMAND_ENCRYPTION_KEY, DJANGO_SUPERUSER_PASSWORD (if a superuser
#               is configured), FIRMWARE_UPLOAD_TOKEN (if set)
#   .env:       POSTGRES_PASSWORD, REDIS_PASSWORD, and if set: METRICS_TOKEN,
#               FLOWER_PASSWORD, POSTGRES_MONITOR_PASSWORD, GRAFANA_ADMIN_PASSWORD
# NOT rotated - they belong to someone else; renew them there, then put them in
# the env file by hand (listed at the end): AIRTABLE_API_KEY, MAIL_PW,
# ESENDEX_PASSWORD, WHATSAPP_ACCESS_TOKEN, MATRIX_ACCESS_TOKEN, SENTRY_DSN,
# ALERT_SMTP_PASSWORD, BACKUP_REMOTE_PASSWORD, CONTROLLER_PASSWORD and the MATRIX_*
# secrets (MATRIX_MAS_ENCRYPTION must never simply change - MAS data is encrypted with it).

set -Eeuo pipefail
umask 077

cd "$(dirname "$0")/.."
PROJECT_ROOT=$(pwd)
CONTAINER_ROOT=/home/progeo/detection-docker-setup
ENV_FILE=.env
DJANGO_ENV_FILE=django.env
DEPLOY_DIR=logs/deploy
DEPLOY_LOCK="${DEPLOY_DIR}/.lock"
ROTATION_DIR=secrets/rotation

DJANGO_ALWAYS=(SECRET_KEY SIGNING_KEY TWO_FACTOR_ENCRYPTION_KEY DEVICE_COMMAND_ENCRYPTION_KEY)
DJANGO_IF_SET=(DJANGO_SUPERUSER_PASSWORD FIRMWARE_UPLOAD_TOKEN)
ENV_ALWAYS=(POSTGRES_PASSWORD REDIS_PASSWORD)
ENV_IF_SET=(METRICS_TOKEN FLOWER_PASSWORD POSTGRES_MONITOR_PASSWORD GRAFANA_ADMIN_PASSWORD)
MANUAL=(AIRTABLE_API_KEY MAIL_PW ESENDEX_PASSWORD WHATSAPP_ACCESS_TOKEN MATRIX_ACCESS_TOKEN SENTRY_DSN
        ALERT_SMTP_PASSWORD BACKUP_REMOTE_PASSWORD CONTROLLER_PASSWORD MATRIX_OIDC_CLIENT_SECRET
        MATRIX_MAS_SECRET MATRIX_MACAROON_SECRET MATRIX_FORM_SECRET MATRIX_MAS_ADMIN_SECRET
        MATRIX_SIGNAL_PROVISIONING_SECRET MATRIX_DB_PASSWORD MATRIX_MAS_DB_PASSWORD)
# Read from the running backend: the values Django uses right now.
READ_KEYS=(SECRET_KEY TWO_FACTOR_ENCRYPTION_KEY DEVICE_COMMAND_ENCRYPTION_KEY POSTGRES_USER POSTGRES_DB
           DJANGO_SUPERUSER_USERNAME "${DJANGO_IF_SET[@]}" "${ENV_IF_SET[@]}")

info() { printf '\033[1;34m%s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }
# Set once the backup exists: every abort from then on says how to undo it.
ROLLBACK_HINT=""
die() {
  printf '\033[1;31m%s\033[0m\n' "$*" >&2
  [[ -n $ROLLBACK_HINT ]] && printf '\033[1;33m%s\033[0m\n' "$ROLLBACK_HINT" >&2
  exit 1
}

compose=(docker compose)
docker compose version >/dev/null 2>&1 || compose=(docker-compose)

# ---------------------------------------------------------------------------- helpers

new_secret() { openssl rand -hex "${1:-32}"; }

# The value of KEY in FILE as read_env reads it (first match, quotes stripped).
file_value() {
  local file=$1 key=$2 line
  line=$(grep -m1 -E "^${key}=" "$file" 2>/dev/null || true)
  line=${line#*=}
  line=${line%$'\r'}
  if [[ $line =~ ^\'(.*)\'$ ]]; then
    line=${BASH_REMATCH[1]}
  elif [[ $line =~ ^\"(.*)\"$ ]]; then
    # read_env unescapes "\x" inside double quotes.
    line=$(printf '%s' "${BASH_REMATCH[1]}" | sed -E 's/\\(.)/\1/g')
  fi
  printf '%s' "$line"
}

# KEY as Django reads the files: .env first, then django.env.
env_value() {
  local key=$1
  if grep -qE "^${key}=" "$ENV_FILE"; then file_value "$ENV_FILE" "$key"; else file_value "$DJANGO_ENV_FILE" "$key"; fi
}

# Sets KEY=VALUE in FILE (every line of KEY, or appended) - atomically, mode and
# owner kept. The value goes in through the environment, never as an argument.
set_value() {
  local file=$1 key=$2 tmp
  tmp=$(mktemp "${file}.rotate.XXXXXX")
  ROTATE_VALUE=$3 awk -v key="$key" '
    BEGIN { value = ENVIRON["ROTATE_VALUE"]; done = 0 }
    index($0, key "=") == 1 { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$file" > "$tmp"
  chmod --reference="$file" "$tmp"
  chown --reference="$file" "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$file"
}

# Where KEY lives: .env wins over django.env (read_env takes the first). New keys
# go to django.env - except the compose ones, which only .env feeds.
target_file() {
  local key=$1
  if grep -qE "^${key}=" "$ENV_FILE"; then echo "$ENV_FILE"
  elif grep -qE "^${key}=" "$DJANGO_ENV_FILE"; then echo "$DJANGO_ENV_FILE"
  elif [[ " ${ENV_ALWAYS[*]} ${ENV_IF_SET[*]} " == *" $key "* ]]; then echo "$ENV_FILE"
  else echo "$DJANGO_ENV_FILE"
  fi
}

# The current values as the running backend's Django sees them (container
# environment first, then .env, then django.env - progeo/helper/basics.read_env).
declare -A CURRENT=()
read_current() {
  docker ps --format '{{.Names}}' | grep -qx progeo-backend \
    || die "progeo-backend is not running - its values are read from it. Start it first."
  local script='import os, sys
from progeo.helper.basics import read_env
read_env("django.env")
sys.stdout.write("\0".join(os.environ.get(k, "") for k in sys.argv[1:]) + "\0")'
  local values=()
  mapfile -d '' values < <(docker exec -w "$CONTAINER_ROOT" progeo-backend python -c "$script" "${READ_KEYS[@]}")
  [[ ${#values[@]} -eq ${#READ_KEYS[@]} ]] || die "Could not read the current values from progeo-backend."
  local i
  for i in "${!READ_KEYS[@]}"; do CURRENT[${READ_KEYS[$i]}]=${values[$i]}; done
  # Not in Django's environment: only compose reads them.
  CURRENT[POSTGRES_PASSWORD]=$(file_value "$ENV_FILE" POSTGRES_PASSWORD)
  CURRENT[REDIS_PASSWORD]=$(file_value "$ENV_FILE" REDIS_PASSWORD)
  [[ -n ${CURRENT[SECRET_KEY]} ]] || die "SECRET_KEY is empty in the running backend - refusing."
  [[ ${CURRENT[POSTGRES_USER]} =~ ^[A-Za-z0-9_]+$ ]] || die "POSTGRES_USER is empty or unusual - refusing."
}

# The keys --apply rotates (names only).
rotated_keys() {
  local key
  for key in "${DJANGO_ALWAYS[@]}" "${ENV_ALWAYS[@]}"; do echo "$key"; done
  for key in "${DJANGO_IF_SET[@]}" "${ENV_IF_SET[@]}"; do
    if [[ $key == DJANGO_SUPERUSER_PASSWORD && -z ${CURRENT[DJANGO_SUPERUSER_USERNAME]} ]]; then continue; fi
    [[ -n ${CURRENT[$key]:-} ]] && echo "$key"
  done
  return 0
}

set_postgres_password() {
  local password=$1
  [[ -n $password && $password != *$'\n'* ]] || die "Refusing an empty or multi-line Postgres password."
  # An SQL string literal (also for an old password with quotes, on --rollback).
  password=${password//\'/\'\'}
  # Through stdin, not argv; the statement is kept out of the server log.
  docker exec -i progeo-database psql -v ON_ERROR_STOP=1 -q \
      -U "${CURRENT[POSTGRES_USER]}" -d "${CURRENT[POSTGRES_DB]:-postgres}" >/dev/null <<SQL
BEGIN;
SET LOCAL log_statement = 'none';
SET LOCAL log_min_duration_statement = -1;
ALTER ROLE "${CURRENT[POSTGRES_USER]}" PASSWORD '${password}';
COMMIT;
SQL
}

# manage.py rotate_encryption_keys in a one-off backend container (new env files),
# the old values only in the environment of `docker compose run`.
re_encrypt() {
  local old_secret=$1 old_2fa=$2 old_cmd=$3
  shift 3
  ROTATE_OLD_SECRET_KEY=$old_secret ROTATE_OLD_TWO_FACTOR_ENCRYPTION_KEY=$old_2fa \
  ROTATE_OLD_DEVICE_COMMAND_ENCRYPTION_KEY=$old_cmd \
    "${compose[@]}" run --rm --no-deps -T \
      -e ROTATE_OLD_SECRET_KEY -e ROTATE_OLD_TWO_FACTOR_ENCRYPTION_KEY -e ROTATE_OLD_DEVICE_COMMAND_ENCRYPTION_KEY \
      progeo-backend /bin/bash "$CONTAINER_ROOT/start-supervisord.sh" manage rotate_encryption_keys "$@"
}

wait_for_backend() {
  local tries=0
  info "Waiting for the backend (/api/health/)..."
  until docker exec progeo-backend python -c \
      "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8383/api/health/', timeout=5)" \
      >/dev/null 2>&1; do
    tries=$((tries + 1))
    (( tries < 60 )) || die "The backend does not answer after 5 minutes - check 'docker logs progeo-backend'."
    sleep 5
  done
  ok "Backend answers."
}

restart_all() {
  info "Restarting the containers with the new values..."
  "${compose[@]}" up -d --force-recreate progeo-redis
  "${compose[@]}" up -d
  # django.env is a mounted file: compose doesn't see it changed.
  "${compose[@]}" up -d --force-recreate --no-deps progeo-backend
}

reset_grafana_password() {
  local password=$1
  docker ps --format '{{.Names}}' | grep -qx progeo-grafana || return 0
  # Grafana keeps its admin password in its own database - the env value only
  # counts on the very first start.
  local tries=0
  until printf '%s' "$password" | docker exec -i progeo-grafana \
      grafana cli admin reset-admin-password --password-from-stdin >/dev/null 2>&1; do
    tries=$((tries + 1))
    if (( tries >= 12 )); then
      warn "Grafana's admin password could not be reset - do it by hand (grafana cli admin reset-admin-password)."
      return 0
    fi
    sleep 5
  done
  ok "Grafana admin password reset."
}

acquire_lock() {
  command -v flock >/dev/null 2>&1 || die "flock not found (package util-linux)."
  mkdir -p "$DEPLOY_DIR"
  exec 9>>"$DEPLOY_LOCK"
  flock -n 9 || die "A deploy is running ($(cat "$DEPLOY_LOCK" 2>/dev/null || echo unknown)) - nothing done."
  echo "pid $$, $(whoami)@$(hostname), rotate_secrets, started $(date '+%Y-%m-%d %H:%M:%S')" > "$DEPLOY_LOCK"
}

preflight() {
  local tool
  for tool in docker openssl awk flock; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found."
  done
  [[ -f $ENV_FILE && -f $DJANGO_ENV_FILE ]] || die "Run in the repository with .env and django.env."
  docker ps --format '{{.Names}}' | grep -qx progeo-database || die "progeo-database is not running."
  info "Checking that the deployed image can run rotate_encryption_keys..."
  local output
  if ! output=$("${compose[@]}" run --rm --no-deps -T progeo-backend /bin/bash "$CONTAINER_ROOT/start-supervisord.sh" \
      manage rotate_encryption_keys --help 2>&1); then
    # --help prints no secrets; the error says what is wrong.
    printf '%s\n' "$output" | tail -n 15 >&2
    die "The backend image can't run 'manage.py rotate_encryption_keys' (output above). Old image? Deploy the current code."
  fi
}

print_manual() {
  echo
  info "Renew these with their provider and set them in the env file by hand, then 'docker compose up -d':"
  local key
  for key in "${MANUAL[@]}"; do
    if [[ -n $(file_value "$ENV_FILE" "$key")$(file_value "$DJANGO_ENV_FILE" "$key") ]]; then echo "  - $key"; fi
  done
  echo "  (MATRIX_MAS_ENCRYPTION: do NOT change - MAS data is encrypted with it.)"
}

# ---------------------------------------------------------------------------- modes

dry_run() {
  preflight
  read_current
  info "Dry run - nothing changed. --apply would rotate:"
  rotated_keys | sed 's/^/  - /'
  echo "and log every user out (sessions, login tokens, refresh JWTs). Device upload tokens stay."
  print_manual
}

apply() {
  preflight
  acquire_lock
  read_current

  local stamp backup
  stamp=$(date +%Y%m%d-%H%M%S)
  backup="${ROTATION_DIR}/${stamp}"
  mkdir -p "$backup"
  chmod 700 "$ROTATION_DIR" "$backup"
  cp -p "$ENV_FILE" "$backup/.env"
  cp -p "$DJANGO_ENV_FILE" "$backup/django.env"
  chmod 600 "$backup/.env" "$backup/django.env"
  ROLLBACK_HINT="Rotation stopped. Nothing is lost - finish it: scripts/rotate_secrets.sh --resume ${backup} - or undo it: scripts/rotate_secrets.sh --rollback ${backup}"
  trap 'warn "$ROLLBACK_HINT"' ERR
  ok "Backup: ${backup} (old values - delete it once everything works)."

  declare -A NEW=()
  local key
  while read -r key; do
    case $key in
      SECRET_KEY) NEW[$key]=$(new_secret 50) ;;
      *) NEW[$key]=$(new_secret 32) ;;
    esac
  done < <(rotated_keys)

  info "Stopping progeo-backend (no writes while re-encrypting)..."
  "${compose[@]}" stop progeo-backend

  info "New password for the Postgres role ${CURRENT[POSTGRES_USER]}..."
  set_postgres_password "${NEW[POSTGRES_PASSWORD]}"

  info "Writing the new values..."
  for key in "${!NEW[@]}"; do
    set_value "$(target_file "$key")" "$key" "${NEW[$key]}"
  done

  info "Restarting redis with its new password..."
  "${compose[@]}" up -d --force-recreate progeo-redis

  info "Re-encrypting, logging everyone out..."
  local extra=()
  [[ -n ${NEW[DJANGO_SUPERUSER_PASSWORD]:-} ]] && extra+=(--superuser-password)
  re_encrypt "${CURRENT[SECRET_KEY]}" "${CURRENT[TWO_FACTOR_ENCRYPTION_KEY]}" \
      "${CURRENT[DEVICE_COMMAND_ENCRYPTION_KEY]}" --apply --logout-everyone ${extra[@]+"${extra[@]}"}

  restart_all
  if [[ -n ${NEW[GRAFANA_ADMIN_PASSWORD]:-} ]]; then reset_grafana_password "${NEW[GRAFANA_ADMIN_PASSWORD]}"; fi
  wait_for_backend
  trap - ERR
  ROLLBACK_HINT=""

  echo
  ok "Rotated:"
  for key in "${!NEW[@]}"; do echo "  - $key"; done | sort
  echo
  warn "Update everything outside this server that uses them:"
  [[ -n ${NEW[FIRMWARE_UPLOAD_TOKEN]:-} ]] && warn "  - FIRMWARE_UPLOAD_TOKEN: the firmware upload (CI / build machine)"
  [[ -n ${NEW[METRICS_TOKEN]:-} ]] && warn "  - METRICS_TOKEN: an external Prometheus scraping /metrics, if any"
  warn "  - The new passwords are only in ${ENV_FILE} / ${DJANGO_ENV_FILE} - put them in the password manager."
  warn "  - Every user is logged out; 2FA keeps working."
  print_manual
}

# Finishes an --apply that stopped after writing the new values (e.g. while
# re-encrypting): the env files and Postgres already have the new values, the
# old ones are in the backup. Safe to run again - re-encrypting skips what the
# new key already reads.
resume() {
  local backup=${1:-}
  [[ -n $backup && -f $backup/.env && -f $backup/django.env ]] || die "Usage: $0 --resume secrets/rotation/<time>"
  ROLLBACK_HINT="Not finished. Run --resume again, or undo it: scripts/rotate_secrets.sh --rollback ${backup}"
  preflight
  acquire_lock

  # The old values as Django read them: .env first, then django.env (of the backup).
  local key old_secret old_2fa old_cmd
  for key in SECRET_KEY TWO_FACTOR_ENCRYPTION_KEY DEVICE_COMMAND_ENCRYPTION_KEY; do
    if grep -qE "^${key}=" "$backup/.env"; then
      printf -v "old_${key}" '%s' "$(file_value "$backup/.env" "$key")"
    else
      printf -v "old_${key}" '%s' "$(file_value "$backup/django.env" "$key")"
    fi
  done
  old_secret=$old_SECRET_KEY
  old_2fa=$old_TWO_FACTOR_ENCRYPTION_KEY
  old_cmd=$old_DEVICE_COMMAND_ENCRYPTION_KEY
  [[ -n $old_secret ]] || die "No SECRET_KEY in ${backup} - refusing."
  [[ $old_secret != "$(env_value SECRET_KEY)" ]] \
    || die "SECRET_KEY in the env files is still the old one - nothing to resume (run --apply)."

  local extra=()
  if [[ -n $(env_value DJANGO_SUPERUSER_USERNAME) && -n $(env_value DJANGO_SUPERUSER_PASSWORD) \
        && $(env_value DJANGO_SUPERUSER_PASSWORD) != "$(file_value "$backup/django.env" DJANGO_SUPERUSER_PASSWORD)" ]]; then
    extra+=(--superuser-password)
  fi

  info "Making sure redis runs with its new password..."
  "${compose[@]}" up -d --force-recreate progeo-redis
  info "Re-encrypting, logging everyone out..."
  re_encrypt "$old_secret" "$old_2fa" "$old_cmd" --apply --logout-everyone ${extra[@]+"${extra[@]}"}

  restart_all
  local grafana_new
  grafana_new=$(env_value GRAFANA_ADMIN_PASSWORD)
  if [[ -n $grafana_new && $grafana_new != "$(file_value "$backup/.env" GRAFANA_ADMIN_PASSWORD)" ]]; then
    reset_grafana_password "$grafana_new"
  fi
  wait_for_backend
  ROLLBACK_HINT=""
  ok "Rotation finished. Backup with the old values: ${backup} - delete it once everything works."
  print_manual
}

rollback() {
  local backup=${1:-}
  [[ -n $backup && -f $backup/.env && -f $backup/django.env ]] || die "Usage: $0 --rollback secrets/rotation/<time>"
  preflight
  acquire_lock
  # The values in the env files now (the new ones - written by --apply, plain
  # hex). Read from the files, not the backend: it may be stopped after a failure.
  CURRENT[POSTGRES_USER]=$(env_value POSTGRES_USER)
  CURRENT[POSTGRES_DB]=$(env_value POSTGRES_DB)
  [[ ${CURRENT[POSTGRES_USER]} =~ ^[A-Za-z0-9_]+$ ]] || die "POSTGRES_USER is empty or unusual - refusing."

  local old_pg now_secret now_2fa now_cmd
  old_pg=$(file_value "$backup/.env" POSTGRES_PASSWORD)
  [[ -n $old_pg ]] || die "No POSTGRES_PASSWORD in ${backup}/.env - refusing."
  now_secret=$(env_value SECRET_KEY)
  now_2fa=$(env_value TWO_FACTOR_ENCRYPTION_KEY)
  now_cmd=$(env_value DEVICE_COMMAND_ENCRYPTION_KEY)

  local undone="${backup}/rolled-back-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$undone"
  cp -p "$ENV_FILE" "$undone/.env"
  cp -p "$DJANGO_ENV_FILE" "$undone/django.env"
  ok "The values in use now are kept in ${undone}."

  info "Stopping progeo-backend..."
  "${compose[@]}" stop progeo-backend
  info "Postgres password back..."
  set_postgres_password "$old_pg"
  info "Env files back..."
  cp -p "$backup/.env" "$ENV_FILE"
  cp -p "$backup/django.env" "$DJANGO_ENV_FILE"
  "${compose[@]}" up -d --force-recreate progeo-redis
  info "Re-encrypting back to the old keys..."
  re_encrypt "$now_secret" "$now_2fa" "$now_cmd" --apply
  restart_all
  local grafana_old
  grafana_old=$(file_value "$ENV_FILE" GRAFANA_ADMIN_PASSWORD)
  if [[ -n $grafana_old ]]; then reset_grafana_password "$grafana_old"; fi
  wait_for_backend
  ok "Rolled back to ${backup}. The leaked values are in use again - rotate again as soon as possible."
}

case "${1:-}" in
  "") dry_run ;;
  --apply) apply ;;
  --resume) resume "${2:-}" ;;
  --rollback) rollback "${2:-}" ;;
  -h|--help) sed -n '2,40p' "$0" ;;
  *) die "Unknown option $1 - see $0 --help" ;;
esac
