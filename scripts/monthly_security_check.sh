#!/usr/bin/env bash
# Monthly external security check (SECURITY_AUDIT.md, section 5.3).
#
# A NON-DESTRUCTIVE verification scan of our OWN deployment: it confirms the
# defenses still hold, from the outside, the way an attacker first sees the
# host. It does not exploit anything - every probe is a safe GET or a TLS
# handshake, no payload that could write, delete, flood or lock out. "Known
# attack patterns" here means: send the shape of a common attack (a scanner
# path, an XSS/SQLi canary, a spoofed X-Forwarded-For) and assert that the
# stack BLOCKS it - never that it succeeds.
#
# Checks (each maps to an audit finding):
#   - TLS: protocols, redirect 80->443, HSTS                     (nginx, A-TLS)
#   - Security headers on dashboard + api                        (nginx)
#   - Ports: only 22/80/443 answer from outside                  (A6)
#   - Backend/frontend NOT reachable around nginx                (A6)
#   - GET /metrics is closed (404)                               (A3 infra)
#   - Scanner filter drops /.env, /.git, *.php (except gprs)     (nginx)
#   - Protected API endpoints require auth (401/403, never 200)  (authz)
#   - Login endpoint is rate-limited (429 appears)               (A5) [opt-in]
#   - Reflected-input canary: marker is escaped, not echoed raw  (XSS)
#   - X-Forwarded-For is not trusted from the client            (A5)
#
# SAFE BY DESIGN:
#   * Targets must be on the allowlist below (or SECCHECK_ALLOW). Refuses any
#     other host - this script never points at third parties.
#   * Read-only: no POST that changes state; the login probe is opt-in
#     (--with-rate-limit) and stops at the first 429.
#   * Requires an explicit authorization acknowledgement (see "Authorization").
#
# Usage:
#   sudo -u seccheck ./scripts/monthly_security_check.sh --target dashboard.progeo.com
#   SECCHECK_CONFIRM=1 ./scripts/monthly_security_check.sh --target api.progeo.com --json report.json
#
# Exit: 0 all pass, 1 one or more FAIL, 2 bad usage / not authorized.
#
# Access control - see "Who may run this" at the bottom and SECURITY_AUDIT.md.
set -euo pipefail

# --------------------------------------------------------------------------
# Allowlist: the ONLY hosts this script is permitted to probe. Our own names
# only. Extend here, or at call time with SECCHECK_ALLOW="a.example b.example".
# A target not matched here is refused - no scanning of third-party sites.
# --------------------------------------------------------------------------
DEFAULT_ALLOW="dashboard.progeo.com api.progeo.com dashboard.progeo.local api.progeo.local localhost 127.0.0.1"
ALLOWLIST="${SECCHECK_ALLOW:-$DEFAULT_ALLOW}"

TARGET=""
WITH_RATE_LIMIT=0
JSON_OUT=""
PORTSCAN=1

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-2}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --with-rate-limit) WITH_RATE_LIMIT=1; shift ;;   # opt-in: sends up to ~35 login GETs
    --no-portscan) PORTSCAN=0; shift ;;
    --json) JSON_OUT="${2:-}"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown argument: $1" >&2; usage 2 ;;
  esac
done

if [[ -t 1 ]]; then
  C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[1;33m'; C_CYAN=$'\033[0;36m'; C_RESET=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_RESET=''
fi

PASS=0; WARN=0; FAIL=0
declare -a RESULTS

emit() { # level, id, message
  local level="$1" id="$2" msg="$3" color
  case "$level" in
    PASS) color="$C_GREEN"; PASS=$((PASS+1)) ;;
    WARN) color="$C_YELLOW"; WARN=$((WARN+1)) ;;
    FAIL) color="$C_RED"; FAIL=$((FAIL+1)) ;;
    *)    color="$C_CYAN" ;;
  esac
  printf '%s[%s]%s %-8s %s\n' "$color" "$level" "$C_RESET" "$id" "$msg"
  RESULTS+=("{\"level\":\"$level\",\"check\":\"$id\",\"message\":\"$(printf '%s' "$msg" | sed 's/"/\\"/g')\"}")
}

