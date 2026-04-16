#!/bin/sh
# Fly.io Debug Wrapper — all output to stderr (never buffered)
echo "[start] === Bingo AI starting ===" >&2
echo "[start] PORT=$PORT NODE_ENV=$NODE_ENV" >&2
echo "[start] PWD=$(pwd)" >&2

# Always restore trained weights from image bundle into persistent volume.
# Training is done locally and committed to git — the image is the source of truth
# for model.json. A stale or production-overwritten model.json (e.g. with wC=0) would
# silently collapse score spread to zero, making Top 10 static.
if [ -f /app/model_weights.json ]; then
  cp /app/model_weights.json /app/dataset/model.json
  echo "[start] dataset/model.json synced from image bundle (always-overwrite)" >&2
else
  echo "[start] WARNING: /app/model_weights.json not found — using volume model.json as-is" >&2
fi

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
