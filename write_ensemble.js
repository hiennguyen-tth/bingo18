'use strict'
const path = require('path')
const fs = require('fs')
const ensemblePath = path.join(__dirname, 'predictor/ensemble.js')

const code = `'use strict'
/**
 * predictor/ensemble.js — v2
 * Enhanced 7-signal overdue scoring:
 *   1. Pattern rarity weight   (triple 1.5x, pair 1.0x, normal 0.7x)
 *   2. Stability factor        (mean_gap / std_gap — rewards regular cycles)
 *   3. Momentum penalty        (< 0.3x avgGap since last → x0.7)
 *   4. Pre-triple signal       (no triple in last 3 draws → x1.15; recent triple → x0.6)
 *   5. Combo diversity         (max 2 triple, 4 pair, 4 normal in top-10)
 *   6. Family filter           (max 2 combos sharing any digit in top-10)
 *   7. Log(mean_gap) factor    (rewards combos with inherently longer expected gaps)
 *
 * Weights:  C1=0.30 combo · C2=0.25 sum · C3=0.20 pattern · C4=0.15 cold · C5=0.10 markov
 */
const path = require('path')
const fs   = require('fs')
const markovModule = require('./markov')

const HISTORY_FILE = path.join(__dirname, '../dataset/history.json')

const SUM_COUNT = {
  3:1,4:3,5:6,6:10,7:15,8:21,
  9:25,10:27,11:27,12:25,13:21,14:15,
  15:10,16:6,17:3,18:1,
}
const PAT_COUNT  = { triple:6, pair:90, normal:120 }
const PAT_WEIGHT = { triple:1.5, pair:1.0, normal:0.7 }

function classify(a, b, c) {
  if (a === b && b === c) return 'triple'
  if (a === b || b === c || a === c) return 'pair'
  return 'normal'
}

function buildComboStats(chron) {
  const lastIdx  = {}
  const gapLists = {}
  chron.forEach((r, i) => {
    const k = r.n1 + '-' + r.n2 + '-' + r.n3
    if (lastIdx[k] !== undefined) {
      if (!gapLists[k]) gapLists[k] = []
      gapLists[k].push(i - lastIdx[k])
    }
    lastIdx[k] = i
  })
  const stats = {}
  for (const k of Object.keys(lastIdx)) {
    const gaps = gapLists[k] || []
    const avg  = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null
    const std  = (gaps.length > 1 && avg !== null)
      ? Math.sqrt(gaps.map(g => (g - avg) * (g - avg)).reduce((a, b) => a + b, 0) / gaps.length)
      : null
    stats[k] = {
      appeared:  gaps.length + 1,
      avgGap:    avg,
      stdGap:    std,
      stability: (avg !== null && std !== null && std > 0) ? avg / std : 1.0,
      lastIdx:   lastIdx[k],
    }
  }
  return stats
}

function preTripleSignal(chron) {
  const N = chron.length
  if (N < 3) return 1.0
  const last3 = [chron[N-1], chron[N-2], chron[N-3]]
  const hasRecentTriple = last3.some(r => (r.pattern || classify(r.n1, r.n2, r.n3)) === 'triple')
  return hasRecentTriple ? 0.6 : 1.15
}

function scoreCombo(a, b, c, N, comboStats, sumLast, patLast, numCount, expectedNumFreq, mkRaw, mkTotal, tripleBoost) {
  const k   = a + '-' + b + '-' + c
  const sum = a + b + c
  const pat = classify(a, b, c)
  const st  = comboStats[k]

  const comboGapRaw = st ? (N - 1 - st.lastIdx) : N
  const c1 = Math.min(comboGapRaw, 2 * 216) / 216

  const sumExpected = 216 / (SUM_COUNT[sum] || 1)
  const sumGapRaw   = sumLast[sum] !== undefined ? (N - 1 - sumLast[sum]) : N
  const c2 = Math.min(sumGapRaw, 3 * sumExpected) / sumExpected

  const patExpected = 216 / PAT_COUNT[pat]
  const patGapRaw   = patLast[pat] >= 0 ? (N - 1 - patLast[pat]) : patExpected
  const c3 = Math.min(patGapRaw, 3 * patExpected) / patExpected

  const cold = [a, b, c].reduce((s, n) => s + Math.max(0, expectedNumFreq - numCount[n]), 0) / (3 * expectedNumFreq)
  const c4   = 1 + cold
  const c5   = mkRaw[k] ? mkRaw[k] / mkTotal : 0

  const overdueRatio = c1 * 0.30 + c2 * 0.25 + c3 * 0.20 + c4 * 0.15 + c5 * 0.10

  let stability = 1.0
  if (st && st.avgGap !== null && st.stability !== null) {
    stability = Math.max(0.6, Math.min(3.0, st.stability))
  }

  const avgGap    = (st && st.avgGap !== null) ? st.avgGap : (pat === 'triple' ? 216 : 36)
  const logFactor = Math.log(Math.max(avgGap, 2)) / Math.log(216)
  const momentum  = (comboGapRaw < 0.3 * avgGap) ? 0.7 : 1.0
  const tripleSignal = (pat === 'triple') ? tripleBoost : 1.0

  const rawScore = overdueRatio * PAT_WEIGHT[pat] * stability * logFactor * momentum * tripleSignal

  return { k, sum, pat, comboGapRaw, c1, c2, sumGapRaw, rawScore, overdueRatio, stability }
}

function buildState(chron) {
  const N = chron.length
  const comboStats = buildComboStats(chron)
  const sumLast    = {}
  const patLast    = { triple: -1, pair: -1, normal: -1 }
  const numCount   = { 1:0, 2:0, 3:0, 4:0, 5:0, 6:0 }
  chron.forEach((r, i) => {
    sumLast[r.sum] = i
    const pat = r.pattern || classify(r.n1, r.n2, r.n3)
    patLast[pat] = i
    numCount[r.n1]++; numCount[r.n2]++; numCount[r.n3]++
  })
  const expectedNumFreq = N * 3 / 6
  const mkMap   = markovModule(chron)
  const last    = chron[N - 1]
  const mkRaw   = mkMap[last.n1 + '-' + last.n2 + '-' + last.n3] || {}
  const mkTotal = Object.values(mkRaw).reduce((s, v) => s + v, 0) || 1
  const tripleBoost = preTripleSignal(chron)
  return { N, comboStats, sumLast, patLast, numCount, expectedNumFreq, mkRaw, mkTotal, tripleBoost }
}

function scoreAll(state) {
  const all = []
  for (let a = 1; a <= 6; a++) {
    for (let b = 1; b <= 6; b++) {
      for (let c = 1; c <= 6; c++) {
        all.push(scoreCombo(a, b, c, state.N, state.comboStats, state.sumLast, state.patLast, state.numCount, state.expectedNumFreq, state.mkRaw, state.mkTotal, state.tripleBoost))
      }
    }
  }
  all.sort((a, b) => b.rawScore - a.rawScore)
  return all
}

function predictRanked(data) {
  if (!data) data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
  if (!data || data.length < 2) return []
  const chron = data.every(r => r.ky != null)
    ? [...data].sort((a, b) => Number(a.ky) - Number(b.ky))
    : [...data]
  const state = buildState(chron)
  const all   = scoreAll(state)

  const capPat   = { triple: 2, pair: 4, normal: 4 }
  const countPat = { triple: 0, pair: 0, normal: 0 }
  const digitCnt = { 1:0, 2:0, 3:0, 4:0, 5:0, 6:0 }
  const top10 = []
  for (const r of all) {
    if (top10.length >= 10) break
    if (countPat[r.pat] >= capPat[r.pat]) continue
    const digits = [...new Set(r.k.split('-').map(Number))]
    if (digits.some(d => digitCnt[d] >= 2)) continue
    top10.push(r)
    countPat[r.pat]++
    digits.forEach(d => { digitCnt[d]++ })
  }
  const chosen = new Set(top10.map(r => r.k))
  for (const r of all) {
    if (top10.length >= 10) break
    if (!chosen.has(r.k)) { top10.push(r); chosen.add(r.k) }
  }
  top10.sort((a, b) => b.rawScore - a.rawScore)

  const totalScore = top10.reduce((s, r) => s + r.rawScore, 0) || 1
  return top10.map(r => ({
    combo:        r.k,
    score:        +r.rawScore.toFixed(4),
    pct:          +(r.rawScore / totalScore * 100).toFixed(1),
    comboGap:     r.comboGapRaw,
    overdueRatio: +(r.comboGapRaw / 216).toFixed(2),
    sumGap:       r.sumGapRaw,
    sumOD:        +r.c2.toFixed(2),
    sum:          r.sum,
    pat:          r.pat,
    stability:    +r.stability.toFixed(2),
  }))
}

function predictRankedAll(data) {
  if (!data) data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
  if (!data || data.length < 2) return []
  const chron = data.every(r => r.ky != null)
    ? [...data].sort((a, b) => Number(a.ky) - Number(b.ky))
    : [...data]
  const state = buildState(chron)
  return scoreAll(state).map(r => ({
    combo: r.k, score: r.rawScore, comboGap: r.comboGapRaw,
    overdueRatio: r.comboGapRaw / 216, sumGap: r.sumGapRaw,
    sumOD: r.c2, sum: r.sum, pat: r.pat,
  }))
}

function predict(data) {
  const ranked = predictRankedAll(data)
  const out = {}
  for (const r of ranked) out[r.combo] = r.score
  return out
}

predict.ranked = predictRanked
module.exports = predict
`

fs.writeFileSync(ensemblePath, code, 'utf8')
console.log('ensemble.js written successfully')
