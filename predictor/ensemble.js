'use strict'
/**
 * predictor/ensemble.js — v9
 *
 * 5-model sigmoid ensemble. Each model normalised to [0,1] via rank-percentile,
 * then combined through sigmoid(wA·sA + wB·sB + wC·sC + wD·sD + wE·sE + bias).
 * Weights trained walk-forward with L2 regularisation (scripts/train_weights.js).
 *
 *   MODEL A — Statistical z-score + 4 auxiliary signals (S3–S6)
 *     z-score = gap overdueness; S3 sum deviation; S4 digit momentum;
 *     S5/S6 mutually exclusive tie-breaker (+0–5% max, additive).
 *     ALL signals merged in a SINGLE O(N) pass for performance.
 *
 *   MODEL B — Markov order-2 (transition probability)
 *     P(next | prev-2, prev-1); fallback order-1; fallback 1/216.
 *
 *   MODEL C — Time-of-day session model (frequency ratio)
 *     morning 6–12h / afternoon 12–18h / evening 18–6h
 *     HARD-DISABLED when N < 5000 (insufficient data for session signal;
 *     ~339 draws/session → 1.57 appearances/combo → variance too high).
 *
 *   MODEL D — k-NN Temporal Similarity (pure-JS ML)
 *     Auto-disabled when learned weight wD < 0.
 *
 *   MODEL E — Python GBM prior (offline, from python/ml_output.json)
 *     Active when file present AND dataset grew ≤ 200 records since training.
 *
 * v9 changes vs v8:
 *   P1: z=0 for unseen combos (was z=2, gambler’s fallacy fix).
 *   P2: S3–S6 additive (was multiplicative; prevents non-linear inflation).
 *   P3: Model C hard-disabled at N<5000 (was only session<20 check).
 *   P4: effectiveWeights returned from predictRanked for UI transparency.
 *   P0: CI95 + p-value vs baseline added in /stats endpoint.
 *   Dir 3+4: Bayesian p-value shrink (no_pattern → shrink=0).
 *   Dir 1+2: Portfolio coverage selection (λ=0.10).
 *   Cooldown penalty (z<0 → score×exp(z)).
 *
 * S2 Triple streak boost — applied AFTER ensemble:
 *   ratio = sinceTriple / 36;  ratio ≤ 1 → no boost;  max 1.5× at ratio ≥ 2
 *   Only fires when clearly overdue (not within normal variance of 36-draw gap).
 *
 * S5/S6 design note:
 *   Mutually exclusive tie-breakers — only the LARGER of the two fires.
 *   Max +5% (single), so combined contribution ≤ +5%, preventing compounding.
 *   This stops the case where a triple scores high purely because both its sum
 *   AND its pair-digit happen to be overdue simultaneously.
 *
 * Cooldown penalty (bug fix — h6 re-suggest):
 *   After ensemble, if z < 0 (combo appeared more recently than its own average),
 *   score × exp(max(-3, z)). At z=-1.5: ×0.22. Prevents Markov/session models
 *   from overriding the clear z-score signal that the combo is not overdue.
 *
 * Direction 3+4 — Bayesian shrink via p-value:
 *   no_pattern (0 tests significant) → shrink=0 → wA=wB=wD effectively zeroed;
 *     fallback to session(C) + GBM(E) + near-uniform → portfolio drives diversity.
 *   weak/strong pattern → shrink ∝ 1/pMin continuously (0.5 → 1.0).
 *
 * Direction 1+2 — Portfolio coverage selection (replaces pass-based cap):
 *   Greedy slot-by-slot: argmax_k [score_k − λ×avgDigitOverlap(k, selected)]
 *   λ=0.10; maximises P(hit ≥ 1) = coverage rather than P(combo_i correct).
 *   When shrink=0: near-uniform scores → purely diversity-driven selection.
 *
 * Diversity cap (selectTop10):
 *   max 2 triple, 4 pair, 4 normal per top-10.
 *   Bypass slot (z > 2.5, max 3): severely overdue combos forced in by z DESC.
 */

const path = require('path')
const fs = require('fs')
const modelD = require('./model_d')
const { runStatTests } = require('./stats_tests')

const HISTORY_FILE = path.join(__dirname, '../dataset/history.json')
const WEIGHTS_FILE = path.join(__dirname, '../dataset/model.json')
const GBM_FILE = path.join(__dirname, '../python/ml_output.json')
const GBM_MAX_STALENESS = 2000  // records; invalidate GBM scores if dataset grew > this

// ── Learned weights (sigmoid ensemble) ────────────────────────────────────
// Trained by: node scripts/train_weights.js
// Falls back to fixed weights if file not found or parse error.

function sigmoid(x) { return 1 / (1 + Math.exp(-x)) }

let _learnedWeights = null
function loadLearnedWeights() {
  try {
    const raw = fs.readFileSync(WEIGHTS_FILE, 'utf8')
    const w = JSON.parse(raw)
    // Minimal validation — must have numeric weights
    if (typeof w.wA === 'number' && typeof w.wB === 'number') {
      // Only activate if training confirmed validation improvement (or flag absent = legacy)
      if (w.improvesValid === false) {
        _learnedWeights = null    // training found no improvement; keep fixed weights
      } else {
        _learnedWeights = w
      }
    } else {
      _learnedWeights = null
    }
  } catch (_) {
    _learnedWeights = null
  }
}
loadLearnedWeights()  // load once at startup

// Auto-reload when model.json changes on disk (e.g. after npm run train).
// fs.watchFile uses polling — reliable across all platforms, no ENOENT crash.
fs.watchFile(WEIGHTS_FILE, { interval: 5000, persistent: false }, () => {
  loadLearnedWeights()
})

// ── Model E: Python GBM scores (offline, optional) ────────────────────────
// Generated by: python python/ml_predictor.py  → python/ml_output.json
// Treated as a fixed prior distribution over combos. When stale (dataset grew
// > GBM_MAX_STALENESS records since GBM run), scores are ignored (sE = 0).

