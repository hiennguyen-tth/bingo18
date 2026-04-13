#!/bin/sh
# Fly.io Debug Wrapper — all output to stderr (never buffered)
echo "[start] === Bingo AI starting ===" >&2
echo "[start] PORT=$PORT NODE_ENV=$NODE_ENV" >&2
echo "[start] PWD=$(pwd)" >&2

# Seed trained weights into persistent volume on first boot.
# /app/dataset is a Fly volume; /app/model_weights.json is baked into the image.
if [ ! -f /app/dataset/model.json ] && [ -f /app/model_weights.json ]; then
  cp /app/model_weights.json /app/dataset/model.json
  echo "[start] Seeded dataset/model.json from image (first-boot)" >&2
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
