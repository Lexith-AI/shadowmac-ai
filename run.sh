#!/bin/zsh
# Shadow AI — macOS launcher (replaces run.ps1).
# Starts: scheduler (port 9333) + SearXNG (port 8888, if prepared) + backend server,
# then opens the app in Chrome app-mode (or the default browser).

set -u
SCRIPT_DIR="${0:a:h}"
cd "$SCRIPT_DIR"

PIDS=()
cleanup() {
  echo "\nShutting down Shadow. Goodbye!"
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  exit 0
}
trap cleanup INT TERM

# ---- pick a free port for the app ----
PORT=8000
while lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT+1)); done

echo "----------------------------------------"
echo "Initializing Shadow AI Companion Core (macOS)"
echo "----------------------------------------"
echo "App port: $PORT"

# ---- scheduler microservice (port 9333) ----
if curl -s -m 2 http://127.0.0.1:9333/api/health | grep -q healthy; then
  echo "Scheduler: reusing existing instance on 9333"
else
  SHADOW_SCHEDULER_PORT=9333 node scheduler.js &
  PIDS+=($!)
  echo "Scheduler: started (pid $!)"
fi

# ---- SearXNG (port 8888) ----
SEARX_PY="$SCRIPT_DIR/searxng/venv/bin/python"
if lsof -nP -iTCP:8888 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "SearXNG: reusing existing instance on 8888"
elif [[ -x "$SEARX_PY" && -f "$SCRIPT_DIR/searxng/app/searx/webapp.py" ]]; then
  if [[ ! -f "$SCRIPT_DIR/searxng/settings.yml" ]]; then
    SECRET=$(openssl rand -hex 32)
    cat > "$SCRIPT_DIR/searxng/settings.yml" <<EOF
use_default_settings:
  engines:
    remove:
      - ahmia
      - torch
general:
  debug: false
server:
  secret_key: "$SECRET"
  bind_address: "127.0.0.1"
  port: 8888
  limiter: false
search:
  formats:
    - html
    - json
EOF
  fi
  ( cd "$SCRIPT_DIR/searxng/app" && \
    SEARXNG_SETTINGS_PATH="$SCRIPT_DIR/searxng/settings.yml" \
    "$SEARX_PY" -m searx.webapp \
      > "$SCRIPT_DIR/searxng/searxng.log" 2> "$SCRIPT_DIR/searxng/searxng-err.log" ) &
  PIDS+=($!)
  echo "SearXNG: started (pid $!) — warming up (takes ~10s)"
  SEARX_STARTED=1
else
  echo "SearXNG: not installed — web search will be unavailable."
  echo "         Run ./tools/prepare-searxng.sh once to enable it."
fi

# ---- backend server ----
SHADOW_PORT=$PORT node server.js &
PIDS+=($!)

# wait for the backend to come up
for i in $(seq 1 50); do
  curl -s -m 1 "http://127.0.0.1:$PORT/api/health" | grep -q healthy && break
  sleep 0.1
done

# wait for SearXNG to be query-ready so the FIRST web search works
# (cold start is ~10s; the app is otherwise usable, so cap the wait at 30s).
if [[ -n "${SEARX_STARTED:-}" ]] || lsof -nP -iTCP:8888 -sTCP:LISTEN >/dev/null 2>&1; then
  printf "Waiting for web search to be ready"
  for i in $(seq 1 60); do
    if curl -s -m 1 "http://127.0.0.1:8888/search?q=ping&format=json" 2>/dev/null | grep -q '"results"'; then
      echo " ✓ ready"; break
    fi
    printf "."; sleep 0.5
    [[ $i -eq 60 ]] && echo " (still warming — search may fail for the first few seconds)"
  done
fi

# ---- open the app window ----
URL="http://127.0.0.1:$PORT/"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE="$SCRIPT_DIR/runtime/profiles/shadow_app"
mkdir -p "$PROFILE"
if [[ -x "$CHROME" ]]; then
  "$CHROME" --app="$URL" --window-size=960,800 \
    --user-data-dir="$PROFILE" \
    --auto-accept-camera-and-microphone-capture \
    --no-first-run --no-default-browser-check >/dev/null 2>&1 &
  PIDS+=($!)
else
  open "$URL"
fi

echo ""
echo "Shadow is running at $URL — keep this window open."
echo "Press Ctrl+C to shut down."
wait