let _gbmScores = null
let _gbmTrainRecords = 0

function loadGBMScores() {
  try {
    const raw = fs.readFileSync(GBM_FILE, 'utf8')
    const obj = JSON.parse(raw)
    if (obj.scores && typeof obj.scores === 'object') {
      _gbmScores = obj.scores
      _gbmTrainRecords = obj.trainRecords || 0
    } else {
      _gbmScores = null
    }
  } catch (_) {
    _gbmScores = null
  }
}
loadGBMScores()

/** Returns GBM score map or {} when file absent / stale. */
function getGBMScores(currentN) {
  if (!_gbmScores) return {}
  if (Math.abs(currentN - _gbmTrainRecords) > GBM_MAX_STALENESS) return {}
  return _gbmScores
}
const SUM_COUNT = {
  3: 1, 4: 3, 5: 6, 6: 10, 7: 15, 8: 21,
  9: 25, 10: 27, 11: 27, 12: 25, 13: 21, 14: 15,
  15: 10, 16: 6, 17: 3, 18: 1,
}

function key(n1, n2, n3) { return `${n1}-${n2}-${n3}` }

function classify(a, b, c) {
  if (a === b && b === c) return 'triple'
  if (a === b || b === c || a === c) return 'pair'
  return 'normal'
}

const ALL_COMBOS = []
for (let a = 1; a <= 6; a++)
  for (let b = 1; b <= 6; b++)
    for (let c = 1; c <= 6; c++)
      ALL_COMBOS.push([a, b, c])

const ALPHA = 0.5  // Laplace smoothing constant for Markov model B

/**
 * Rank-percentile normalize a score map {key: number} → {key: [0,1]}.
 *
 * Assigns each combo its fractional rank: 0 = worst, 1 = best.
 * With 216 combos rank resolution is 1/215 ≈ 0.46%.
 *
 * Why rank instead of min-max:
 *   - Invariant to the *magnitude* of raw scores (kNN dist, z-score range, etc.)
 *   - Range stays [0,1] as N grows — learned weights stay calibrated
 *   - min-max range shifts as the dataset size changes, destabilising weights
 *
 * All-equal values → 0.5 (model is uninformative, treated as neutral).
 */
function rankNorm(scoreMap) {
  const keys = Object.keys(scoreMap)
  if (!keys.length) return scoreMap
  const sorted = keys.slice().sort((a, b) => scoreMap[a] - scoreMap[b])
  const n = sorted.length
  if (n === 1) return { [keys[0]]: 0.5 }
  const out = {}
  sorted.forEach((k, i) => { out[k] = i / (n - 1) })
  return out
}

// ── MODEL A: Statistical z-score + S3–S6 (single O(N) pass) ──────────────
/**
 * Model A: gap-based z-score with 4 auxiliary signals in ONE O(N) pass.
 *
 *   z = (currentGap – avgGap) / stdGap  [clamped to 0–4]
 *   z ≤ 0 → score = 0 (recently appeared, no boost)
 *   Never seen → z = 0  (no position; IID random has no memory—assigning
 *                         z=2 was Gambler's Fallacy hardcoded into the prior)
 *
 * Auxiliary signals (ADDITIVE, not multiplicative):
 *   S3 (+0–30%) sum-bucket observed short vs expected (last-200 draws)
 *   S4 (+0–15%) digit momentum (last-30 draws)
 *   S5/S6 mutually exclusive (+0–5% max): only the larger of the two fires
 *
 * Additive form prevents non-linear score inflation when multiple signals
 * are simultaneously strong (e.g. S3+S4 combined can be at most +45% vs
 * the old multiplicative +49.5%).
 */