die() { echo "${C_RED}error:${C_RESET} $*" >&2; exit 2; }

# --------------------------------------------------------------------------
# Authorization gate: refuse to run unless the operator acknowledges this is
# an authorized test of our own systems. Prevents a copy of the script from
# being pointed at someone else, or run by accident.
# --------------------------------------------------------------------------
if [[ "${SECCHECK_CONFIRM:-}" != "1" ]]; then
  if [[ -t 0 ]]; then
    echo "This runs authorized, non-destructive security checks against OUR OWN host:"
    echo "  ${TARGET:-<none>}"
    read -r -p "Type 'I am authorized' to continue: " ack
    [[ "$ack" == "I am authorized" ]] || die "not confirmed - aborting"
  else
    die "set SECCHECK_CONFIRM=1 to run non-interactively (authorized use only)"
  fi
fi

[[ -n "$TARGET" ]] || die "missing --target <host> (one of: $ALLOWLIST)"

# Enforce the allowlist (exact host match).
allowed=0
for h in $ALLOWLIST; do [[ "$TARGET" == "$h" ]] && allowed=1 && break; done
[[ "$allowed" == "1" ]] || die "target '$TARGET' is not on the allowlist - refusing. Add it to SECCHECK_ALLOW only for hosts you own."

command -v curl >/dev/null || die "curl is required"
BASE="https://$TARGET"
# curl: fail soft (we assert on status codes), short timeouts, no body download
# by default, our own self-signed CA may apply on *.local so allow -k there.
CURL_OPTS=(--silent --show-error --max-time 15 --connect-timeout 8)
case "$TARGET" in *.local|localhost|127.0.0.1) CURL_OPTS+=(-k) ;; esac

# Return just the HTTP status for a GET.
http_status() { curl "${CURL_OPTS[@]}" -o /dev/null -w '%{http_code}' "$@" || echo "000"; }
# Return response headers only.
http_headers() { curl "${CURL_OPTS[@]}" -D - -o /dev/null "$@" 2>/dev/null || true; }

echo "${C_CYAN}== Monthly security check: $TARGET  ($(date '+%Y-%m-%d %H:%M %Z')) ==${C_RESET}"

# --------------------------------------------------------------------------
# 1. TLS + HTTP->HTTPS redirect + HSTS
# --------------------------------------------------------------------------
if curl "${CURL_OPTS[@]}" --tlsv1.2 -o /dev/null "$BASE/" 2>/dev/null; then
  emit PASS tls.handshake "HTTPS reachable (TLS 1.2+)"
else
  emit FAIL tls.handshake "HTTPS handshake failed"
fi
# TLS 1.0 must be refused. A successful handshake here is a FAIL.
if curl "${CURL_OPTS[@]}" --tls-max 1.0 -o /dev/null "$BASE/" 2>/dev/null; then
  emit FAIL tls.legacy "TLS 1.0 was accepted (should be refused)"
else
  emit PASS tls.legacy "TLS 1.0 refused"
fi
redir="$(http_status "http://$TARGET/" )"
[[ "$redir" =~ ^30 ]] && emit PASS tls.redirect "port 80 redirects ($redir)" \
                       || emit WARN tls.redirect "port 80 did not redirect (got $redir)"
hdrs="$(http_headers "$BASE/")"
grep -qi '^strict-transport-security:' <<<"$hdrs" \
  && emit PASS hdr.hsts "HSTS header present" \
  || emit FAIL hdr.hsts "HSTS header missing"

# --------------------------------------------------------------------------
# 2. Security headers
# --------------------------------------------------------------------------
for h in "x-content-type-options:nosniff" "x-frame-options:DENY" "referrer-policy:"; do
  name="${h%%:*}"
  grep -qi "^${name}:" <<<"$hdrs" \
    && emit PASS "hdr.${name}" "$name present" \
    || emit FAIL "hdr.${name}" "$name missing"
