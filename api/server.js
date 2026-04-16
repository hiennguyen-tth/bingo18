'use strict'

// ── Global safeguards — MUST be first ─────────────────────────────────────
// uncaughtException: keep process alive for transient socket/network errors.
// Exit only on repeated non-transient failures within a short window.
const _uncaughtRecent = []
process.on('uncaughtException', (err) => {
  const code = err?.code || ''
  const msg = String(err?.message || '')
  const transient = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(code)
    || /socket hang up|aborted|write EPIPE|ECONNRESET|premature close/i.test(msg)

  if (transient) {
    console.error('[WARN] uncaughtException (transient, non-fatal):', code || '-', msg)
    return
  }

  const now = Date.now()
  _uncaughtRecent.push(now)
  while (_uncaughtRecent.length && now - _uncaughtRecent[0] > 60_000) _uncaughtRecent.shift()

  console.error('[ERROR] uncaughtException:', msg, err?.stack)
  if (_uncaughtRecent.length >= 3) {
    console.error('[FATAL] repeated uncaughtException >=3 in 60s — exiting for clean restart')
    process.exit(1)
  }
})
// unhandledRejection: recoverable — log and continue. Most are network timeouts
// from crawl/fetch that don't affect server state. Exiting here caused 30-min
// outages whenever any async operation failed under load.
process.on('unhandledRejection', (reason) => { console.error('[WARN] unhandledRejection (non-fatal):', reason) })

console.log('[startup] loading modules...')
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

/**
 * api/server.js — Bingo18 AI Prediction API
 *
 * Routes:
 *   GET  /         → index.html (ADSENSE injected)
 *   GET  /predict  → top-10 combos            (disk-cached, instant on cold restart)
 *   GET  /history  → last N draws             (?limit=500)
 *   GET  /overdue  → overdue stats            (disk-cached, instant on cold restart)
 *   GET  /stats    → walk-forward backtest    (disk-cached, stale-while-revalidate)
 *   GET  /events   → SSE stream              (new-draw push)
 *   POST /crawl    → manual crawl trigger
 *   GET  /health   → liveness probe
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
const { run: crawlRun, crawlPage, crawlSince, merge: crawlMerge } = require('../crawler/crawl')

const app = express()
const PORT = parseInt(process.env.PORT) || 8080
const ADSENSE_PUBLISHER_ID = process.env.ADSENSE_PUBLISHER_ID || ''
const RECOVERY_TOKEN = process.env.RECOVERY_TOKEN || ''

const HISTORY_FILE = path.join(__dirname, '../dataset/history.json')
const WEB_DIR = path.join(__dirname, '../web')

// All three heavy caches persist to disk — instant responses even after cold restart
const STATS_CACHE_FILE = path.join(__dirname, '../dataset/stats_cache.json')
const PREDICT_CACHE_FILE = path.join(__dirname, '../dataset/predict_cache.json')
const OVERDUE_CACHE_FILE = path.join(__dirname, '../dataset/overdue_cache.json')

// index.html template — read once, ADSENSE injected per request
// Wrapped in try/catch: crash before app.listen() would leave the port unbound,
// causing health checks to fail indefinitely until next deploy.
let INDEX_TPL
try {
  INDEX_TPL = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8')
} catch (e) {
  console.error('[startup] WARNING: web/index.html missing —', e.message)
  INDEX_TPL = '<!DOCTYPE html><html><head><title>Bingo18 AI</title></head><body><h1>Bingo18 AI</h1><p>Đang khởi động...</p></body></html>'
}

// ── In-memory cache ────────────────────────────────────────────────────────
const apiCache = new Map()  // key → { data, ts }

// ── History file in-memory cache (avoids re-reading 8+ MB JSON on every request) ──
let _historyCache = null
let _historyCacheMtime = 0

// ── Disk cache state ───────────────────────────────────────────────────────
let _statsCache = null
let _statsComputing = false
let _prewarmRunning = false
let _prewarmTimer = null   // debounced prewarm (avoid cascade)
let _invalidateTimer = null   // debounced stats recompute
let _lastStatsCompute = 0      // epoch ms — rate-limit to 1/10min
let _lastStatsTotal = 0      // N at last compute — detect large data jumps
let _lastInvalidateAt = 0      // epoch ms — watcher cooldown

  // ── Load all disk caches at startup in parallel ────────────────────────────
  // predict, overdue, and stats all survive container restarts this way.
  ; (async () => {
    const [stats, pred, over] = await Promise.all([
      fs.readJSON(STATS_CACHE_FILE).catch(() => null),
      fs.readJSON(PREDICT_CACHE_FILE).catch(() => null),
      fs.readJSON(OVERDUE_CACHE_FILE).catch(() => null),
    ])
    if (stats) {
      _statsCache = stats
      _lastStatsTotal = stats.total || 0
      const predTotal = pred?.data?.total ?? 0
      console.log('[stats]   disk cache loaded, computed:', new Date(stats._computedAt || 0).toISOString(), `(N=${_lastStatsTotal})`)
      // If predict cache shows significantly more records (>10%), data was imported externally.
      // Bypass rate limit and recompute immediately so stats reflect the new dataset.
      if (predTotal > 0 && predTotal > Math.max(_lastStatsTotal, 100) * 1.1) {
        console.log(`[stats]   data grew ${_lastStatsTotal} → ${predTotal} — recomputing immediately (bypassing rate limit)`)
        setTimeout(() => _computeStatsBackground(), 5_000)
      }
    } else {
      console.log('[stats]   no disk cache — will compute after startup')
      setTimeout(() => _computeStatsBackground(), 3_000)
    }
    if (pred) { apiCache.set('predict', pred); console.log('[predict] disk cache loaded, ts:', new Date(pred.ts || 0).toISOString()) }
    if (over) { apiCache.set('overdue', over); console.log('[overdue] disk cache loaded, ts:', new Date(over.ts || 0).toISOString()) }
  })()

// ── History file watcher — invalidate on external change ──────────────────
// 10-second cooldown prevents cascade when crawl writes file repeatedly.
fs.watchFile(HISTORY_FILE, { interval: 3000, persistent: false }, (curr, prev) => {
  if (curr.mtime > prev.mtime) {
    const now = Date.now()
    if (now - _lastInvalidateAt < 10_000) return  // debounce watcher
    _lastInvalidateAt = now
    console.log('[cache] history.json changed externally — invalidating + SSE')
    invalidateCache()
    setTimeout(() => broadcast('new-draw', { added: 0, latestKy: '?', total: 0, ts: new Date().toISOString(), source: 'watcher' }), 500)
  }
})

// ── SSE registry ───────────────────────────────────────────────────────────
const sseClients = new Set()

function broadcast(eventName, data) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    try { res.write(msg) } catch (_) { sseClients.delete(res) }
  }
}

// ── Cache helpers ──────────────────────────────────────────────────────────
function invalidateCache() {
  const prevPredictTotal = apiCache.get('predict')?.data?.total ?? 0
  _lastInvalidateAt = Date.now()  // prevent watcher from double-firing
  _historyCache = null            // force re-read of history on next loadHistory()
  _historyCacheMtime = 0
  apiCache.clear()
  // Debounce prewarm — waits 800ms so rapid consecutive invalidations only fire once.
  clearTimeout(_prewarmTimer)
  _prewarmTimer = setTimeout(() => _prewarmCaches(), 800)
  // Rate-limited stats recompute: at most once per 10 minutes.
  // Exception: bypass rate limit if dataset grew significantly (e.g. bulk import).
  clearTimeout(_invalidateTimer)
  const msSinceLastStats = Date.now() - _lastStatsCompute
  const currentN = prevPredictTotal || (_statsCache?.total ?? 0)
  const cachedN = Math.max(_lastStatsTotal, _statsCache?.total ?? 0)
  const nGrew = currentN > 0 && cachedN > 0 && currentN > cachedN * 1.1
  const statsDelay = nGrew ? 2_000            // data changed significantly — bypass rate limit
    : msSinceLastStats < 10 * 60_000
      ? (10 * 60_000 - msSinceLastStats)      // wait out the remainder
      : 5_000                                 // first time: 5s debounce
  if (nGrew) console.log(`[stats] N grew ${cachedN} → ${currentN} — bypassing rate limit, recomputing in 2s`)
  _invalidateTimer = setTimeout(() => _computeStatsBackground(), statsDelay)
}

/**
 * Wrap a route with in-memory cache + ETag.
 * predict/overdue are always pre-warmed so cold misses should never occur in practice.
 */