function modelA(chron) {
  const N = chron.length
  const start200 = Math.max(0, N - 200)  // window for S3
  const start30 = Math.max(0, N - 30)   // window for S4

  // ── Single O(N) pass accumulates all signal data ───────────────────────
  const lastIdx = {}   // combo → last draw index (for gap tracking)
  const gapLists = {}   // combo → array of historical gaps

  const sumCountW = {}   // S3: sum count in last-200 draws
  const digitCntW = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }  // S4: digit count in last-30

  const sumLastSeen = {}   // S5: last draw index where this sum appeared
  const sumGapList = {}   // S5: gaps between same-sum draws

  const pairLastSeen = {}   // S6: last draw index where this pair-digit fired
  const pairGapList = {}   // S6: gaps between same-pair-digit draws

  for (let i = 0; i < N; i++) {
    const r = chron[i]
    const k = key(r.n1, r.n2, r.n3)
    const s = r.n1 + r.n2 + r.n3

    // Combo gaps (for z-score)
    if (lastIdx[k] !== undefined) {
      if (!gapLists[k]) gapLists[k] = []
      gapLists[k].push(i - lastIdx[k])
    }
    lastIdx[k] = i

    // S3: count sums in last-200 window
    if (i >= start200) sumCountW[s] = (sumCountW[s] || 0) + 1

    // S4: count digits in last-30 window
    if (i >= start30) { digitCntW[r.n1]++; digitCntW[r.n2]++; digitCntW[r.n3]++ }

    // S5: track gap between draws of the same sum
    if (sumLastSeen[s] !== undefined) {
      if (!sumGapList[s]) sumGapList[s] = []
      sumGapList[s].push(i - sumLastSeen[s])
    }
    sumLastSeen[s] = i

    // S6: track gap between draws containing each pair-digit (≥2 dice equal).
    // Avoid double-counting triples (1-1-1) using arithmetic rather than Set.
    const pv1 = (r.n1 === r.n2 || r.n1 === r.n3) ? r.n1 : -1
    const pv2 = (r.n2 === r.n3 && r.n2 !== pv1) ? r.n2 : -1
    if (pv1 !== -1) {
      if (pairLastSeen[pv1] !== undefined) {
        if (!pairGapList[pv1]) pairGapList[pv1] = []
        pairGapList[pv1].push(i - pairLastSeen[pv1])
      }
      pairLastSeen[pv1] = i
    }
    if (pv2 !== -1) {
      if (pairLastSeen[pv2] !== undefined) {
        if (!pairGapList[pv2]) pairGapList[pv2] = []
        pairGapList[pv2].push(i - pairLastSeen[pv2])
      }
      pairLastSeen[pv2] = i
    }
  }

  // ── Derive per-sum and per-digit signals ──────────────────────────────
  // S3: observed deficit vs theoretical expectation over last-200
  const W200 = N - start200
  const sumDev = {}
  for (let s = 3; s <= 18; s++) {
    const expected = W200 * (SUM_COUNT[s] / 216)
    sumDev[s] = expected > 0 ? Math.max(0, expected - (sumCountW[s] || 0)) / expected : 0
  }

  // S4: digit momentum — excess count vs expected in last-30
  const W30 = N - start30
  const expected30 = W30 * 3 / 6    // each digit expected W30*3/6 appearances
  const digitHot = {}
  for (let d = 1; d <= 6; d++) {
    digitHot[d] = expected30 > 0 ? Math.max(0, digitCntW[d] - expected30) / expected30 : 0
  }

  // S5: for each sum, overdue ratio = draws since last / avg gap (>1 = overdue)
  const sumOD = {}
  for (let s = 3; s <= 18; s++) {
    const since = sumLastSeen[s] !== undefined ? N - 1 - sumLastSeen[s] : N
    const g = sumGapList[s] || []
    const avg = g.length ? g.reduce((a, b) => a + b, 0) / g.length : N
    sumOD[s] = avg > 0 ? since / avg : 1
  }

  // S6: for each pair-digit, overdue ratio
  const pairOD = {}
  for (let v = 1; v <= 6; v++) {
    const since = pairLastSeen[v] !== undefined ? N - 1 - pairLastSeen[v] : N
    const g = pairGapList[v] || []
    const avg = g.length ? g.reduce((a, b) => a + b, 0) / g.length : N
    pairOD[v] = avg > 0 ? since / avg : 1
  }

  // ── Score each of the 216 combos ──────────────────────────────────────
  const scores = {}
  const zMap = {}
  const gapMeta = {}

  for (const [a, b, c] of ALL_COMBOS) {
    const k = key(a, b, c)
    const gaps = gapLists[k] || []
    const curGap = lastIdx[k] !== undefined ? N - 1 - lastIdx[k] : N

    const avg = gaps.length ? gaps.reduce((s, v) => s + v, 0) / gaps.length : null
    const variance = gaps.length > 1
      ? gaps.reduce((acc, g) => acc + (g - avg) ** 2, 0) / gaps.length
      : null
    const std = variance !== null ? Math.sqrt(variance) : null

    let z
    if (avg !== null && std !== null && std >= 1) {
      z = (curGap - avg) / std
    } else if (avg !== null) {
      z = Math.max(-2, Math.min(2, (curGap - avg) / avg))
    } else {
      z = 0  // never seen — IID game has no memory; unseen ≠ overdue
      // (was z=2.0 which hardcoded Gambler's Fallacy as prior)
    }

    zMap[k] = z
    gapMeta[k] = {
      currentGap: curGap,
      avgGap: avg,
      stability: avg !== null && std !== null && std > 0 ? avg / std : null,
    }

    const baseScore = Math.max(0, Math.min(4, z))

    // Sample-size decay: shrink modelA influence when data is sparse.
    // log(N)/log(5000) reaches 1.0 at 5000 draws; below that, caps overconfident z-scores.
    const sampleDecay = Math.min(1, Math.log(Math.max(N, 2)) / Math.log(5000))

    // S3 & S4 — can add up to 30% + 15% for strong signals
    const s3 = 1 + sumDev[a + b + c] * 0.30
    const digits = a === b && b === c ? [a] : a === b ? [a, c] : a === c ? [a, b] : b === c ? [b, a] : [a, b, c]
    const avgHot = digits.reduce((acc, d) => acc + digitHot[d], 0) / digits.length
    const s4 = 1 + avgHot * 0.15

    // S5 & S6 — mutually exclusive (only the stronger one fires, max +5%).
    const sumRatio = sumOD[a + b + c] || 1
    const s5raw = sumRatio > 1 ? Math.min(0.05, (sumRatio - 1) * 0.04) : 0

    const pat = classify(a, b, c)
    let s6raw = 0
    if (pat === 'pair' || pat === 'triple') {
      const pairDigit = (a === b || a === c) ? a : b
      const pRatio = pairOD[pairDigit] || 1
      s6raw = pRatio > 1 ? Math.min(0.05, (pRatio - 1) * 0.03) : 0
    }

    // ADDITIVE combination: 1 + (s3 contrib) + (s4 contrib) + (s5/s6 contrib)
    // Max total boost: 1 + 0.30 + 0.15 + 0.05 = 1.50× (vs old multiplicative ≈1.57×)
    // Prevents non-linear inflation from simultaneous strong signals.
    const auxBoost = 1 + sumDev[a + b + c] * 0.30 + avgHot * 0.15 + Math.max(s5raw, s6raw)

    scores[k] = baseScore * sampleDecay * auxBoost
  }
  return { scores, zMap, gapMeta }
}

// ── MODEL B: Markov order-2 ───────────────────────────────────────────────

function buildMarkov2(chron) {
  const map = {}
  for (let i = 2; i < chron.length; i++) {
    const p2 = key(chron[i - 2].n1, chron[i - 2].n2, chron[i - 2].n3)
    const p1 = key(chron[i - 1].n1, chron[i - 1].n2, chron[i - 1].n3)
    const cur = key(chron[i].n1, chron[i].n2, chron[i].n3)
    const sk = `${p2}|${p1}`
    if (!map[sk]) map[sk] = {}
    map[sk][cur] = (map[sk][cur] || 0) + 1
  }
  return map
}

