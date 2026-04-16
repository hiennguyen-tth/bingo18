'use strict'
/**
 * scripts/experiments.js
 * 4 micro-experiments to find where signal (if any) lives in Bingo18 data.
 *
 * Experiment 1: Autocorrelation on SUM at various lags (1,2,3,6,10,12,20)
 * Experiment 2: Chi-square by time slot (per-hour sum distribution)
 * Experiment 3: Runs test on pattern type (triple/not-triple clustering)
 * Experiment 4: Markov-1 transition chi-square on sum (16×16 matrix)
 *
 * Usage:  node scripts/experiments.js
 */
const fs = require('fs-extra')
const path = require('path')

const HISTORY_FILE = path.join(__dirname, '../dataset/history.json')
const REPORT_FILE = path.join(__dirname, '../backtest/experiments_report.json')

// ── Statistical helpers ────────────────────────────────────────────────────

function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d2 = 0.3989423 * Math.exp(-z * z / 2)
  const p = d2 * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? 1 - p : p
}

function chiSquarePValueApprox(chiStat, df) {
  // Wilson-Hilferty approximation
  if (df <= 0) return 1
  const z = Math.pow(chiStat / df, 1 / 3) - (1 - 2 / (9 * df))
  const se = Math.sqrt(2 / (9 * df))
  return 1 - normalCDF(z / se)
}

// ── Experiment 1: Autocorrelation on SUM ──────────────────────────────────

function experiment1_autocorr(chron) {
  console.log('\n═══ Experiment 1: Autocorrelation on SUM ═══')
  const sums = chron.map(r => r.sum || (r.n1 + r.n2 + r.n3))
  const N = sums.length
  const mean = sums.reduce((a, b) => a + b, 0) / N
  const variance = sums.reduce((a, b) => a + (b - mean) ** 2, 0) / N

  const lags = [1, 2, 3, 6, 10, 12, 20, 30, 50, 100]
  const results = []

  for (const lag of lags) {
    if (lag >= N) continue
    let cov = 0
    for (let i = lag; i < N; i++) {
      cov += (sums[i] - mean) * (sums[i - lag] - mean)
    }
    cov /= (N - lag)
    const r = variance > 0 ? cov / variance : 0
    const se = 1 / Math.sqrt(N - lag)
    const z = r / se
    const pValue = 2 * (1 - normalCDF(Math.abs(z)))
    const significant = pValue < 0.05
    results.push({ lag, r: +r.toFixed(6), z: +z.toFixed(3), pValue: +pValue.toFixed(4), significant })
    const marker = significant ? '*** p<0.05' : ''
    console.log(`   lag=${lag.toString().padStart(3)}  r=${r.toFixed(4).padStart(8)}  z=${z.toFixed(2).padStart(7)}  p=${pValue.toFixed(4)}  ${marker}`)
  }

  const anySig = results.some(r => r.significant)
  console.log(`   → ${anySig ? 'SIGNAL: autocorrelation detected at some lag(s)' : 'No significant autocorrelation at any tested lag'}`)
  return { name: 'autocorr_sum', results, anySig }
}

// ── Experiment 2: Chi-square by time slot ─────────────────────────────────

function experiment2_chiByHour(chron) {
  console.log('\n═══ Experiment 2: Chi-square by TIME SLOT ═══')
  // Group draws by hour, test if sum distribution in each hour differs from overall
  const byHour = {}
  for (const r of chron) {
    if (!r.drawTime) continue
    const h = parseInt(r.drawTime.match(/T(\d{2})/)?.[1] || '12', 10)
    if (!byHour[h]) byHour[h] = []
    byHour[h].push(r.sum || (r.n1 + r.n2 + r.n3))
  }

  // Theoretical expected distribution of sums
  const SUM_COUNT = {
    3: 1, 4: 3, 5: 6, 6: 10, 7: 15, 8: 21,
    9: 25, 10: 27, 11: 27, 12: 25, 13: 21, 14: 15,
    15: 10, 16: 6, 17: 3, 18: 1,
  }

  const results = []
  const hours = Object.keys(byHour).map(Number).sort((a, b) => a - b)

  for (const h of hours) {
    const sums = byHour[h]
    const N = sums.length
    if (N < 50) continue

    // Observed count per sum
    const obs = {}
    for (const s of sums) obs[s] = (obs[s] || 0) + 1

    // Chi-square test vs theoretical
    let chiStat = 0
    const df = 15  // 16 sum values - 1
    for (let s = 3; s <= 18; s++) {
      const expected = N * SUM_COUNT[s] / 216
      const observed = obs[s] || 0
      if (expected > 0) {
        chiStat += (observed - expected) ** 2 / expected
      }
    }

    const pValue = chiSquarePValueApprox(chiStat, df)
    const significant = pValue < 0.05
    results.push({ hour: h, n: N, chiStat: +chiStat.toFixed(2), df, pValue: +pValue.toFixed(4), significant })
    const marker = significant ? '*** p<0.05' : ''
    console.log(`   hour=${h.toString().padStart(2)}:00  n=${N.toString().padStart(5)}  χ²=${chiStat.toFixed(1).padStart(7)}  df=${df}  p=${pValue.toFixed(4)}  ${marker}`)
  }

  const anySig = results.some(r => r.significant)
  console.log(`   → ${anySig ? 'SIGNAL: some hours have non-uniform sum distribution' : 'No hour shows significant deviation from theoretical sum distribution'}`)
  return { name: 'chi_by_hour', results, anySig }
}