function withCache(key, ttlMs, fn) {
  return async (req, res) => {
    const now = Date.now()
    const hit = apiCache.get(key)
    if (hit && (ttlMs === 0 || now - hit.ts < ttlMs)) {
      const etag = `"${hit.ts}"`
      res.set('X-Cache', 'HIT')
      res.set('ETag', etag)
      res.set('Last-Modified', new Date(hit.ts).toUTCString())
      if (req.headers['if-none-match'] === etag) return res.status(304).end()
      return res.json(hit.data)
    }
    try {
      const data = await fn(req)
      apiCache.set(key, { data, ts: now })
      res.set('X-Cache', 'MISS')
      res.set('ETag', `"${now}"`)
      res.set('Last-Modified', new Date(now).toUTCString())
      res.json(data)
    } catch (err) {
      console.error(`[${key}]`, err.message)
      res.status(500).json({ error: err.message })
    }
  }
}

// ── Pure compute functions (no I/O) ───────────────────────────────────────
// Single source of truth — used by both route handlers and _prewarmCaches().

/** Build /predict response payload from history array (newest-first). */
function buildPredictPayload(data) {
  const latestRecord = data[0] || null
  if (data.length < 2) {
    return {
      next: [],
      sumStats: [],
      total: data.length,
      latestKy: latestRecord?.ky ?? null,
      latestDrawTime: latestRecord?.drawTime ?? null,
      message: 'Not enough data — run: node crawler/crawl.js'
    }
  }
  const { top10, tripleSignal, effectiveWeights, verdict } = predict.ranked(data)
  const top10Total = top10.reduce((s, r) => s + r.score, 0) || 1

  // Use true max/min across all scores (not positional, since rebalanceTripleRanks
  // can reorder top-10 so top10[0] is not necessarily the highest-scoring combo).
  const allScores = top10.map(r => r.score)
  const trueMaxScore = allScores.length ? Math.max(...allScores) : 1
  const trueMinScore = allScores.length ? Math.min(...allScores) : 0
  const scoreSpread = trueMaxScore - trueMinScore

  const next = top10.map((r, idx) => ({
    combo: r.combo,
    score: +r.score.toFixed(3),
    pct: +(r.score / top10Total * 100).toFixed(1),
    // Rank-based confidence fallback when scores are nearly uniform (spread < 0.005):
    //   all combos have score≈0.5 → no meaningful score differentiation → use rank position.
    confidence: scoreSpread < 0.005
      ? Math.max(35, Math.round(80 - idx * 5))   // 80%, 75%, …, 35% by rank
      : Math.round(35 + ((r.score - trueMinScore) / scoreSpread) * 45),
    overdueRatio: r.overdueRatio != null ? +r.overdueRatio.toFixed(2) : null,
    comboGap: r.comboGap,
    sumOD: +(r.sumOD ?? 0).toFixed(2),
    pat: r.pat,
    stability: r.stability != null ? +r.stability.toFixed(2) : null,
    zScore: r.zScore != null ? +r.zScore.toFixed(2) : null,
    statNorm: r.statNorm ?? 0,
    mk2Norm: r.mk2Norm ?? 0,
    sessNorm: r.sessNorm ?? 0,
    mlNorm: r.mlNorm ?? 0,
    coreNorm: r.coreNorm ?? 0,  // legacy compat
    chiNorm: 0,
  }))

  const sumBucket = {}
  for (const d of data) sumBucket[d.sum] = (sumBucket[d.sum] || 0) + 1
  const sumStats = Object.entries(sumBucket)
    .map(([sum, cnt]) => ({ sum: +sum, pct: +(cnt / data.length * 100).toFixed(2) }))
    .sort((a, b) => b.pct - a.pct)

  return {
    next,
    tripleSignal,
    modelContrib: effectiveWeights,
    verdict: verdict || 'no_pattern',
    sumStats,
    total: data.length,
    latestKy: latestRecord?.ky ?? null,
    latestDrawTime: latestRecord?.drawTime ?? null,
    maxScore: +trueMaxScore.toFixed(3)
  }
}