/**
 * Model B: Markov order-2 with Laplace smoothing (α=0.5) and fallback chain:
 *   order-2 (any observations) → order-1 → Laplace-uniform = 1/216
 * Laplace smoothing: P(k|ctx) = (count(k,ctx) + α) / (total(ctx) + α×216)
 * Eliminates zero probabilities and removes ≥5-obs threshold — handles sparse contexts.
 */
function modelB(chron) {
  const N = chron.length
  const uniform = () => {
    const u = {}
    for (const [a, b, c] of ALL_COMBOS) u[key(a, b, c)] = 1 / 216
    return u
  }
  if (N < 1) return uniform()

  const p1k = key(chron[N - 1].n1, chron[N - 1].n2, chron[N - 1].n3)

  // Try order-2
  if (N >= 3) {
    const p2k = key(chron[N - 2].n1, chron[N - 2].n2, chron[N - 2].n3)
    const mk2 = buildMarkov2(chron)
    const trans2 = mk2[`${p2k}|${p1k}`]
    if (trans2) {
      const total2 = Object.values(trans2).reduce((s, v) => s + v, 0)
      const sc = {}
      for (const [a, b, c] of ALL_COMBOS) {
        const k = key(a, b, c)
        sc[k] = ((trans2[k] || 0) + ALPHA) / (total2 + ALPHA * 216)
      }
      return sc
    }
  }

  // Fallback to order-1
  const mk1 = {}
  for (let i = 1; i < N; i++) {
    const prev = key(chron[i - 1].n1, chron[i - 1].n2, chron[i - 1].n3)
    const cur = key(chron[i].n1, chron[i].n2, chron[i].n3)
    if (!mk1[prev]) mk1[prev] = {}
    mk1[prev][cur] = (mk1[prev][cur] || 0) + 1
  }
  const trans1 = mk1[p1k]
  if (trans1) {
    const total1 = Object.values(trans1).reduce((s, v) => s + v, 0)
    const sc = {}
    for (const [a, b, c] of ALL_COMBOS) {
      const k = key(a, b, c)
      sc[k] = ((trans1[k] || 0) + ALPHA) / (total1 + ALPHA * 216)
    }
    return sc
  }

  // Final fallback: Laplace-uniform = 1/216 (equivalent since no context observed)
  return uniform()
}

// ── MODEL C: Time-of-day session frequency ratio ──────────────────────────

function getSession(hoursOrDateStr) {
  let h
  if (typeof hoursOrDateStr === 'number') {
    h = hoursOrDateStr  // caller passes VN hour directly
  } else {
    // drawTime strings include TZ offset (e.g. +07:00). Use UTC math to get
    // Vietnam local hour regardless of the server's system TZ (Fly.io is UTC).
    const d = new Date(hoursOrDateStr)
    h = (d.getUTCHours() + 7) % 24
  }
  if (h >= 6 && h < 12) return 'morning'
  if (h >= 12 && h < 18) return 'afternoon'
  return 'evening'
}

// Rolling window for Model C session frequency.
// Using ALL historical session draws (~15k records) makes the frequency so stable
// that adding one new draw barely shifts any combo's rank: at N=15000, one new draw
// changes a combo's count by 0.0067% — not enough to change Top 10.
// With SESS_WINDOW=300 (~1 day of any session), each new draw affects ~0.33% of the
// sample so combos rotate visibly. When a top-ranked (session-rare) combo appears,
// its count jumps 0→1 (from 0% to 0.72× expected), exits the rare group, and a
// different combo takes its place in the next /predict call.
const SESS_WINDOW = 300

/**
 * Model C: frequency ratio for the current day-part session.
 * Returns {} when N < 5000 (hard disable — ~339 draws/session gives ~1.57
 * appearances per combo, variance too high for reliable signal; wC=-0.10 confirms).
 * Also returns {} when < 20 draws in session after threshold met.
 * Uses a rolling window of the most recent SESS_WINDOW session draws so that each
 * new draw measurably changes session ranks (instead of being diluted in 15k records).
 */
function modelC(chron, now) {
  if (chron.length < 5000) return {}  // hard-disable: insufficient data
  // Use Vietnam time (UTC+7) for both history classification and current session.
  const vnHour = (now.getUTCHours() + 7) % 24
  const cur = getSession(vnHour)
  // Filter ALL historical session draws, then take the most recent SESS_WINDOW.
  // chron is sorted oldest-first; slice(-N) gives the N most recent session draws.
  const allSessData = chron.filter(r => r.drawTime && getSession(r.drawTime) === cur)
  const sessData = allSessData.length > SESS_WINDOW ? allSessData.slice(-SESS_WINDOW) : allSessData
  if (sessData.length < 20) return {}

  const W = sessData.length
  const expected = W / 216
  const countMap = {}
  for (const r of sessData) {
    const k = key(r.n1, r.n2, r.n3)
    countMap[k] = (countMap[k] || 0) + 1
  }
  const sc = {}
  for (const [a, b, c] of ALL_COMBOS) {
    const k = key(a, b, c)
    sc[k] = (countMap[k] || 0) / expected
  }
  return sc
}

// ── S2: Triple streak boost (applied AFTER ensemble) ─────────────────────

/**
 * Graduated overdue multiplier for triple combos.
 *
 * The ensemble score range across all top-10 combos is typically ~0.015–0.025,
 * so each rank position is worth only ~0.002 in score. This means even a 1%
 * boost can shift a combo 3–5 rank positions. The slope MUST be very gentle.
 *
 * Design targets (starting from the natural rank of ~7–8 when slightly overdue):
 *   ratio 1.5–2.0  (54–72 draws)   → top-5 to top-7   (+0.3–0.5%)
 *   ratio 3.0      (108 draws ~10h) → top-3 to top-5   (+1.0%)
 *   ratio 5.0+     (180+ draws)     → can reach top-1–2 (+2.0%, capped)
 *
 *   formula: min(1.020, 1 + (ratio − 1.0) × 0.005)
 */
