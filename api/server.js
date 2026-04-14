'use strict'

// ── Global safeguards — MUST be first, before any require that could throw ──────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err.message, err.stack)
  process.exit(1)  // exit(1) so Fly/PM2 restarts the container
})
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason)
  process.exit(1)
})

console.log('[startup] loading modules...')
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })
/**
 * api/server.js
 * Express REST API + Server-Sent Events for real-time push.
 *
 * Crawler runs inside this process every CRAWL_INTERVAL ms.
 * When new draws arrive, all SSE clients get a "new-draw" event
 * and the React dashboard reloads its data automatically.
 *
 * Routes:
 *   GET /         → index.html (with ADSENSE_PUBLISHER_ID injected)
 *   GET /events   → SSE stream
 *   GET /predict  → top-10 combo scores + sum distribution
 *   GET /history  → last N records  (?limit=50)
 *   GET /overdue  → overdue stats for triples/pairs/sums
 *   GET /stats    → walk-forward backtest accuracy
 *   POST /crawl   → manual crawl trigger
 *   GET /health   → liveness probe
 *
 * Usage: node api/server.js
 */
const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs-extra')
const compression = require('compression')

const predict = require('../predictor/ensemble')
const frequency = require('../predictor/frequency')
const features = require('../predictor/features')
const { runStatTests } = require('../predictor/stats_tests')
const { run: crawlRun } = require('../crawler/crawl')

const app = express()
const PORT = parseInt(process.env.PORT) || 8080
const ADSENSE_PUBLISHER_ID = process.env.ADSENSE_PUBLISHER_ID || ''
const HISTORY_FILE = path.join(__dirname, '../dataset/history.json')

// Read index.html once at startup; inject ADSENSE_PUBLISHER_ID per request
const INDEX_TPL = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8')

// ── History file watcher: invalidate cache on ANY external change ────────
// Belt-and-suspenders: covers manual edits, dedup runs, or missed crawl events.
// Also broadcasts SSE so clients reload immediately — needed when crawl runs
// in a separate process (e.g. node crawler/realtime.js in dev).
fs.watchFile(HISTORY_FILE, { interval: 3000, persistent: false }, (curr, prev) => {
  if (curr.mtime > prev.mtime) {
    console.log('[cache] history.json changed externally — invalidating + SSE')
    invalidateCache()
    // Small delay to ensure file write is fully flushed before we broadcast
    setTimeout(() => {
      broadcast('new-draw', { added: 0, latestKy: '?', total: 0, ts: new Date().toISOString(), source: 'watcher' })
    }, 500)
  }
})

// ── SSE client registry ───────────────────────────────────────────────────
const sseClients = new Set()

function broadcast(eventName, data) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    try { res.write(msg) } catch (_) { sseClients.delete(res) }
  }
}

// ── In-memory cache (invalidated when crawl finds new data) ───────────────
const apiCache = new Map()  // key → { data, ts }

function invalidateCache() {
  apiCache.clear()
}

/**
 * Wraps an async handler with a simple in-memory cache.
 * @param {string}   key    - cache key
 * @param {number}   ttlMs  - hard TTL (safety net); 0 = rely on invalidation only
 * @param {Function} fn     - async (req) => data to cache
 */
function withCache(key, ttlMs, fn) {
  return async (req, res) => {
    const now = Date.now()
    const hit = apiCache.get(key)
    if (hit && (ttlMs === 0 || now - hit.ts < ttlMs)) {
      res.set('X-Cache', 'HIT')
      return res.json(hit.data)
    }
    try {
      const data = await fn(req)
      apiCache.set(key, { data, ts: now })
      res.set('X-Cache', 'MISS')
      res.json(data)
    } catch (err) {
      console.error(`[${key}]`, err.message)
      res.status(500).json({ error: err.message })
    }
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────
// Skip compression for SSE — gzip buffering breaks real-time streaming
app.use(compression({
  filter: (req, res) => {
    if (req.path === '/events') return false
    return compression.filter(req, res)
  }
}))
app.use(cors())
app.use(express.json())

// Inject ADSENSE placeholders and return the processed HTML
function renderIndex() {
  const adScript = ADSENSE_PUBLISHER_ID
    ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_PUBLISHER_ID}" crossorigin="anonymous"></script>`
    : ''
  return INDEX_TPL
    .replace('{{ADSENSE_PUBLISHER_ID}}', ADSENSE_PUBLISHER_ID)
    .replace('{{ADSENSE_SCRIPT}}', adScript)
}

// Serve index.html with placeholders injected — covers both / and /index.html
// Must come BEFORE express.static so static never serves the raw template
app.get(['/', '/index.html'], (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(renderIndex())
})

// ── SEO / Content pages — clean URL routes ────────────────────────────────
const WEB_DIR = path.join(__dirname, '../web')

app.get('/about', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.sendFile(path.join(WEB_DIR, 'about.html'))
})

