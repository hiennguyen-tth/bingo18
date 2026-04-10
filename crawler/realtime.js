'use strict'
/**
 * crawler/realtime.js
 * Runs the crawler on a recurring interval (default 60 s).
 *
 * Usage:  node crawler/realtime.js
 *         CRAWL_INTERVAL=30000 node crawler/realtime.js
 */
const { run } = require('./crawl')

const INTERVAL_MS = parseInt(process.env.CRAWL_INTERVAL) || 60_000

async function tick() {
  const ts = new Date().toISOString()
  console.log(`[realtime] ${ts} — crawling…`)
  await run().catch(err => console.error('[realtime] crawl error:', err.message))
}

console.log(`[realtime] started — interval: ${INTERVAL_MS / 1000}s`)
tick()
setInterval(tick, INTERVAL_MS)