function tripleBoostMult(chron) {
  let sinceTriple = 0
  for (let i = chron.length - 1; i >= 0; i--) {
    const pat = chron[i].pattern || classify(chron[i].n1, chron[i].n2, chron[i].n3)
    if (pat === 'triple') break
    sinceTriple++
  }
  const EXPECTED_GAP = 36     // 1-in-36 draws is a triple
  const ratio = sinceTriple / EXPECTED_GAP
  if (ratio <= 1.0) return 1.0
  return Math.min(1.020, 1 + (ratio - 1.0) * 0.005)
}

// ── ENSEMBLE ──────────────────────────────────────────────────────────────

function ensembleAll(chron, now) {
  const DIGIT_RECENCY_K = 3  // look at last 3 draws for digit-position overlap
  // Reality-aware weight shrinking: when statistical tests find no detectable pattern,
  // shrink pattern-detection model weights (A, B, D) toward zero so the ensemble
  // produces more uniform predictions — intellectually honest for a near-random game.
  const statRes = runStatTests(chron)

  // Direction 3+4: Bayesian shrink via signal confidence derived from p-values.
  //   no_pattern (sigCount=0) → shrink=0 → kill A, B, D; fallback to session+GBM+uniform
  //   weak/strong pattern     → shrink ∝ min(p-values): continuous ramp 0.5 → 1.0
  const sigCount = [
    statRes.chiSquare.significant,
    statRes.autocorr.significant,
    statRes.runs.significant,
  ].filter(Boolean).length

  let shrink
  if (sigCount === 0) {
    shrink = 0.0   // no detectable pattern: wA=wB=wD effectively zeroed
  } else {
    const pVals = [statRes.chiSquare, statRes.autocorr, statRes.runs]
      .filter(t => t.pValue !== null)
      .map(t => t.pValue)
    const pMin = Math.min(...pVals)
    // pMin≈0.05 → shrink≈1.0;  pMin≈0.49 → shrink→0.5 (clamped minimum)
    shrink = Math.max(0.5, Math.min(1.0, (0.5 - pMin) / 0.45))
  }

  const { scores: rawA, zMap, gapMeta } = modelA(chron)  // gapMeta built in same O(N) pass
  const rawB = modelB(chron)
  const rawC = modelC(chron, now)

  // Auto-disable Model D (k-NN) when learned weight wD ≤ 0 (zero or negative).
  // wD=0 means the model contributes nothing to the ensemble score; running it
  // is pure wasted compute (k-NN on 40k records is O(N²) per predict call).
  const lw = _learnedWeights
  const killD = lw !== null && (lw.wD ?? 0) <= 0
  const rawD = killD ? {} : modelD(chron)

  // Model E: Python GBM prior (loaded from python/ml_output.json, if present & fresh)
  const rawE = getGBMScores(chron.length)

  const A = rankNorm(rawA)
  const B = rankNorm(rawB)
  const hasC = Object.keys(rawC).length > 0
  const hasD = Object.keys(rawD).length > 0
  const hasE = Object.keys(rawE).length > 0
  const C = hasC ? rankNorm(rawC) : {}
  const D = hasD ? rankNorm(rawD) : {}
  const E = hasE ? rankNorm(rawE) : {}

  // Fixed fallback weights (graceful degradation when models inactive)
  const wA_fixed = hasC && hasD ? 0.40 : hasD ? 0.45 : hasC ? 0.50 : 0.60
  const wB_fixed = hasC && hasD ? 0.25 : hasD ? 0.35 : hasC ? 0.30 : 0.40
  const wC_fixed = hasC ? (hasD ? 0.15 : 0.20) : 0
  const wD_fixed = hasD ? 0.20 : 0
  // E not used in fixed fallback — requires trained weight to avoid guessing

  const tripleBoost = tripleBoostMult(chron)

  const results = {}
  for (const [a, b, c] of ALL_COMBOS) {
    const k = key(a, b, c)
    const pat = classify(a, b, c)
    const sA = A[k] ?? 0.5
    const sB = B[k] ?? 0.5
    const sC = hasC ? (C[k] ?? 0.5) : 0
    // k-NN: combos absent from similar historical contexts score 0 (strong signal)
    // sD=0 when killD=true (wD<0 → k-NN currently harmful, auto-disabled)
    const sD = hasD ? (D[k] ?? 0) : 0
    // GBM prior: fixed distribution over combos from Python offline training
    const sE = hasE ? (E[k] ?? 0.5) : 0

    let score
    if (lw) {
      const wE = lw.wE ?? 0
      // Apply shrinkFactor to pattern-detecting models (A, B, D); leave session (C) and GBM (E) unchanged
      score = sigmoid((lw.wA * shrink) * sA + (lw.wB * shrink) * sB + lw.wC * sC + (lw.wD * shrink) * sD + wE * sE + lw.bias)
    } else {
      // Apply shrink to pattern-detecting models in fixed-weight fallback too.
      // When shrink=0 (no_pattern) and no session data → pure uniform (0.5).
      if (shrink === 0 && !hasC) {
        score = 0.5
      } else {
        score = wA_fixed * shrink * sA + wB_fixed * shrink * sB + wC_fixed * sC + wD_fixed * shrink * sD
      }
    }

    // Apply triple streak boost AFTER ensemble combination
    if (pat === 'triple') score *= tripleBoost

    // Cooldown penalty: suppress recently-appeared combos across all models.
    // When z < 0, the combo appeared sooner than its own historical average.
    // Even if Markov/session models vote for it, we respect the z-signal:
    //   z=-1.0 → ×0.37;  z=-1.5 → ×0.22;  z=-3.0 → ×0.05 (near-zero).
    const zVal = zMap[k]
    if (zVal < 0) score *= Math.exp(Math.max(-3, zVal))

    // Digit-position recency: penalize combos sharing digit-positions with
    // recent draws. Without this, after draw 1-1-2 the top-10 would still
    // contain many 1-1-X combos because z-score only penalizes the EXACT
    // combo. This ensures partial-match rotation: "digits already appeared
    // → other digits should take priority".
    //
    // Scan last DIGIT_RECENCY_K draws. For each, count how many of the 3
    // digit-positions match. 2+ matches → apply decaying penalty.
    //   last draw, 2 match: ×0.55  |  3 match (exact): ×0.41 (stacks with z-cooldown)
    //   2nd-to-last, 2 match: ×0.74  |  3rd-to-last, 2 match: ×0.82
    for (let d = 0; d < DIGIT_RECENCY_K && d < chron.length; d++) {
      const rd = chron[chron.length - 1 - d]
      let posMatch = 0
      if (a === rd.n1) posMatch++
      if (b === rd.n2) posMatch++
      if (c === rd.n3) posMatch++
      if (posMatch >= 2) {
        score *= Math.exp(-0.3 * posMatch / (1 + d))
      }
    }

    results[k] = {
      combo: k,
      pat,
      sum: a + b + c,
      score,
      z: zMap[k],
      currentGap: gapMeta[k].currentGap,
      avgGap: gapMeta[k].avgGap,
      stability: gapMeta[k].stability,
      statNorm: +sA.toFixed(4),
      mk2Norm: +sB.toFixed(4),
      sessNorm: +(hasC ? (C[k] ?? 0) : 0).toFixed(4),
      mlNorm: +(hasD ? (D[k] ?? 0) : 0).toFixed(4),
      gbmNorm: +(hasE ? (E[k] ?? 0) : 0).toFixed(4),
    }
  }

  // Compute score range across all 216 combos for confidence normalization
  const allScores = Object.values(results).map(r => r.score)
  const scoreMin = Math.min(...allScores)
  const scoreMax = Math.max(...allScores)
  for (const r of Object.values(results)) {
    r.scoreRankPct = scoreMax > scoreMin
      ? +((r.score - scoreMin) / (scoreMax - scoreMin) * 100).toFixed(1)
      : 50
  }

  // P4: Compute effective model contributions as % of total absolute weight
  // Shows the user what fraction of the scoring each model truly accounts for.
  // Only include models that are actively producing non-uniform scores.
  let effectiveWeights
  if (lw) {
    const items = [
      { name: 'stat', w: Math.abs(lw.wA * shrink) },
      { name: 'mk2', w: Math.abs(lw.wB * shrink) },
      { name: 'sess', w: hasC ? Math.abs(lw.wC) : 0 },           // 0 if C hard-disabled
      { name: 'knn', w: hasD ? Math.abs((lw.wD ?? 0) * shrink) : 0 },
      { name: 'gbm', w: hasE ? Math.abs(lw.wE ?? 0) : 0 },
    ]
    const total = items.reduce((s, m) => s + m.w, 0) || 0
    effectiveWeights = { _uniform: total === 0 }  // all-zero → pure portfolio diversity
    for (const { name, w } of items) effectiveWeights[name] = total > 0 ? +(w / total * 100).toFixed(1) : 0
  } else {
    const items = [
      { name: 'stat', w: wA_fixed * shrink },
      { name: 'mk2', w: wB_fixed * shrink },
      { name: 'sess', w: hasC ? wC_fixed : 0 },
      { name: 'knn', w: hasD ? wD_fixed * shrink : 0 },
      { name: 'gbm', w: 0 },
    ]
    const total = items.reduce((s, m) => s + m.w, 0) || 0
    effectiveWeights = { _uniform: total === 0 }
    for (const { name, w } of items) effectiveWeights[name] = total > 0 ? +(w / total * 100).toFixed(1) : 0
  }

  return { results, effectiveWeights }
}