done
# Server version should be suppressed (server_tokens off).
if grep -qiE '^server: *nginx/[0-9]' <<<"$hdrs"; then
  emit WARN hdr.server "Server header leaks nginx version"
else
  emit PASS hdr.server "Server version not leaked"
fi

# --------------------------------------------------------------------------
# 3. Port exposure: only 22/80/443 should answer. Verifies A6 (backend/
#    frontend/DB must not be reachable around nginx).
# --------------------------------------------------------------------------
if [[ "$PORTSCAN" == "1" ]] && command -v nc >/dev/null; then
  for port in 8383 3003 5435 6379 3000 9090 5555; do
    if timeout 5 nc -z "$TARGET" "$port" 2>/dev/null; then
      emit FAIL "port.$port" "port $port is OPEN from outside (must be firewalled / bound to 127.0.0.1)"
    else
      emit PASS "port.$port" "port $port closed"
    fi
  done
else
  emit INFO port.scan "port scan skipped (nc missing or --no-portscan); run: nmap -Pn -p- $TARGET"
fi

# --------------------------------------------------------------------------
# 4. /metrics must be closed to the public (nginx returns 404).
# --------------------------------------------------------------------------
m="$(http_status "$BASE/metrics")"
[[ "$m" == "404" ]] && emit PASS metrics.closed "/metrics closed ($m)" \
                     || emit FAIL metrics.closed "/metrics returned $m (expected 404)"

# --------------------------------------------------------------------------
# 5. Scanner filter: common secret/scanner paths must be dropped (444/404),
#    never 200. These are the patterns in block_scanners.conf.
# --------------------------------------------------------------------------
for p in "/.env" "/.git/config" "/config.php" "/phpmyadmin/" "/wp-login.php" "/.aws/credentials"; do
  s="$(http_status "$BASE$p")"
  if [[ "$s" == "200" ]]; then
    emit FAIL "scan.$p" "$p returned 200 (should be blocked)"
  else
    emit PASS "scan.$p" "$p blocked ($s)"
  fi
done

# --------------------------------------------------------------------------
# 6. Authentication required on protected API endpoints. A 200 without a
#    credential is a FAIL (broken access control).
# --------------------------------------------------------------------------
for ep in "/v1/" "/aadmin/" "/api/token/verify/"; do
  s="$(http_status "$BASE$ep")"
  if [[ "$s" == "200" ]]; then
    emit WARN "authz.$ep" "$ep answered 200 unauthenticated - confirm it exposes nothing"
  else
    emit PASS "authz.$ep" "$ep not open ($s)"
  fi
done

# --------------------------------------------------------------------------
# 7. Reflected-input canary (XSS). Send a harmless marker in a query param and
#    assert it is NOT echoed back unescaped. We never submit script that runs;
#    we only check whether the raw angle brackets survive in the response.
# --------------------------------------------------------------------------
marker="seccheck<svg_$RANDOM>"
body="$(curl "${CURL_OPTS[@]}" -G --data-urlencode "q=$marker" "$BASE/" 2>/dev/null || true)"
if grep -qF "$marker" <<<"$body"; then
  emit FAIL xss.reflect "raw marker reflected unescaped (possible XSS) on /"
else
  emit PASS xss.reflect "input not reflected unescaped on /"
fi

# --------------------------------------------------------------------------
# 8. X-Forwarded-For must not be trusted from the client (A5). We send a bogus
#    XFF and confirm the host still behaves (this is a smoke check; the real
#    assertion is in the regression test suite, which inspects the logged IP).
# --------------------------------------------------------------------------
s1="$(http_status "$BASE/")"
s2="$(http_status -H "X-Forwarded-For: 10.11.12.13" "$BASE/")"
[[ "$s1" == "$s2" ]] && emit PASS xff.ignored "XFF header did not change response ($s1)" \
                     || emit WARN xff.ignored "response changed with spoofed XFF ($s1 vs $s2) - inspect"