// ── Experiment 3: Runs test on pattern type ───────────────────────────────

function experiment3_runsPattern(chron) {
  console.log('\n═══ Experiment 3: Runs test on PATTERN TYPE ═══')
  // Binary sequence: 1=triple, 0=not-triple
  const seq = chron.map(r => {
    const pat = r.pattern || (r.n1 === r.n2 && r.n2 === r.n3 ? 'triple' : 'other')
    return pat === 'triple' ? 1 : 0
  })

  const N = seq.length
  const n1 = seq.filter(x => x === 1).length  // number of triples
  const n0 = N - n1

  console.log(`   Total draws: ${N}`)
  console.log(`   Triples: ${n1} (${(n1 / N * 100).toFixed(2)}%), theoretical: 2.78%`)
  console.log(`   Non-triples: ${n0}`)

  // Count runs
  let runs = 1
  for (let i = 1; i < N; i++) {
    if (seq[i] !== seq[i - 1]) runs++
  }

  // Expected runs and variance under H0 (random ordering)
  const E_runs = 1 + 2 * n1 * n0 / N
  const V_runs = n1 > 0 && n0 > 0 && N > 1
    ? (2 * n1 * n0 * (2 * n1 * n0 - N)) / (N * N * (N - 1))
    : 0
  const se = Math.sqrt(V_runs)
  const z = se > 0 ? (runs - E_runs) / se : 0
  const pValue = 2 * (1 - normalCDF(Math.abs(z)))
  const significant = pValue < 0.05

  console.log(`   Observed runs: ${runs}`)
  console.log(`   Expected runs: ${E_runs.toFixed(1)}`)
  console.log(`   z=${z.toFixed(3)}  p=${pValue.toFixed(4)}  ${significant ? '*** SIGNIFICANT — triples are clustered' : 'ns — triples appear randomly'}`)

  // Also test pair/not-pair
  const seqPair = chron.map(r => {
    if (r.n1 === r.n2 && r.n2 === r.n3) return 'triple'
    if (r.n1 === r.n2 || r.n2 === r.n3 || r.n1 === r.n3) return 'pair'
    return 'normal'
  })
  const pairCount = seqPair.filter(x => x === 'pair').length
  const tripleCount = seqPair.filter(x => x === 'triple').length
  const normalCount = seqPair.filter(x => x === 'normal').length
  const theorPair = (90 / 216 * 100).toFixed(2)  // 90 pair combos out of 216
  const theorTriple = (6 / 216 * 100).toFixed(2)
  const theorNormal = (120 / 216 * 100).toFixed(2)

  console.log(`\n   Pattern distribution:`)
  console.log(`     Triple:  ${tripleCount} (${(tripleCount / N * 100).toFixed(2)}%, theory: ${theorTriple}%)`)
  console.log(`     Pair:    ${pairCount} (${(pairCount / N * 100).toFixed(2)}%, theory: ${theorPair}%)`)
  console.log(`     Normal:  ${normalCount} (${(normalCount / N * 100).toFixed(2)}%, theory: ${theorNormal}%)`)

  return {
    name: 'runs_pattern',
    result: { runs, E_runs: +E_runs.toFixed(1), z: +z.toFixed(3), pValue: +pValue.toFixed(4), significant },
    tripleRate: +(tripleCount / N).toFixed(4),
    pairRate: +(pairCount / N).toFixed(4),
    anySig: significant,
  }
}

// ── Experiment 4: Markov-1 transition chi-square on sum ───────────────────

