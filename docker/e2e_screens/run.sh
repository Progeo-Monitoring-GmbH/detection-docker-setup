#!/bin/sh
# Entrypoint of progeo-e2e_screens (Dockerfile): starts the frontend's dev
# server against the mocked API origin, waits for it, takes the screenshots
# (frontend/e2e/screenshots/capture.mjs) into /workspace/out and stops the
# server. SCREENS_RUN, SCREENS_DEVICES, SCREENS_ROLES, SCREENS_ONLY come from
# the Docker agent (progeo/docker_agent/ops.py run_e2e_screens).
set -eu

PORT=3299
# The API origin the frontend is built against - nothing listens there, the
# capture answers every request itself (keep in step with MOCK_ORIGIN in
# progeo/management/commands/e2e_screenshots.py).
MOCK_ORIGIN=http://127.0.0.1:59999

if [ ! -d /workspace/out ] || [ ! -w /workspace/out ]; then
    # What to look at: who runs here and who owns the mounted folder.
    echo "/workspace/out (the run's folder) is missing or not writable for $(id -u):$(id -g)" >&2
    ls -ldn /workspace/out >&2 || true
    exit 2
fi
mkdir -p /workspace/out/pc /workspace/out/mobile

echo "Starting the frontend dev server on port ${PORT} ..."
VITE_BACKEND_URL="$MOCK_ORIGIN" VITE_WS_URL="ws://127.0.0.1:59999" \
    npx vite --mode development --port "$PORT" --strictPort --host 127.0.0.1 > /tmp/vite.log 2>&1 &
VITE_PID=$!
trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT INT TERM

ready=0
for _ in $(seq 1 120); do
    if node -e "fetch('http://127.0.0.1:${PORT}/').then(() => process.exit(0), () => process.exit(1))"; then
        ready=1
        break
    fi
    if ! kill -0 "$VITE_PID" 2>/dev/null; then
        break
    fi
    sleep 1
done
if [ "$ready" != 1 ]; then
    echo "The dev server did not start:" >&2
    tail -n 40 /tmp/vite.log >&2
    exit 1
fi

SCREENS_OUT=/workspace/out \
SCREENS_BASE="http://127.0.0.1:${PORT}" \
SCREENS_MOCK_ORIGIN="$MOCK_ORIGIN" \
    node e2e/screenshots/capture.mjs