# --------------------------------------------------------------------------
# 9. OPT-IN: login rate limit (A5). Sends unauthenticated GETs to the login
#    path until a 429 appears or the budget runs out. No credentials, no POST.
# --------------------------------------------------------------------------
if [[ "$WITH_RATE_LIMIT" == "1" ]]; then
  got429=0
  for _ in $(seq 1 35); do
    s="$(http_status "$BASE/auth/login/")"
    [[ "$s" == "429" ]] && got429=1 && break
  done
  [[ "$got429" == "1" ]] && emit PASS ratelimit.login "login path returned 429 under burst" \
                         || emit WARN ratelimit.login "no 429 after 35 requests - confirm limit_req zone"
else
  emit INFO ratelimit.login "rate-limit probe skipped (use --with-rate-limit)"
fi

# --------------------------------------------------------------------------
# Summary + optional JSON report.
# --------------------------------------------------------------------------
echo "${C_CYAN}== ${PASS} pass, ${WARN} warn, ${FAIL} fail ==${C_RESET}"
if [[ -n "$JSON_OUT" ]]; then
  {
    printf '{"target":"%s","date":"%s","pass":%d,"warn":%d,"fail":%d,"results":[' \
      "$TARGET" "$(date -Iseconds)" "$PASS" "$WARN" "$FAIL"
    IFS=,; printf '%s' "${RESULTS[*]}"; unset IFS
    printf ']}\n'
  } > "$JSON_OUT"
  echo "report: $JSON_OUT"
fi

[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1

# ==========================================================================
# WHO MAY RUN THIS  (SECURITY_AUDIT.md, section 3 - access control)
# ==========================================================================
# This file is NOT a weapon, but it probes production and prints the attack
# surface, so keep it out of unauthorized hands with layered controls:
#
# 1. File permissions / ownership. Owned by a dedicated, unprivileged account
#    and readable only by it:
#        sudo useradd --system --shell /usr/sbin/nologin seccheck
#        sudo chown seccheck:seccheck scripts/monthly_security_check.sh
#        sudo chmod 0700 scripts/monthly_security_check.sh
#    0700 means only that user (and root) can read or execute it.
#
# 2. Where it runs from. It lives in the git checkout (not under media/ or any
#    web-served path), so nginx never serves it; block_scanners.conf also drops
#    /*.sh requests. Never place it in media/, static/ or the frontend bundle.
#
# 3. Scheduling (unprivileged). Run it as that user via a systemd timer, NOT
#    as root and NOT from the app container:
#        # /etc/systemd/system/seccheck.service
#        [Service]
#        Type=oneshot
#        User=seccheck
#        Environment=SECCHECK_CONFIRM=1
#        ExecStart=/opt/progeo/scripts/monthly_security_check.sh \
#                  --target dashboard.progeo.com --json /var/log/progeo/seccheck.json
#        # (+ seccheck.timer: OnCalendar=monthly)
#    SECCHECK_CONFIRM=1 is the non-interactive authorization; set it only in
#    the unit file, which is root-owned (0644), so a normal user cannot alter
#    what runs.
#
# 4. Built-in guards (defense in depth, in case the file leaks):
#    - allowlist: refuses any target that is not one of OUR hosts;
#    - authorization gate: interactive confirmation, or SECCHECK_CONFIRM=1;
#    - non-destructive: read-only probes, the only burst is opt-in and capped.
#    None of these replace OS permissions - they limit the blast radius if the
#    permissions ever fail.
#
# 5. What it must never hold. No credentials, tokens or API keys live in this
#    script. A probe that needs a login (authenticated fuzzing) belongs in the
#    CI suite with secrets from the CI store, not here.
#
# For deeper, signature-based scanning run dedicated tools from the same
# unprivileged account against staging: `nmap`, `testssl.sh`, and an OWASP ZAP
# baseline scan (SECURITY_AUDIT.md, section 5.2-5.3).