/** Build /overdue response payload from history array (newest-first). */
function buildOverduePayload(data) {
  if (data.length === 0) return { triples: [], pairs: [], sums: [] }

  const chron = [...data].reverse()  // chronological for interval calc
  const N = chron.length

  function computeStats(keyFn, labelFn) {
    const lastSeen = {}, counts = {}, gaps = {}
    chron.forEach((r, i) => {
      const raw = keyFn(r)
      const keys = Array.isArray(raw) ? raw : (raw ? [raw] : [])
      for (const key of keys) {
        counts[key] = (counts[key] || 0) + 1
        if (lastSeen[key] !== undefined) (gaps[key] ??= []).push(i - lastSeen[key])
        lastSeen[key] = i
      }
    })
    return Object.keys(counts).map(key => {
      const kySince = lastSeen[key] !== undefined ? (N - 1 - lastSeen[key]) : N
      const avgGap = gaps[key]?.length
        ? +(gaps[key].reduce((a, b) => a + b, 0) / gaps[key].length).toFixed(1)
        : N
      return { key, label: labelFn ? labelFn(key) : key, appeared: counts[key], kySinceLast: kySince, avgInterval: avgGap, overdueScore: +(kySince / (avgGap || 1)).toFixed(2) }
    }).sort((a, b) => b.overdueScore - a.overdueScore)
  }

  // Triples (1-1-1 to 6-6-6)
  const TRIPLES = ['1-1-1', '2-2-2', '3-3-3', '4-4-4', '5-5-5', '6-6-6']
  const tripleRaw = computeStats(
    r => { const k = `${r.n1}-${r.n2}-${r.n3}`; return TRIPLES.includes(k) ? k : null },
    k => k.replace(/-/g, '')
  )
  const tripleKeys = new Set(tripleRaw.map(t => t.key))
  const triples = [
    ...tripleRaw,
    ...TRIPLES.filter(k => !tripleKeys.has(k)).map(k => ({ key: k, label: k.replace(/-/g, ''), appeared: 0, kySinceLast: N, avgInterval: N, overdueScore: 1 })),
  ].sort((a, b) => b.overdueScore - a.overdueScore)

  // Any-triple aggregate
  let lastTripleIdx = -1
  const anyTripleGaps = []
  chron.forEach((r, i) => {
    if (r.pattern === 'triple' || (r.n1 === r.n2 && r.n2 === r.n3)) {
      if (lastTripleIdx >= 0) anyTripleGaps.push(i - lastTripleIdx)
      lastTripleIdx = i
    }
  })
  const sinceAnyTriple = lastTripleIdx >= 0 ? N - 1 - lastTripleIdx : N
  const avgAnyTripleGap = anyTripleGaps.length
    ? +(anyTripleGaps.reduce((a, b) => a + b, 0) / anyTripleGaps.length).toFixed(1)
    : 36
  const anyTriple = {
    key: 'any-triple', label: 'XXX',
    appeared: triples.reduce((s, t) => s + t.appeared, 0),
    kySinceLast: sinceAnyTriple,
    avgInterval: avgAnyTripleGap,
    overdueScore: +(sinceAnyTriple / (avgAnyTripleGap || 36)).toFixed(2),
  }

  // Pairs (11, 22, 33, 44, 55, 66)
  const pairRaw = computeStats(
    r => {
      if (r.n1 === r.n2 || r.n1 === r.n3) return `pair-${r.n1}`
      if (r.n2 === r.n3) return `pair-${r.n2}`
      return null
    },
    k => { const v = k.replace('pair-', ''); return `${v}${v}` }
  )
  const pairKeys = new Set(pairRaw.map(p => p.key))
  const pairs = [
    ...pairRaw,
    ...[1, 2, 3, 4, 5, 6].filter(v => !pairKeys.has(`pair-${v}`)).map(v => ({ key: `pair-${v}`, label: `${v}${v}`, appeared: 0, kySinceLast: N, avgInterval: N, overdueScore: 1 })),
  ].sort((a, b) => b.overdueScore - a.overdueScore)

  // Sums (3-18)
  const sumRaw = computeStats(r => `sum-${r.sum}`, k => k.replace('sum-', ''))
  const sumKeys = new Set(sumRaw.map(s => s.key))
  const sums = [
    ...sumRaw,
    ...Array.from({ length: 16 }, (_, i) => `sum-${i + 3}`)
      .filter(k => !sumKeys.has(k))
      .map(k => ({ key: k, label: k.replace('sum-', ''), appeared: 0, kySinceLast: N, avgInterval: N, overdueScore: 1 })),
  ].sort((a, b) => b.overdueScore - a.overdueScore)

  return { total: N, triples, anyTriple, pairs, sums }
}