app.get('/how-it-works', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.sendFile(path.join(WEB_DIR, 'how-it-works.html'))
})

app.get('/blog/what-is-bingo18', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.sendFile(path.join(WEB_DIR, 'blog/what-is-bingo18.html'))
})

app.get('/blog/best-strategy-2026', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.sendFile(path.join(WEB_DIR, 'blog/best-strategy-2026.html'))
})

app.get('/privacy-policy', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.sendFile(path.join(WEB_DIR, 'privacy-policy.html'))
})

app.get('/sitemap.xml', (_req, res) => {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8')
  res.sendFile(path.join(WEB_DIR, 'sitemap.xml'))
})

app.get('/ads.txt', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.sendFile(path.join(WEB_DIR, 'ads.txt'))
})

// Static assets (app.jsx, heatmap.jsx, css…) — index.html excluded above
app.use(express.static(path.join(__dirname, '../web'), { index: false }))

// ── Helper ─────────────────────────────────────────────────────────────────
async function loadHistory() {
  const data = await fs.readJSON(HISTORY_FILE).catch(() => [])
  // Guard against corruption: must be a non-empty array of draw objects
  if (!Array.isArray(data) || data.length === 0) return []
  return data
}

// ── Routes ─────────────────────────────────────────────────────────────────

/** GET /predict — ensemble prediction scores + sum distribution */
app.get('/predict', withCache('predict', 5 * 60_000, async () => {
  const data = await loadHistory()

  if (data.length < 2) {
    return {
      next: [],
      sumStats: [],
      total: data.length,
      message: 'Not enough data — run: node crawler/crawl.js',
    }
  }

  // Ranked predictions with full breakdown
  const { top10, tripleSignal } = predict.ranked(data)

  // pct = share within top-10 so they sum to 100%
  const top10Total = top10.reduce((s, r) => s + r.score, 0) || 1
  const maxScore = top10[0]?.score || 1
  const minScore = top10[top10.length - 1]?.score || 0
  const scoreSpread = maxScore - minScore || 1

  const next = top10.map(r => ({
    combo: r.combo,
    score: +r.score.toFixed(3),
    // pct = share of top-10 total score (uncapped — display as-is)
    pct: +(r.score / top10Total * 100).toFixed(1),
    // confidence = calibrated [35–80%] based on score spread within top-10
    // Rank 1 → ~78%, Rank 10 → ~35%; varies meaningfully by model strength
    confidence: Math.round(35 + ((r.score - minScore) / scoreSpread) * 45),
    overdueRatio: r.overdueRatio != null ? +r.overdueRatio.toFixed(2) : null,
    comboGap: r.comboGap,
    sumOD: +(r.sumOD ?? 0).toFixed(2),
    pat: r.pat,
    stability: r.stability != null ? +r.stability.toFixed(2) : null,
    // 4-model breakdown (v5)
    zScore: r.zScore != null ? +r.zScore.toFixed(2) : null,
    statNorm: r.statNorm ?? 0,
    mk2Norm: r.mk2Norm ?? 0,
    sessNorm: r.sessNorm ?? 0,
    mlNorm: r.mlNorm ?? 0,
    // legacy compat
    coreNorm: r.coreNorm ?? 0,
    chiNorm: 0,
  }))

  // Sum distribution
  const sumBucket = {}
  for (const d of data) sumBucket[d.sum] = (sumBucket[d.sum] || 0) + 1
  const sumStats = Object.entries(sumBucket)
    .map(([sum, cnt]) => ({ sum: +sum, pct: +(cnt / data.length * 100).toFixed(2) }))
    .sort((a, b) => b.pct - a.pct)

  return { next, tripleSignal, sumStats, total: data.length, maxScore: +maxScore.toFixed(3) }
}))