// ── Portfolio-based top-10 selection ──────────────────────────────────────

/**
 * Jaccard digit-overlap between two combo strings (unique-digit sets).
 *   "1-2-3" vs "1-2-4" → shared={1,2}, maxSize=3 → 0.667
 *   "1-1-1" vs "2-2-2" → shared=∅              → 0.000
 * Used to estimate correlation between two combo picks in the portfolio.
 */
function comboDigitOverlap(comboKeyA, comboKeyB) {
  const aSet = new Set(comboKeyA.split('-').map(Number))
  const bSet = new Set(comboKeyB.split('-').map(Number))
  let shared = 0
  for (const d of aSet) if (bSet.has(d)) shared++
  return shared / Math.max(aSet.size, bSet.size)
}

/**
 * Portfolio top-10 selection — maximizes expected coverage P(hit ≥ 1).
 *
 * Greedy slot-by-slot objective:
 *   argmax_k [ score_k − λ × avgDigitOverlap(k, already_selected) ]
 *
 * Compared to pure top-by-score:
 *   - Equivalent to portfolio theory: penalises correlated bets, rewards spread.
 *   - When shrink=0 (no_pattern): scores are near-uniform → selection is purely
 *     diversity-driven → maximum digit-space coverage with zero false confidence.
 *
 * λ = 0.10  (diversity penalty weight).
 * Pattern caps preserved: max 2 triple, 4 pair, 4 normal.
 * Pass 0: with pattern cap.  Pass 1: uncapped fallback (fill remaining slots).
 */
function selectTop10(results) {
  const DIVERSITY_LAMBDA = 0.10
  const sorted = Object.values(results).sort((a, b) => b.score - a.score)
  const capPat = { triple: 2, pair: 4, normal: 4 }
  const countPat = { triple: 0, pair: 0, normal: 0 }
  const selected = []
  const chosenKeys = new Set()

  for (let pass = 0; pass < 2 && selected.length < 10; pass++) {
    const useCap = pass === 0
    while (selected.length < 10) {
      let bestItem = null
      let bestPS = -Infinity

      for (const r of sorted) {
        if (chosenKeys.has(r.combo)) continue
        if (useCap && countPat[r.pat] >= capPat[r.pat]) continue

        const avgOverlap = selected.length > 0
          ? selected.reduce((sum, s) => sum + comboDigitOverlap(r.combo, s.combo), 0) / selected.length
          : 0

        const ps = r.score - DIVERSITY_LAMBDA * avgOverlap
        if (ps > bestPS) { bestPS = ps; bestItem = r }
      }

      if (!bestItem) break  // no candidates left in this pass

      selected.push(bestItem)
      chosenKeys.add(bestItem.combo)
      countPat[bestItem.pat]++
    }
  }

  return selected.sort((a, b) => b.score - a.score)
}