// ── Background tasks ───────────────────────────────────────────────────────

/**
 * Pre-warm /predict and /overdue — runs in ~50ms.
 * Result goes to in-memory cache AND disk so cold restarts are also instant.
 * Called immediately on invalidateCache() and once at startup.
 */
async function _prewarmCaches() {
  if (_prewarmRunning) return
  _prewarmRunning = true
  const t0 = Date.now()
  try {
    const data = await loadHistory()
    if (data.length < 2) return

    const ts = Date.now()
    const predictPl = buildPredictPayload(data)
    const overduePl = buildOverduePayload(data)

    apiCache.set('predict', { data: predictPl, ts })
    apiCache.set('overdue', { data: overduePl, ts })

    // Persist to disk in parallel (non-blocking)
    await Promise.all([
      fs.writeJSON(PREDICT_CACHE_FILE, { data: predictPl, ts }),
      fs.writeJSON(OVERDUE_CACHE_FILE, { data: overduePl, ts }),
    ])
    console.log(`[prewarm] predict + overdue cached + persisted in ${Date.now() - t0}ms`)
  } catch (err) {
    console.error('[prewarm]', err.message)
  } finally {
    _prewarmRunning = false
  }
}

/**
 * Walk-forward backtest — never blocks event loop (yields with setImmediate).
 * SAMPLE_EVERY=3 gives 3x speedup; results still statistically representative.
 * Persisted to disk for restart continuity; serves stale while recomputing.
 */
