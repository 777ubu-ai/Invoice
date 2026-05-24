#!/bin/bash
# Run telegram-bot-api server + Node.js bot side-by-side.
# Forward SIGTERM so Railway can gracefully stop both on redeploy.
set -e

if [[ -z "${TELEGRAM_API_ID}" || -z "${TELEGRAM_API_HASH}" ]]; then
  echo "FATAL: TELEGRAM_API_ID and TELEGRAM_API_HASH must be set."
  exit 1
fi

echo "[entrypoint] starting telegram-bot-api server (--local, port 8081)..."
telegram-bot-api \
  --api-id="${TELEGRAM_API_ID}" \
  --api-hash="${TELEGRAM_API_HASH}" \
  --local \
  --http-port=8081 \
  --dir=/var/lib/telegram-bot-api \
  --temp-dir=/tmp/telegram-bot-api \
  --log=/tmp/tg-bot-api.log \
  &
TG_PID=$!

# Wait for the server to be ready (bind to 8081). Up to 30s.
echo "[entrypoint] waiting for tg-bot-api to listen on :8081..."
for i in $(seq 1 30); do
  if wget -q --spider http://localhost:8081/ 2>/dev/null || \
     curl -fs http://localhost:8081/ >/dev/null 2>&1 || \
     nc -z localhost 8081 2>/dev/null; then
    echo "[entrypoint] tg-bot-api up (after ${i}s)"
    break
  fi
  if ! kill -0 "$TG_PID" 2>/dev/null; then
    echo "[entrypoint] tg-bot-api died during startup, log tail:"
    tail -50 /tmp/tg-bot-api.log 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# Force bot to use the local server, no matter what env says.
export TELEGRAM_API_ROOT="http://localhost:8081"

echo "[entrypoint] starting bot (api_root=$TELEGRAM_API_ROOT)..."
node dist/src/main.js &
BOT_PID=$!

# Forward shutdown to both processes.
trap 'echo "[entrypoint] SIGTERM — shutting down"; kill -TERM "$BOT_PID" "$TG_PID" 2>/dev/null; wait' TERM INT

# Exit if either process dies.
wait -n "$TG_PID" "$BOT_PID"
EXIT=$?
echo "[entrypoint] one of the processes exited with $EXIT, killing the other"
kill -TERM "$BOT_PID" "$TG_PID" 2>/dev/null || true
wait
exit $EXIT