/**
 * Prevent triple combos from dominating top-1/top-2 under weak evidence.
 *
 * Policy:
 *   - default: triple should start from rank >= 5
 *   - strongly overdue (ratio >= 2.2): triple can start from rank >= 3
 *   - very strong signal (pattern_detected and ratio >= 3.0): triple may be rank 1
 */
function rebalanceTripleRanks(top10, overdueRatio, verdict) {
  if (!Array.isArray(top10) || top10.length === 0) return top10

  let minTripleRank = 5
  if (overdueRatio >= 2.2) minTripleRank = 3
  if (verdict === 'pattern_detected' && overdueRatio >= 3.0) minTripleRank = 1
  if (minTripleRank === 1) return top10

  const delayedTriples = []
  const kept = []
  for (let i = 0; i < top10.length; i++) {
    const r = top10[i]
    const rank = i + 1
    if (r.pat === 'triple' && rank < minTripleRank) delayedTriples.push(r)
    else kept.push(r)
  }

  if (!delayedTriples.length) return top10

  const insertAt = Math.min(kept.length, minTripleRank - 1)
  kept.splice(insertAt, 0, ...delayedTriples)
  return kept.slice(0, 10)
}

// ── Public API ────────────────────────────────────────────────────────────

function predictRanked(data) {
  if (!data) data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
  if (!data || data.length < 2) return { top10: [], tripleSignal: null }
  const chron = [...data].sort((a, b) => Number(a.ky) - Number(b.ky))
  const now = new Date()
  const statRes = runStatTests(chron)
  const { results: all, effectiveWeights } = ensembleAll(chron, now)

  // ── Triple signal: single O(N) pass for all triple stats ────────────
  const EXPECTED_GAP = 36 // 6/216 — one triple every 36 draws on average
  let tripleCount = 0
  let lastTripleIdx = -1
  const tripleGaps = []
  chron.forEach((r, i) => {
    const pat = r.pattern || classify(r.n1, r.n2, r.n3)
    if (pat === 'triple') {
      tripleCount++
      if (lastTripleIdx >= 0) tripleGaps.push(i - lastTripleIdx)
      lastTripleIdx = i
    }
  })
  const sinceTriple = lastTripleIdx >= 0 ? chron.length - 1 - lastTripleIdx : chron.length
  const overdueRatio = sinceTriple / EXPECTED_GAP
  const avgTripleGap = tripleGaps.length
    ? +(tripleGaps.reduce((a, b) => a + b, 0) / tripleGaps.length).toFixed(1)
    : EXPECTED_GAP

  const boostMult = tripleBoostMult(chron)
  let top10 = selectTop10(all)
  top10 = rebalanceTripleRanks(top10, overdueRatio, statRes.verdict)

  // Show all triples that made it into top10 — if a triple is here it earned
  // its place via the overdue boost proportional to kỳ chưa về.
  const hotTriples = top10
    .filter(r => r.pat === 'triple')
    .map(r => r.combo)

  const tripleSignal = {
    sinceLastTriple: sinceTriple,
    expectedGap: EXPECTED_GAP,
    avgGap: avgTripleGap,
    overdueRatio: +overdueRatio.toFixed(2),
    boostMult: +boostMult.toFixed(2),
    appeared: tripleCount,
    verdict: statRes.verdict,
    aiConfirmed: hotTriples.length > 0,
    hotTriples,
  }

  const mapped = top10.map(r => ({
    combo: r.combo,
    score: +r.score.toFixed(4),
    scoreRankPct: r.scoreRankPct ?? 50,
    pct: 0,           // filled by server.js
    overdueRatio: r.z,
    comboGap: r.currentGap,
    sumOD: 0,
    pat: r.pat,
    stability: r.stability,
    zScore: r.z,
    statNorm: r.statNorm,
    mk2Norm: r.mk2Norm,
    sessNorm: r.sessNorm,
    mlNorm: r.mlNorm ?? 0,
    gbmNorm: r.gbmNorm ?? 0,
    coreNorm: r.statNorm,
    chiNorm: 0,
  }))

  return { top10: mapped, tripleSignal, effectiveWeights, verdict: statRes.verdict }
}

/** Score map for all 216 combos — used by /stats backtest. */
function predict(data) {
  if (!data) data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
  if (!data || data.length < 2) return {}
  const chron = [...data].sort((a, b) => Number(a.ky) - Number(b.ky))
  const now = new Date()
  const { results: all } = ensembleAll(chron, now)
  const out = {}
  for (const [k, v] of Object.entries(all)) out[k] = v.score
  return out
}

/**
 * Returns per-model normalised scores for all 216 combos.
 * Used by scripts/train_weights.js for walk-forward weight optimisation.
 */
function getModelScores(data, now) {
  if (!data || data.length < 2) return {}
  const chron = [...data].sort((a, b) => Number(a.ky) - Number(b.ky))
  if (!now) now = new Date()

  const { scores: rawA } = modelA(chron)
  const rawB = modelB(chron)
  const rawC = modelC(chron, now)
  // Mirror the auto-disable logic from ensembleAll
  const lw_gs = _learnedWeights
  const killD_gs = lw_gs !== null && (lw_gs.wD ?? 0) < 0
  const rawD = killD_gs ? {} : modelD(chron)

  const rawE = getGBMScores(chron.length)

  const A = rankNorm(rawA)
  const B = rankNorm(rawB)
  const hasC = Object.keys(rawC).length > 0
  const hasD = Object.keys(rawD).length > 0
  const hasE = Object.keys(rawE).length > 0
  const C = hasC ? rankNorm(rawC) : {}
  const D = hasD ? rankNorm(rawD) : {}
  const E = hasE ? rankNorm(rawE) : {}

  const result = {}
  for (const [a, b, c] of ALL_COMBOS) {
    const k = key(a, b, c)
    result[k] = {
      sA: A[k] ?? 0.5,
      sB: B[k] ?? 0.5,
      sC: hasC ? (C[k] ?? 0.5) : 0,
      sD: hasD ? (D[k] ?? 0) : 0,
      sE: hasE ? (E[k] ?? 0.5) : 0,
    }
  }
  return result
}