async function _computeStatsBackground() {
  if (_statsComputing) return
  _statsComputing = true
  const t0 = Date.now()
  console.log('[stats] background backtest starting...')
  try {
    const data = await loadHistory()
    const WINDOW = 10
    if (data.length < WINDOW + 2) {
      _statsCache = { message: 'Need more data', total: data.length, needed: WINDOW + 2, _computedAt: Date.now() }
      await fs.writeJSON(STATS_CACHE_FILE, _statsCache)
      return
    }

    const chron = [...data].reverse()
    const N = chron.length
    const trainEnd = Math.floor(N * 0.6)
    const validEnd = Math.floor(N * 0.8)

    let top1 = 0, top3 = 0, top10 = 0, tested = 0
    const rankHits = new Array(10).fill(0)
    const seg = {
      train: { top1: 0, top3: 0, top10: 0, tested: 0 },
      valid: { top1: 0, top3: 0, top10: 0, tested: 0 },
      forward: { top1: 0, top3: 0, top10: 0, tested: 0 },
    }

    // Dynamic SAMPLE_EVERY: target ~300 test windows regardless of dataset size.
    // Yield after EVERY iteration so health-check (/health) is never blocked > 200ms.
    const SAMPLE_EVERY = Math.max(1, Math.floor(N / 300))
    // Start from 30% mark — early windows have too little training data.
    const START_I = Math.max(WINDOW, Math.floor(N * 0.3))

    for (let i = START_I; i < N; i += SAMPLE_EVERY) {
      await new Promise(resolve => setImmediate(resolve))  // yield EVERY iteration
      const slice = chron.slice(0, i)
      const { top10: tp } = predict.ranked(slice)
      if (!tp || tp.length === 0) continue

      const actual = `${chron[i].n1}-${chron[i].n2}-${chron[i].n3}`
      const combos = tp.map(r => r.combo)
      const hit1 = combos[0] === actual
      const hit3 = combos.slice(0, 3).some(c => c === actual)
      const hit10 = combos.some(c => c === actual)

      for (let r = 0; r < Math.min(tp.length, 10); r++) {
        if (tp[r].combo === actual) { rankHits[r]++; break }
      }
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

    const baseline = { top1: +(1 / 216 * 100).toFixed(2), top3: +(3 / 216 * 100).toFixed(2), top10: +(10 / 216 * 100).toFixed(2) }

    function _normCDF(z) {
      const t = 1 / (1 + 0.2316419 * Math.abs(z))
      const d2 = 0.3989423 * Math.exp(-z * z / 2)
      const p = d2 * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
      return z > 0 ? 1 - p : p
    }
    const p_hat10 = tested > 0 ? top10 / tested : 0
    const p_base10 = 10 / 216
    const se_test = Math.sqrt(p_base10 * (1 - p_base10) / Math.max(tested, 1))
    const z_vs_base = (p_hat10 - p_base10) / (se_test || 1)
    const pValueVsBaseline = +(2 * (1 - _normCDF(Math.abs(z_vs_base)))).toFixed(4)
    const se_ci = Math.sqrt(p_hat10 * (1 - p_hat10) / Math.max(tested, 1))
    const ci95 = {
      lower: +(Math.max(0, p_hat10 - 1.96 * se_ci) * 100).toFixed(2),
      upper: +((p_hat10 + 1.96 * se_ci) * 100).toFixed(2),
    }

    const segments = {}
    for (const [name, s] of Object.entries(seg)) {
      const t = s.tested
      segments[name] = { tested: t, top1: t ? +(s.top1 / t * 100).toFixed(2) : 0, top3: t ? +(s.top3 / t * 100).toFixed(2) : 0, top10: t ? +(s.top10 / t * 100).toFixed(2) : 0 }
    }

    const statTests = runStatTests(chron)
    const calBuckets = tested > 0 ? rankHits.map((h, i) => ({ rank: i + 1, hitPct: +(h / tested * 100).toFixed(3) })) : []

    _statsCache = {
      tested, total: N,
      accuracy: {
        top1: tested ? +(top1 / tested * 100).toFixed(2) : 0,
        top3: tested ? +(top3 / tested * 100).toFixed(2) : 0,
        top10: tested ? +(top10 / tested * 100).toFixed(2) : 0,
        top10CI95: ci95,
        top10PValueVsBaseline: pValueVsBaseline,
        top10SignificantVsBaseline: pValueVsBaseline < 0.05,
      },
      hits: { top1, top3, top10 },
      baseline, segments, statTests, calBuckets,
      _computedAt: Date.now(),
      _sampleEvery: SAMPLE_EVERY,
    }
    _lastStatsCompute = Date.now()
    _lastStatsTotal = N
    await fs.writeJSON(STATS_CACHE_FILE, _statsCache)
    console.log(`[stats] backtest done in ${((Date.now() - t0) / 1000).toFixed(1)}s, tested=${tested}/${N} draws (every ${SAMPLE_EVERY})`)
  } catch (err) {
    console.error('[stats] background compute error:', err.message, err.stack)
  } finally {
    _statsComputing = false
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(compression({ filter: (req, res) => req.path !== '/events' && compression.filter(req, res) }))
app.use(cors())
app.use(express.json({ limit: '20mb' }))

// ── Helpers ────────────────────────────────────────────────────────────────

/** Load history with mtime-based in-memory cache. Avoids re-reading 8+ MB JSON
 *  on every request. Cache is invalidated by invalidateCache() on new draws. */
async function loadHistory() {
  try {
    const stat = await fs.stat(HISTORY_FILE)
    const mtime = stat.mtimeMs
    if (_historyCache && mtime === _historyCacheMtime) return _historyCache
    const data = await fs.readJSON(HISTORY_FILE)
    if (Array.isArray(data) && data.length > 0) {
      _historyCache = data
      _historyCacheMtime = mtime
    }
    return _historyCache || []
  } catch {
    return _historyCache || []
  }
}

async function atomicWriteJSON(filePath, data) {
  const tmp = `${filePath}.tmp`
  await fs.writeJSON(tmp, data, { spaces: 2 })
  await fs.move(tmp, filePath, { overwrite: true })
}

function renderIndex() {
  const adScript = ADSENSE_PUBLISHER_ID
    ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_PUBLISHER_ID}" crossorigin="anonymous"></script>`
    : ''
  return INDEX_TPL
    .replace('{{ADSENSE_PUBLISHER_ID}}', ADSENSE_PUBLISHER_ID)
    .replace('{{ADSENSE_SCRIPT}}', adScript)
}

// ── Static / SEO pages ─────────────────────────────────────────────────────
app.get(['/', '/index.html'], (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(renderIndex())
})

const _staticPages = {
  '/about': 'about.html',
  '/how-it-works': 'how-it-works.html',
  '/blog/what-is-bingo18': 'blog/what-is-bingo18.html',
  '/blog/best-strategy-2026': 'blog/best-strategy-2026.html',
  '/privacy-policy': 'privacy-policy.html',
}
for (const [route, file] of Object.entries(_staticPages)) {
  app.get(route, (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.sendFile(path.join(WEB_DIR, file))
  })
}
app.get('/sitemap.xml', (_req, res) => { res.setHeader('Content-Type', 'application/xml; charset=utf-8'); res.sendFile(path.join(WEB_DIR, 'sitemap.xml')) })
app.get('/ads.txt', (_req, res) => { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.sendFile(path.join(WEB_DIR, 'ads.txt')) })

// Static assets (app.js, heatmap.js, etc.) — index.html excluded above
app.use(express.static(WEB_DIR, { index: false }))

// ── API Routes ─────────────────────────────────────────────────────────────

/** GET /predict — top-10 ensemble predictions (disk-persisted, always warm) */
app.get('/predict', withCache('predict', 5 * 60_000,
  async () => buildPredictPayload(await loadHistory())
))

/** GET /predict-sum — sum-level prediction (16 outcomes, Markov-1 + z-score + theoretical weight).
 *  Lower dimensionality than combo → converges with less data.
 *  Score is weighted by sqrt(P(sum) / P_max) so rare sums (sum=3) don't outscore
 *  common ones (sum=10) purely due to overdue status.
 *  Cached for 5 min alongside combo predictions. */
app.get('/predict-sum', withCache('predict-sum', 5 * 60_000,
  async () => predict.predictSum(await loadHistory())
))

/** GET /predict-hierarchical — P1 hierarchical prediction.
 *  Step 1: predict sum → top-{sumFilter} buckets.
 *  Step 2: portfolio-select combos restricted to those sum buckets only.
 *  Returns same format as /predict plus sumBuckets[] and sumFiltered flag.
 *  Query param: ?top=N (default 5) — how many sum buckets to consider.
 *  Not cached here: used for testing; integrate via /predict?sumFilter=N once validated. */
app.get('/predict-hierarchical', async (req, res) => {
  try {
    const topN = Math.max(1, Math.min(16, parseInt(req.query.top) || 5))
    const data = await loadHistory()
    const result = predict.ranked(data, { sumFilter: topN })
    res.json({ ...result, _mode: 'hierarchical', _sumFilter: topN })
  } catch (e) {
    console.error('[/predict-hierarchical]', e.message)
    res.status(500).json({ error: e.message })
  }
})

/** GET /overdue — overdue stats for triples/pairs/sums (disk-persisted, always warm) */
app.get('/overdue', withCache('overdue', 5 * 60_000,
  async () => buildOverduePayload(await loadHistory())
))

/** GET /history — raw draws, newest first (?limit=N).
 * Cached in memory for 60s (avoids re-reading 43K record file on every page load).
 * Cache is cleared by invalidateCache() → apiCache.clear() when new draws arrive. */
app.get('/history', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 1_000)
    const cacheKey = `history-${limit}`
    const now = Date.now()
    const hit = apiCache.get(cacheKey)
    if (hit && now - hit.ts < 60_000) {
      const etag = `"${hit.ts}"`
      res.set('X-Cache', 'HIT')
      res.set('ETag', etag)
      if (req.headers['if-none-match'] === etag) return res.status(304).end()
      return res.json(hit.data)
    }
    const data = await loadHistory()
    const payload = { records: data.slice(0, limit), total: data.length }
    apiCache.set(cacheKey, { data: payload, ts: now })
    const etag = `"${now}"`
    res.set('X-Cache', 'MISS')
    res.set('ETag', etag)
    res.json(payload)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /stats — walk-forward backtest (stale-while-revalidate).
 * Always responds instantly from disk/memory cache.
 * Background recompute fires after each new draw (debounced 3.5s).
 */
app.get('/stats', (req, res) => {
  if (_statsCache) {
    const ts = _statsCache._computedAt || 0
    const etag = `"${ts}"`
    res.set('ETag', etag)
    res.set('Last-Modified', new Date(ts).toUTCString())
    res.set('X-Cache', _statsComputing ? 'STALE' : 'HIT')
    res.set('X-Stats-Computing', _statsComputing ? '1' : '0')
    if (req.headers['if-none-match'] === etag && !_statsComputing) return res.status(304).end()
    // Auto-refresh when cache is stale — but also respect the 10-min rate limit
    // to prevent cascading recomputes when multiple clients hit /stats simultaneously.
    if (!_statsComputing && Date.now() - ts > 15 * 60_000 && Date.now() - _lastStatsCompute > 10 * 60_000) _computeStatsBackground()
    return res.json(_statsCache)
  }
  if (!_statsComputing) _computeStatsBackground()
  res.set('X-Cache', 'MISS')
  res.json({ computing: true, message: 'Dang tinh toan lan dau, vui long thu lai sau 30 giay...', total: 0 })
})

/** GET /frequency — top-30 combo frequency table */
app.get('/frequency', withCache('frequency', 5 * 60_000, async () => {
  const data = await loadHistory()
  if (data.length === 0) return { freq: {}, total: 0 }
  const freq = frequency(data)
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 30)
  return { freq: Object.fromEntries(sorted), total: data.length }
}))

/** GET /ml-status — model readiness info */
app.get('/ml-status', async (_req, res) => {
  try {
    const data = await loadHistory()
    const N = data.length
    const ML_MIN = 24
    res.json({
      modelD: { name: 'k-NN Temporal Similarity', active: N >= ML_MIN, records: N, minRequired: ML_MIN, kNeighbors: Math.min(60, Math.max(15, Math.floor((N - 9) * 0.05))), window: 8 },
      pythonGBM: { name: 'Gradient Boosting (offline)', script: 'python python/ml_predictor.py', note: 'Run locally to generate python/ml_output.json' },
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

/** GET /features — last 20 feature vectors */
app.get('/features', async (req, res) => {
  try {
    const data = await loadHistory()
    const feat = features(data)
    res.json({ features: feat.slice(-20), total: feat.length })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

/** POST /admin/recover-history — emergency restore endpoint (token gated).
 *  Accepts a JSON array of records (or {records:[...]}), merges by ky, keeps richer record,
 *  writes atomically, then invalidates all caches and pushes SSE.
 */
app.post('/admin/recover-history', async (req, res) => {
  try {
    if (!RECOVERY_TOKEN) return res.status(404).json({ ok: false, error: 'not enabled' })
    const token = req.headers['x-recovery-token']
    if (!token || token !== RECOVERY_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' })

    const incomingRaw = Array.isArray(req.body) ? req.body : req.body?.records
    if (!Array.isArray(incomingRaw) || incomingRaw.length === 0) {
      return res.status(400).json({ ok: false, error: 'payload must be a non-empty JSON array' })
    }

    const incoming = incomingRaw.filter(r => r && (r.ky != null) && Number.isFinite(Number(r.n1)) && Number.isFinite(Number(r.n2)) && Number.isFinite(Number(r.n3)))
    if (incoming.length === 0) return res.status(400).json({ ok: false, error: 'no valid records in payload' })

    const existing = await loadHistory()
    const byKy = new Map()

    const quality = (r) => {
      let q = 0
      if (r?.drawTime) q += 3
      if (r?.id) q += 1
      if (r?.sum != null) q += 1
      if (r?.pattern) q += 1
      return q
    }

    for (const r of existing) byKy.set(String(r.ky), r)
    let improved = 0
    let inserted = 0

    for (const r of incoming) {
      const k = String(r.ky)
      const prev = byKy.get(k)
      if (!prev) {
        byKy.set(k, r)
        inserted++
        continue
      }
      if (quality(r) > quality(prev)) {
        byKy.set(k, { ...prev, ...r })
        improved++
      }
    }

    const merged = [...byKy.values()].sort((a, b) => Number(b.ky) - Number(a.ky))
    if (existing.length > 0 && merged.length < Math.floor(existing.length * 0.9)) {
      return res.status(409).json({ ok: false, error: 'merge would shrink dataset unexpectedly; aborted' })
    }

    const backupFile = path.join(path.dirname(HISTORY_FILE), `history_before_recover_${Date.now()}.json`)
    await atomicWriteJSON(backupFile, existing)
    await atomicWriteJSON(HISTORY_FILE, merged)

    invalidateCache()
    broadcast('new-draw', { added: inserted, latestKy: merged[0]?.ky || '?', total: merged.length, ts: new Date().toISOString(), source: 'recovery' })

    return res.json({
      ok: true,
      previousTotal: existing.length,
      incomingTotal: incoming.length,
      mergedTotal: merged.length,
      inserted,
      improved,
      backupFile,
    })
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message })
  }
})

/** GET /events — SSE stream (new-draw push) */
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
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n') } catch (_) { clearInterval(hb) } }, 15_000)
  sseClients.add(res)
  console.log(`[SSE] +1 client (total: ${sseClients.size})`)
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); console.log(`[SSE] -1 client (total: ${sseClients.size})`) })
})

/** GET /health — liveness probe (fast: uses in-memory predict cache instead of re-reading full file) */
app.get('/health', (_req, res) => {
  try {
    const predictHit = apiCache.get('predict')
    const historyTotal = predictHit?.data?.total ?? 0
    res.json({
      ok: true,
      status: 'ok',
      historySize: historyTotal,
      statsComputing: _statsComputing,
      crawlerStatus: isOperatingHours() ? 'operating' : 'offline',
      lastCrawlAttemptAt: lastCrawlAttempt ? new Date(lastCrawlAttempt).toISOString() : null,
      uptime: Math.floor(process.uptime()),
      sseClients: sseClients.size,
      cacheKeys: [...apiCache.keys()],
    })
  } catch (err) { res.status(500).json({ status: 'error', error: err.message, uptime: Math.floor(process.uptime()) }) }
})

/** POST /crawl — manual crawl trigger */
app.post('/crawl', async (_req, res) => {
  try {
    const result = await crawlTick({ manual: true })
    if (result.busy) return res.json({ ok: false, message: 'Dang crawl, vui long doi...' })
    res.json({ ok: true, message: result.added > 0 ? `Da them ${result.added} ky moi` : 'Khong co ky moi', ...result })
  }
  catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

// ── Crawler loop ───────────────────────────────────────────────────────────
let lastKnownTotal = 0
let lastCrawlAttempt = 0
let _crawlRunning = false

function isOperatingHours() {
  const now = new Date()
  const vnMinutes = ((now.getUTCHours() + 7) % 24) * 60 + now.getUTCMinutes()
  return vnMinutes >= 360 && vnMinutes <= 1320  // 06:00–22:00 VN
}

async function crawlTick({ manual = false } = {}) {
  if (!manual && !isOperatingHours()) {
    console.log('[crawler] off-hours (before 06:00 or after 22:00 VN) -- skipping')
    return { skipped: true, reason: 'off-hours', added: 0, total: lastKnownTotal, latestKy: null, changed: false }
  }
  if (_crawlRunning) {
    console.log('[crawler] previous crawl still running — skip overlapping tick')
    return { busy: true, added: 0, total: lastKnownTotal, latestKy: null, changed: false }
  }
  _crawlRunning = true
  lastCrawlAttempt = Date.now()
  console.log(`[crawler] ${new Date().toLocaleTimeString('vi-VN')} -- crawling...`)
  try {
    let { total, added, newRecords } = await crawlRun()
    const latestKy = newRecords[0]?.ky || null

    // Gap recovery: when new draws are found but ky sequence still has a gap,
    // the source website sometimes publishes draws with 3-10s delay.
    // Retry up to 3 times (8s, 12s, 15s) to fill gaps — before broadcasting
    // SSE — so predictions are built from fully-filled data.
    if (added > 0) {
      const retryDelays = [8000, 12000, 15000]
      for (let attempt = 0; attempt < retryDelays.length; attempt++) {
        const freshKys = (await loadHistory()).slice(0, 50).map(r => Number(r.ky)).sort((a, b) => b - a)
        const hasGap = freshKys.some((k, i) => i > 0 && freshKys[i - 1] - k > 1)
        if (!hasGap) break
        console.log(`[crawler] ky gap in recent draws — recovery attempt ${attempt + 1}/${retryDelays.length} in ${retryDelays[attempt] / 1000}s...`)
        await new Promise(r => setTimeout(r, retryDelays[attempt]))
        const rec = await crawlRun()
        if (rec.added > 0) {
          console.log(`[crawler] gap recovery ${attempt + 1}: +${rec.added} records (latestKy: ${rec.newRecords[0]?.ky})`)
          total = rec.total
        }
      }
    }

    let changed = false
    if (added > 0 || total !== lastKnownTotal) {
      if (added > 0) {
        console.log(`[crawler] ${added} ky moi (latest: #${latestKy}) -- push SSE -> ${sseClients.size} client(s)`)
        invalidateCache()
        // Broadcast full-reload event so all clients refresh predictions, history, sum, overdue
        broadcast('new-draw', { added, latestKy: latestKy || '?', total, ts: new Date().toISOString(), reload: true })
      } else {
        console.log(`[crawler] total changed ${lastKnownTotal}->${total} -- invalidating cache`)
        invalidateCache()
      }
      lastKnownTotal = total
      changed = true
    } else {
      // No new draws this tick — check for historical gaps periodically
      await runDeepRecovery()
    }
    return { busy: false, skipped: false, added, total, latestKy, changed }
  } catch (err) { console.error('[crawler] ERROR:', err.message) }
  finally { _crawlRunning = false }
  return { busy: false, skipped: false, added: 0, total: lastKnownTotal, latestKy: null, changed: false }
}

// ── Deep recovery: fill recent gaps by fetching pages targeting the last known ky ──
// Fires at most once every 10 min when recent ky sequence has gaps.
let _lastDeepRecovery = 0
async function runDeepRecovery() {
  const now = Date.now()
  if (now - _lastDeepRecovery < 10 * 60_000) return
  _lastDeepRecovery = now

  const data = await loadHistory()
  if (data.length < 30) return

  // Check last 30 records (sorted newest first) for consecutive ky gaps
  const recent = data.slice(0, 30).map(r => Number(r.ky)).sort((a, b) => b - a)
  const hasGap = recent.some((k, i) => i > 0 && recent[i - 1] - k > 1)
  if (!hasGap) return

  const lastKy = recent[0]
  console.log(`[crawler] deep recovery: gaps detected, crawlSince ky=${lastKy}...`)
  try {
    const { totalAdded } = await crawlSince(lastKy, 30)
    if (totalAdded > 0) {
      console.log(`[crawler] deep recovery: filled ${totalAdded} missing draws`)
      invalidateCache()
      const data2 = await loadHistory()
      broadcast('new-draw', { added: totalAdded, latestKy: data2[0]?.ky || '?', total: data2.length, ts: new Date().toISOString(), source: 'deep-recovery' })
    }
  } catch (err) {
    console.error('[crawler] deep recovery error:', err.message)
  }
}

// ── Markov Reality Check ───────────────────────────────────────────────────
const { runAll: markovRealityRunAll } = require('../scripts/markov_reality')

let _markovRealityCache = null
let _markovRealityTs = 0
const MARKOV_REALITY_TTL = 30 * 60_000  // recompute at most every 30 min

app.get('/experiments/markov-reality', async (_req, res) => {
  const now = Date.now()
  if (_markovRealityCache && now - _markovRealityTs < MARKOV_REALITY_TTL) {
    res.set('X-Cache', 'HIT')
    return res.json(_markovRealityCache)
  }

  try {
    const result = markovRealityRunAll()
    _markovRealityCache = result
    _markovRealityTs = now
    res.set('X-Cache', 'MISS')
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Start ──────────────────────────────────────────────────────────────────
const CRAWL_INTERVAL_MS = 12_000  // poll every 12s — AJAX-only (~200ms/call), draws every ~6min; 30× margin

function startCrawlerLoop() {
  async function tick() {
    try {
      await crawlTick()
    } catch (err) {
      console.error('[crawler] loop error:', err.message)
    } finally {
      setTimeout(tick, CRAWL_INTERVAL_MS)
    }
  }

  tick()
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bingo AI API  ->  http://localhost:${PORT}`)
  console.log(`Dashboard     ->  http://localhost:${PORT}/`)
  console.log(`SSE stream    ->  http://localhost:${PORT}/events`)
  console.log(`Crawl interval: every ${CRAWL_INTERVAL_MS / 1000}s (sequential loop)`)

  startCrawlerLoop()

  // Pre-warm after 2s: fills any missing disk caches and ensures freshness.
  setTimeout(() => _prewarmCaches(), 2_000)

  // Startup gap recovery: crawl from the last known ky in history forward,
  // filling any gaps caused by server restarts or outages (uses page-binary-search).
  setTimeout(async () => {
    try {
      const data = await loadHistory()
      const lastKy = data.length > 0 ? Number(data[0].ky) : 0
      if (lastKy > 0) {
        console.log(`[startup] gap recovery: crawlSince ky=${lastKy} (last known)...`)
        const { totalAdded } = await crawlSince(lastKy, 50)
        if (totalAdded > 0) {
          console.log(`[startup] gap recovery: filled ${totalAdded} missing records`)
          invalidateCache()
        } else {
          console.log('[startup] gap recovery: no missing records found')
        }
      }
    } catch (err) {
      console.error('[startup] gap recovery error:', err.message)
    }
  }, 5_000)

  // Kick off stats if not cached yet or cache is > 24h old.
  setTimeout(() => {
    const age = _statsCache?._computedAt ? Date.now() - _statsCache._computedAt : Infinity
    if (!_statsCache || age > 24 * 60 * 60_000) {
      console.log('[stats] startup: no recent cache — scheduling initial compute in 15s')
      setTimeout(() => _computeStatsBackground(), 15_000)
    } else {
      console.log(`[stats] startup: cache age ${Math.round(age / 60000)}min — skipping initial recompute`)
    }
  }, 3_000)
})
