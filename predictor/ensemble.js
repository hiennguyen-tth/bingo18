'use strict'
/**
 * predictor/ensemble.js
 * 5-signal overdue-based scoring for all 216 Bingo18 combos.
 *
 * Weights:
 *   0.35  combo overdue ratio  – gap vs theoretical 216-kỳ expectation
 *   0.25  sum   overdue ratio  – gap vs per-sum expectation
 *   0.15  pattern overdue     – triple / pair / normal group gap
 *   0.15  number coldness     – cold digits (below avg frequency) favoured
 *   0.10  Markov transition   – previous→next combo probability
 *
 * A score of 1.0 = exactly at expectation. >1 = overdue = more attractive.
 */
const path = require('path')
const fs = require('fs')
const markovModule = require('./markov')

const HISTORY_FILE = path.join(__dirname, '../dataset/history.json')

// Ordered (n1,n2,n3 each 1–6) combos per sum value (verified: total = 216)
const SUM_COUNT = {
  3: 1, 4: 3, 5: 6, 6: 10, 7: 15, 8: 21,
  9: 25, 10: 27, 11: 27, 12: 25, 13: 21, 14: 15,
  15: 10, 16: 6, 17: 3, 18: 1,
}
// Number of ordered combos per pattern type
const PAT_COUNT = { triple: 6, pair: 90, normal: 120 }

function classify(a, b, c) {
  if (a === b && b === c) return 'triple'
  if (a === b || b === c || a === c) return 'pair'
  return 'normal'
}

/**
 * Score all 216 combos and return them ranked highest first.
 * @param {Array} data – draw records (any order; sorted internally by ky)
 * @returns {Array<{combo, score, comboGap, overdueRatio, sumGap, sumOD, sum, pat}>}
 */
function predictRanked(data) {
  if (!data) data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
  if (!data || data.length < 2) return []

  // Chronological (oldest first). Fallback: keep original order if no ky.
  const chron = data.every(r => r.ky != null)
    ? [...data].sort((a, b) => Number(a.ky) - Number(b.ky))
    : [...data]
  const N = chron.length

  // ── Gap tracking ──────────────────────────────────────────────────────
  const comboLast = {}
  const sumLast = {}
  const patLast = { triple: -1, pair: -1, normal: -1 }
  const numCount = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }

  chron.forEach((r, i) => {
    comboLast[`${r.n1}-${r.n2}-${r.n3}`] = i
    sumLast[r.sum] = i
    const pat = r.pattern || classify(r.n1, r.n2, r.n3)
    patLast[pat] = i
    numCount[r.n1]++; numCount[r.n2]++; numCount[r.n3]++
  })

  const expectedNumFreq = N * 3 / 6  // uniform distribution per digit

  // ── Markov ────────────────────────────────────────────────────────────
  const mkMap = markovModule(chron)
  const last = chron[N - 1]
  const mkRaw = mkMap[`${last.n1}-${last.n2}-${last.n3}`] || {}
  const mkTotal = Object.values(mkRaw).reduce((s, v) => s + v, 0) || 1

  // ── Score all 216 combos ──────────────────────────────────────────────
  const results = []
  for (let a = 1; a <= 6; a++) {
    for (let b = 1; b <= 6; b++) {
      for (let c = 1; c <= 6; c++) {
        const k = `${a}-${b}-${c}`
        const sum = a + b + c
        const pat = classify(a, b, c)

        // C1: combo overdue  (expected gap = 216 kỳ for any specific combo)
        const comboGap = comboLast[k] !== undefined ? (N - 1 - comboLast[k]) : N
        const c1 = comboGap / 216

        // C2: sum overdue
        const sumExpected = 216 / (SUM_COUNT[sum] || 1)
        const sumGap = sumLast[sum] !== undefined ? (N - 1 - sumLast[sum]) : N
        const c2 = sumGap / sumExpected

        // C3: pattern overdue
        const patExpected = 216 / PAT_COUNT[pat]
        const patGap = patLast[pat] >= 0 ? (N - 1 - patLast[pat]) : patExpected
        const c3 = patGap / patExpected

        // C4: number coldness (0 = all hot, 1 = all maximally cold → score 1–2)
        const cold = [a, b, c].reduce((s, n) => {
          return s + Math.max(0, expectedNumFreq - numCount[n])
        }, 0) / (3 * expectedNumFreq)
        const c4 = 1 + cold

        // C5: Markov transition probability
        const c5 = mkRaw[k] ? mkRaw[k] / mkTotal : 0

        const score = c1 * 0.35 + c2 * 0.25 + c3 * 0.15 + c4 * 0.15 + c5 * 0.10

        results.push({ combo: k, score, comboGap, overdueRatio: c1, sumGap, sumOD: c2, sum, pat })
      }
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results
}

/**
 * Backward-compatible export: returns { "combo": score } map.
 * Used by walk-forward backtest and unit tests.
 */
function predict(data) {
  const ranked = predictRanked(data)
  const out = {}
  for (const r of ranked) out[r.combo] = r.score
  return out
}

predict.ranked = predictRanked
module.exports = predict