predict.ranked = predictRanked
predict.getModelScores = getModelScores
predict.reloadWeights = loadLearnedWeights
predict.reloadGBM = loadGBMScores

// ── Sum prediction (16 outcomes) ──────────────────────────────────────────
// Exploits the lower dimensionality: 16 sums vs 216 combos → Markov-1 is
// feasible with 43k draws (~168 samples per state pair). z-score on sum gaps
// also converges faster.

const SUM_THEORETICAL = {}  // P(sum=s) = count(combos with that sum) / 216
for (const [a, b, c] of ALL_COMBOS) SUM_THEORETICAL[a + b + c] = (SUM_THEORETICAL[a + b + c] || 0) + 1 / 216

function predictSum(data) {
  if (!data || data.length < 30) return { sums: [], mode: 'insufficient' }
  const chron = [...data].sort((a, b) => Number(a.ky) - Number(b.ky))
  const N = chron.length

  // 1) z-score on sum gaps (same logic as Model A but on 16 sum buckets)
  const lastSeen = {}, gapLists = {}
  for (let i = 0; i < N; i++) {
    const s = chron[i].sum || (chron[i].n1 + chron[i].n2 + chron[i].n3)
    if (lastSeen[s] !== undefined) {
      if (!gapLists[s]) gapLists[s] = []
      gapLists[s].push(i - lastSeen[s])
    }
    lastSeen[s] = i
  }

  const zScores = {}
  for (let s = 3; s <= 18; s++) {
    const gaps = gapLists[s] || []
    const curGap = lastSeen[s] !== undefined ? N - 1 - lastSeen[s] : N
    const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null
    const variance = gaps.length > 1 ? gaps.reduce((acc, g) => acc + (g - avg) ** 2, 0) / gaps.length : null
    const std = variance !== null ? Math.sqrt(variance) : null
    if (avg !== null && std !== null && std >= 1) {
      zScores[s] = { z: (curGap - avg) / std, curGap, avgGap: avg }
    } else if (avg !== null) {
      zScores[s] = { z: Math.max(-2, Math.min(2, (curGap - avg) / avg)), curGap, avgGap: avg }
    } else {
      zScores[s] = { z: 0, curGap, avgGap: null }
    }
  }

  // 2) Markov-1 on sums: P(sum_next | sum_prev)
  const mk1 = {}
  for (let i = 1; i < N; i++) {
    const prev = chron[i - 1].sum || (chron[i - 1].n1 + chron[i - 1].n2 + chron[i - 1].n3)
    const cur = chron[i].sum || (chron[i].n1 + chron[i].n2 + chron[i].n3)
    if (!mk1[prev]) mk1[prev] = {}
    mk1[prev][cur] = (mk1[prev][cur] || 0) + 1
  }
  const lastSum = chron[N - 1].sum || (chron[N - 1].n1 + chron[N - 1].n2 + chron[N - 1].n3)
  const context = mk1[lastSum] || {}
  const ctxTotal = Object.values(context).reduce((s, v) => s + v, 0) || 0

  // 3) Session frequency on sums (rolling window)
  const now = new Date()
  const vnHour = (now.getUTCHours() + 7) % 24
  const curSession = getSession(vnHour)
  const sessDraws = chron.filter(r => r.drawTime && getSession(r.drawTime) === curSession)
  const sessRecent = sessDraws.length > SESS_WINDOW ? sessDraws.slice(-SESS_WINDOW) : sessDraws
  const sessSumCount = {}
  for (const r of sessRecent) {
    const s = r.sum || (r.n1 + r.n2 + r.n3)
    sessSumCount[s] = (sessSumCount[s] || 0) + 1
  }
  const sessTotal = sessRecent.length || 1

  // 4) Combine: z-score (overdue) + Markov transition + session deficit
  const results = []
  for (let s = 3; s <= 18; s++) {
    const zInfo = zScores[s]
    const zClamp = Math.max(0, Math.min(3, zInfo.z))  // overdue boost [0,3]
    const ALPHA = 0.5  // Laplace smoothing
    const mkProb = ctxTotal > 0 ? ((context[s] || 0) + ALPHA) / (ctxTotal + ALPHA * 16) : SUM_THEORETICAL[s] || (1 / 16)
    const sessRatio = sessTotal >= 20 ? (sessSumCount[s] || 0) / (sessTotal * (SUM_THEORETICAL[s] || 1 / 16)) : 1
    // sessDeficit: higher when sum appeared less than expected in current session
    const sessDeficit = Math.max(0, 1 - sessRatio) * 0.3  // 0–0.3 range

    const score = 0.4 * zClamp + 0.4 * (mkProb * 16) + 0.2 * sessDeficit  // weighted
    results.push({
      sum: s,
      score: +score.toFixed(3),
      z: +zInfo.z.toFixed(2),
      curGap: zInfo.curGap,
      avgGap: zInfo.avgGap != null ? +zInfo.avgGap.toFixed(1) : null,
      mkProb: +(mkProb * 100).toFixed(2),
      theoretical: +((SUM_THEORETICAL[s] || 0) * 100).toFixed(2),
      sessRatio: +sessRatio.toFixed(2),
    })
  }

  results.sort((a, b) => b.score - a.score)
  return {
    sums: results,
    prevSum: lastSum,
    session: curSession,
    mode: 'active',
  }
}

predict.predictSum = predictSum
module.exports = predict
