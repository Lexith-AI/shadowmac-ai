#!/bin/zsh
# Prepares a local SearXNG (the search engine Shadow uses) on macOS.
# Equivalent of tools/prepare-searxng.ps1 — no Windows patches needed.
set -eu
SCRIPT_DIR="${0:a:h:h}"   # repo root
OUT="$SCRIPT_DIR/searxng"
PY=$(command -v python3.12 || command -v python3.11 || command -v python3)

echo "Using Python: $PY"
mkdir -p "$OUT"

if [[ ! -d "$OUT/app/.git" ]]; then
  echo "Cloning SearXNG..."
  git clone --depth 1 --branch master https://github.com/searxng/searxng.git "$OUT/app"
else
  echo "SearXNG already cloned."
fi

if [[ ! -x "$OUT/venv/bin/python" ]]; then
  echo "Creating venv..."
  "$PY" -m venv "$OUT/venv"
fi

echo "Installing requirements (this takes a few minutes)..."
"$OUT/venv/bin/pip" install -q --upgrade pip setuptools wheel
"$OUT/venv/bin/pip" install -q -r "$OUT/app/requirements.txt"
"$OUT/venv/bin/pip" install -q -e "$OUT/app" 2>/dev/null || true

echo "Done. SearXNG will start automatically with ./run.sh"