/** GET /ml-status — Model D (k-NN) readiness + dataset stats */
app.get('/ml-status', async (_req, res) => {
  try {
    const data = await loadHistory()
    const chron = [...data].sort((a, b) => Number(a.ky) - Number(b.ky))
    const N = chron.length
    // Model D needs WINDOW(8) + K_MIN(15) + 1 = 24 draws minimum
    const ML_MIN = 24
    res.json({
      modelD: {
        name: 'k-NN Temporal Similarity',
        active: N >= ML_MIN,
        records: N,
        minRequired: ML_MIN,
        kNeighbors: Math.min(60, Math.max(15, Math.floor((N - 9) * 0.05))),
        window: 8,
      },
      pythonGBM: {
        name: 'Gradient Boosting (offline)',
        script: 'python python/ml_predictor.py',
        note: 'Run locally to generate python/ml_output.json for hybrid scoring',
      },
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** GET /history — raw records (?limit=50), newest first */
app.get('/history', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
    res.set('Pragma', 'no-cache')
    const data = await loadHistory()
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 500)
    res.json({ records: data.slice(0, limit), total: data.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** GET /frequency — sorted combo hit-count table */
app.get('/frequency', withCache('frequency', 5 * 60_000, async () => {
  const data = await loadHistory()
  if (data.length === 0) return { freq: {}, total: 0 }

  const freq = frequency(data)
  const sorted = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)

  return { freq: Object.fromEntries(sorted), total: data.length }
}))

/**
 * GET /stats — walk-forward backtest accuracy + statistical reality check.
 *
 * Walk-forward: train on i-1 draws, predict draw i.
 * Segmented: train (first 60%), valid (next 20%), forward (last 20%)
 *   → lets you spot overfitting if valid/forward accuracy diverges from train.
 *
 * Statistical tests (chiSquare, autocorr, runs):
 *   → p < 0.05 means that specific test found evidence of non-randomness.
 *   → If all p > 0.05: data consistent with random → Models A/B/D
 *     are working on noise; wA=0.46 may just be fit noise.
 */
app.get('/stats', withCache('stats', 5 * 60_000, async () => {
  const data = await loadHistory()
  const WINDOW = 10
  if (data.length < WINDOW + 2) {
    return { message: 'Need more data', total: data.length, needed: WINDOW + 2 }
  }

  // Data is newest-first in file; reverse for chronological order
  const chron = [...data].reverse()
  const N = chron.length

  // Segment boundaries (by draw index in chron)
  const trainEnd = Math.floor(N * 0.6)
  const validEnd = Math.floor(N * 0.8)

  // Overall counters
  let top1 = 0, top3 = 0, top10 = 0, tested = 0

  // Per-segment counters: train / valid / forward
  const seg = {
    train: { top1: 0, top3: 0, top10: 0, tested: 0 },
    valid: { top1: 0, top3: 0, top10: 0, tested: 0 },
    forward: { top1: 0, top3: 0, top10: 0, tested: 0 },
  }

  for (let i = WINDOW; i < N; i++) {
    const slice = chron.slice(0, i)
    // Use predict.ranked() — same pipeline as production (diversity cap + triple boost)
    const ranked = predict.ranked(slice)
    if (!ranked || !ranked.top10 || ranked.top10.length === 0) continue

    const actual = `${chron[i].n1}-${chron[i].n2}-${chron[i].n3}`
    const top = ranked.top10.map(r => r.combo)

    const hit1 = top[0] === actual
    const hit3 = top.slice(0, 3).some(c => c === actual)
    const hit10 = top.slice(0, 10).some(c => c === actual)

    if (hit1) top1++
    if (hit3) top3++
    if (hit10) top10++
    tested++

    const segKey = i < trainEnd ? 'train' : i < validEnd ? 'valid' : 'forward'
    seg[segKey].tested++
    if (hit1) seg[segKey].top1++
    if (hit3) seg[segKey].top3++
    if (hit10) seg[segKey].top10++
  }

  const baseline = {
    top1: +(1 / 216 * 100).toFixed(2),
    top3: +(3 / 216 * 100).toFixed(2),
    top10: +(10 / 216 * 100).toFixed(2),
  }

  // Build segmented accuracy object
  const segments = {}
  for (const [name, s] of Object.entries(seg)) {
    const t = s.tested
    segments[name] = {
      tested: t,
      top1: t ? +(s.top1 / t * 100).toFixed(2) : 0,
      top3: t ? +(s.top3 / t * 100).toFixed(2) : 0,
      top10: t ? +(s.top10 / t * 100).toFixed(2) : 0,
    }
  }

  // Statistical reality check — runs OUTSIDE the backtest loop (cheap O(N))
  const statTests = runStatTests(chron)

  return {
    tested,
    total: N,
    accuracy: {
      top1: tested ? +(top1 / tested * 100).toFixed(2) : 0,
      top3: tested ? +(top3 / tested * 100).toFixed(2) : 0,
      top10: tested ? +(top10 / tested * 100).toFixed(2) : 0,
    },
    hits: { top1, top3, top10 },
    baseline,
    segments,
    statTests,
  }
}))

/** GET /features — last 20 feature vectors */
app.get('/features', async (req, res) => {
  try {
    const data = await loadHistory()
    const feat = features(data)
    res.json({ features: feat.slice(-20), total: feat.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /overdue — overdue statistics for triples, pairs, and sums (cached)
 */
app.get('/overdue', withCache('overdue', 5 * 60_000, async () => {
  const data = await loadHistory()
  if (data.length === 0) return { triples: [], pairs: [], sums: [] }

  // Data is newest-first; reverse to get chronological order for interval calc
  const chron = [...data].reverse()
  const N = chron.length

  // ── Helper: compute stats for an arbitrary key function ───────────────
  function computeStats(keyFn, labelFn) {
    const lastSeen = {}  // key → index of last appearance (chronological)
    const counts = {}
    const gaps = {}  // key → array of intervals between appearances

    chron.forEach((r, i) => {
      const k = keyFn(r)
      if (!Array.isArray(k)) {
        const ks = [k]
        ks.forEach(key => {
          counts[key] = (counts[key] || 0) + 1
          if (lastSeen[key] !== undefined) {
            if (!gaps[key]) gaps[key] = []
            gaps[key].push(i - lastSeen[key])
          }
          lastSeen[key] = i
        })
      } else {
        k.forEach(key => {
          counts[key] = (counts[key] || 0) + 1
          if (lastSeen[key] !== undefined) {
            if (!gaps[key]) gaps[key] = []
            gaps[key].push(i - lastSeen[key])
          }
          lastSeen[key] = i
        })
      }
    })

    return Object.keys(counts).map(key => {
      const appeared = counts[key]
      const kySince = lastSeen[key] !== undefined ? (N - 1 - lastSeen[key]) : N
      const avgGap = gaps[key]?.length
        ? +(gaps[key].reduce((a, b) => a + b, 0) / gaps[key].length).toFixed(1)
        : N   // never repeated → use full history as avg
      const overdueScore = kySince / (avgGap || 1)   // > 1 means overdue
      return {
        key,
        label: labelFn ? labelFn(key) : key,
        appeared,
        kySinceLast: kySince,
        avgInterval: avgGap,
        overdueScore: +overdueScore.toFixed(2),
      }
    }).sort((a, b) => b.overdueScore - a.overdueScore)
  }

  // ── Triples: 1-1-1 … 6-6-6 ───────────────────────────────────────────
  const TRIPLES = ['1-1-1', '2-2-2', '3-3-3', '4-4-4', '5-5-5', '6-6-6']
  const tripleStats = computeStats(
    r => {
      const k = `${r.n1}-${r.n2}-${r.n3}`
      return TRIPLES.includes(k) ? [k] : []
    },
    k => k.replace(/-/g, '')
  )
  // Ensure all 6 triples appear even if never seen
  const tripleKeys = new Set(tripleStats.map(t => t.key))
  const tripleResult = [
    ...tripleStats,
    ...TRIPLES.filter(k => !tripleKeys.has(k)).map(k => ({
      key: k, label: k.replace(/-/g, ''), appeared: 0,
      kySinceLast: N, avgInterval: N, overdueScore: 1,
    }))
  ].sort((a, b) => b.overdueScore - a.overdueScore)

  // ── "Any triple" aggregate row \u2014 tracks when ANY triple last appeared ────────
  let sinceAnyTriple = 0
  let lastTripleIdx = -1
  const anyTripleGaps = []
  chron.forEach((r, i) => {
    const pat = r.pattern || (r.n1 === r.n2 && r.n2 === r.n3 ? 'triple' : 'other')
    if (pat === 'triple') {
      if (lastTripleIdx >= 0) anyTripleGaps.push(i - lastTripleIdx)
      lastTripleIdx = i
    }
  })
  sinceAnyTriple = lastTripleIdx >= 0 ? N - 1 - lastTripleIdx : N
  const avgAnyTripleGap = anyTripleGaps.length
    ? +(anyTripleGaps.reduce((a, b) => a + b, 0) / anyTripleGaps.length).toFixed(1)
    : 36
  const anyTriple = {
    key: 'any-triple',
    label: 'XXX',
    appeared: tripleResult.reduce((s, t) => s + t.appeared, 0),
    kySinceLast: sinceAnyTriple,
    avgInterval: avgAnyTripleGap,
    overdueScore: +(sinceAnyTriple / (avgAnyTripleGap || 36)).toFixed(2),
  }

  // ── Pairs: 11, 22, 33, 44, 55, 66 ────────────────────────────────────
  // A draw contributes to pair "VV" if at least two of its numbers equal V.
  // Triples (1-1-1) also count as pair 11.
  const PAIR_VALS = [1, 2, 3, 4, 5, 6]
  const pairStats = computeStats(
    r => {
      if (r.n1 === r.n2 || r.n1 === r.n3) return [`pair-${r.n1}`]
      if (r.n2 === r.n3) return [`pair-${r.n2}`]
      return []
    },
    k => {
      const v = k.replace('pair-', '')
      return `${v}${v}`
    }
  )
  // Ensure all 6 pairs appear
  const pairKeys = new Set(pairStats.map(p => p.key))
  const pairResult = [
    ...pairStats,
    ...PAIR_VALS.filter(v => !pairKeys.has(`pair-${v}`)).map(v => ({
      key: `pair-${v}`, label: `${v}${v}`, appeared: 0,
      kySinceLast: N, avgInterval: N, overdueScore: 1,
    }))
  ].sort((a, b) => b.overdueScore - a.overdueScore)

  // ── Sums 3-18 ─────────────────────────────────────────────────────────
  const sumStats = computeStats(r => [`sum-${r.sum}`], k => k.replace('sum-', ''))
  // Ensure all sums appear
  const sumKeys = new Set(sumStats.map(s => s.key))
  const sumResult = [
    ...sumStats,
    ...Array.from({ length: 16 }, (_, i) => `sum-${i + 3}`)
      .filter(k => !sumKeys.has(k))
      .map(k => ({
        key: k, label: k.replace('sum-', ''), appeared: 0,
        kySinceLast: N, avgInterval: N, overdueScore: 1,
      }))
  ].sort((a, b) => b.overdueScore - a.overdueScore)

  return {
    total: N,
    triples: tripleResult,
    anyTriple,
    pairs: pairResult,
    sums: sumResult,
  }
}))

/** GET /events — SSE stream */
app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  })
  res.flushHeaders()

  // Heartbeat to keep connection alive through proxies (every 15s)
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n') } catch (_) { clearInterval(hb) }
  }, 15_000)

  sseClients.add(res)
  console.log(`[SSE] +1 client (total: ${sseClients.size})`)

  req.on('close', () => {
    clearInterval(hb)
    sseClients.delete(res)
    console.log(`[SSE] -1 client (total: ${sseClients.size})`)
  })
})

/** GET /health — detailed liveness probe */
app.get('/health', async (_req, res) => {
  try {
    const data = await loadHistory()
    const newest = data[0]  // history is stored newest-first
    res.json({
      status: 'ok',
      historySize: data.length,
      lastDrawAt: newest?.drawTime ?? newest?.draw_time ?? null,
      uptime: Math.floor(process.uptime()),
      sseClients: sseClients.size,
      cacheKeys: [...apiCache.keys()],
    })
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message, uptime: Math.floor(process.uptime()) })
  }
})

/** POST /crawl — trigger manual crawl immediately */
let crawling = false
app.post('/crawl', async (_req, res) => {
  if (crawling) return res.json({ ok: false, message: 'Đang crawl, vui lòng đợi…' })
  crawling = true
  try {
    await crawlTick()
    res.json({ ok: true, message: 'Crawl xong' })
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message })
  } finally {
    crawling = false
  }
})

// ── Integrated crawler loop ────────────────────────────────────────────────
// Track last known total so we can detect file changes even if crawler returns +0
let lastKnownTotal = 0
let lastCrawlAttempt = 0

/**
 * Returns true when Bingo18 is operating (06:00–21:54 Vietnam time, UTC+7).
 * 159 draws/day at ~6-minute intervals; no draws published outside this window.
 * Skipping crawls outside hours saves CPU and network on Fly.io.
 */
function isOperatingHours() {
  const now = new Date()
  // Convert UTC → VN local time (UTC+7) without moment/luxon dependency
  const vnMinutes = ((now.getUTCHours() + 7) % 24) * 60 + now.getUTCMinutes()
  // 06:00 = 360 min, 21:54 = 1314 min
  return vnMinutes >= 360 && vnMinutes <= 1314
}

async function crawlTick() {
  if (!isOperatingHours()) {
    console.log('[crawler] off-hours (Bingo18 06:00–21:54 VN) — skipping')
    return
  }
  lastCrawlAttempt = Date.now()
  const ts = new Date().toLocaleTimeString('vi-VN')
  console.log(`[crawler] ${ts} — crawling…`)
  try {
    const { total, added, newRecords } = await crawlRun()
    // Always invalidate cache if total changed (covers external file mutations)
    if (added > 0 || total !== lastKnownTotal) {
      const latestKy = newRecords[0]?.ky || '?'
      if (added > 0) {
        console.log(`[crawler] ${added} kỳ mới (latest: #${latestKy}) — push SSE → ${sseClients.size} client(s)`)
        invalidateCache()
        broadcast('new-draw', {
          added,
          latestKy,
          total,
          ts: new Date().toISOString(),
        })
      } else {
        console.log(`[crawler] total changed ${lastKnownTotal}→${total} — invalidating cache`)
        invalidateCache()
      }
      lastKnownTotal = total
    }
  } catch (err) {
    console.error('[crawler] ERROR:', err.message)
  }
}

// ── Start ──────────────────────────────────────────────────────────────────

// Poll every 2 minutes during operating hours (06:00–21:54 VN).
// crawlTick() is a no-op outside those hours — saves compute between 21:54 and 06:00.
// 159 draws/day at ~6-minute intervals; polling 2 min gives <1 draw lag on average.
const CRAWL_INTERVAL_MS = 2 * 60_000

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bingo AI API  →  http://localhost:${PORT}`)
  console.log(`Dashboard     →  http://localhost:${PORT}/`)
  console.log(`SSE stream    →  http://localhost:${PORT}/events`)
  console.log(`Crawl interval: every ${CRAWL_INTERVAL_MS / 1000}s`)

  // Startup crawl immediately, then poll every 2 minutes
  crawlTick().catch(err => console.error('[crawler] startup error:', err.message))
  setInterval(crawlTick, CRAWL_INTERVAL_MS)
})