function experiment4_markovSum(chron) {
  console.log('\n═══ Experiment 4: Markov-1 SUM transition chi-square ═══')
  const sums = chron.map(r => r.sum || (r.n1 + r.n2 + r.n3))
  const N = sums.length

  // Build 16×16 transition matrix
  const trans = {}
  const rowTotal = {}
  for (let i = 1; i < N; i++) {
    const from = sums[i - 1]
    const to = sums[i]
    const k = `${from}->${to}`
    trans[k] = (trans[k] || 0) + 1
    rowTotal[from] = (rowTotal[from] || 0) + 1
  }

  // Theoretical destination distribution (marginal P(sum=s))
  const SUM_COUNT = {
    3: 1, 4: 3, 5: 6, 6: 10, 7: 15, 8: 21,
    9: 25, 10: 27, 11: 27, 12: 25, 13: 21, 14: 15,
    15: 10, 16: 6, 17: 3, 18: 1,
  }

  // Chi-square: for each row (prev sum), test if transitions match marginal distribution
  let totalChi = 0
  let totalDf = 0
  const rowResults = []

  for (let from = 3; from <= 18; from++) {
    const rTotal = rowTotal[from] || 0
    if (rTotal < 30) continue  // skip rows with too few observations

    let chiRow = 0
    for (let to = 3; to <= 18; to++) {
      const observed = trans[`${from}->${to}`] || 0
      const expected = rTotal * SUM_COUNT[to] / 216
      if (expected > 0) {
        chiRow += (observed - expected) ** 2 / expected
      }
    }
    const df = 15
    const pRow = chiSquarePValueApprox(chiRow, df)
    totalChi += chiRow
    totalDf += df
    rowResults.push({ from, n: rTotal, chiStat: +chiRow.toFixed(2), df, pValue: +pRow.toFixed(4), significant: pRow < 0.05 })

    const marker = pRow < 0.05 ? '***' : ''
    console.log(`   sum=${from.toString().padStart(2)} → χ²=${chiRow.toFixed(1).padStart(7)}  n=${rTotal.toString().padStart(5)}  p=${pRow.toFixed(4)}  ${marker}`)
  }

  // Overall chi-square (pooled)
  const overallP = chiSquarePValueApprox(totalChi, totalDf)
  const anySig = rowResults.some(r => r.significant)
  const sigRows = rowResults.filter(r => r.significant)

  console.log(`\n   Overall pooled: χ²=${totalChi.toFixed(1)}  df=${totalDf}  p=${overallP.toFixed(4)}  ${overallP < 0.05 ? '*** SIGNIFICANT' : 'ns'}`)
  console.log(`   Rows with p<0.05: ${sigRows.length}/${rowResults.length}`)
  if (sigRows.length > 0) {
    console.log(`   → SIGNAL: Some sum transitions deviate from independent distribution`)
    console.log(`     Significant departures at sum = ${sigRows.map(r => r.from).join(', ')}`)
  } else {
    console.log(`   → No individual row shows significant Markov dependency`)
  }

  return {
    name: 'markov1_sum',
    rowResults,
    overall: { chiStat: +totalChi.toFixed(1), df: totalDf, pValue: +overallP.toFixed(4), significant: overallP < 0.05 },
    anySig: anySig || overallP < 0.05,
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const data = await fs.readJSON(HISTORY_FILE).catch(() => [])
  const chron = [...data].sort((a, b) => Number(a.ky) - Number(b.ky))

  console.log('══════════════════════════════════════════════')
  console.log('   P1 MICRO-EXPERIMENTS — Bingo18 Signal Hunt')
  console.log(`   Dataset: ${chron.length} records`)
  console.log('══════════════════════════════════════════════')

  const exp1 = experiment1_autocorr(chron)
  const exp2 = experiment2_chiByHour(chron)
  const exp3 = experiment3_runsPattern(chron)
  const exp4 = experiment4_markovSum(chron)

  // Summary
  console.log('\n══════════════════════════════════════════════')
  console.log('   SUMMARY')
  console.log('══════════════════════════════════════════════')
  const exps = [exp1, exp2, exp3, exp4]
  for (const e of exps) {
    console.log(`   ${e.name}: ${e.anySig ? '✅ SIGNAL DETECTED' : '❌ No significant signal'}`)
  }

  const anySignal = exps.some(e => e.anySig)
  console.log()
  if (anySignal) {
    console.log('   🔍 Signal found in at least one experiment!')
    console.log('   → Proceed to P2: adjust pipeline to exploit detected patterns')
  } else {
    console.log('   ⚪ No signal detected in any experiment')
    console.log('   → Data appears IID random. Focus on accumulating more data (P3)')
  }

  // Save report
  const report = {
    date: new Date().toISOString(),
    totalRecords: chron.length,
    experiments: { exp1, exp2, exp3, exp4 },
    anySignal,
  }
  await fs.ensureFile(REPORT_FILE)
  await fs.writeJSON(REPORT_FILE, report, { spaces: 2 })
  console.log(`\n   Report saved: ${REPORT_FILE}`)
}

main().catch(err => {
  console.error('[experiments] ERROR:', err.message)
  process.exit(1)
})
