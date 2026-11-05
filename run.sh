#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f dist/index.html ]; then
  echo "dist/index.html is missing. Run: npm ci && npm run build" >&2
  exit 1
fi

PORT="${PORT:-8782}"
echo "SRT Executive Showdown is at http://127.0.0.1:${PORT}/"
echo "Press Ctrl+C to stop the server."
(sleep 1; xdg-open "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || open "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || true) &
exec env PORT="$PORT" node serve.mjs
