#!/bin/sh
# Fly.io Debug Wrapper — all output to stderr (never buffered)
echo "[start] === Bingo AI starting ===" >&2
echo "[start] PORT=$PORT NODE_ENV=$NODE_ENV" >&2
echo "[start] PWD=$(pwd)" >&2

# Confirm critical files exist
for f in api/server.js web/index.html predictor/ensemble.js crawler/crawl.js; do
  if [ -f "$f" ]; then
    echo "[start] OK: $f" >&2
  else
    echo "[start] MISSING: $f" >&2
  fi
done

echo "[start] Starting node..." >&2
exec node api/server.js
