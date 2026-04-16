'use strict'
/**
 * backtest/run_backtest_sum.js
 * Walk-forward backtest for sum-level prediction (16 outcomes).
 *
 * Usage:
 *   node backtest/run_backtest_sum.js                    # full model
 *   node backtest/run_backtest_sum.js --model zscore-only
 *   node backtest/run_backtest_sum.js --model markov-only
 *   node backtest/run_backtest_sum.js --model session-only
 *
 * Ablation experiments (P0): each mode uses only one signal component, letting
 * you identify which signal drives any observed accuracy above baseline.
 * If zscore-only is significant → artifact of unequal sum distribution (sum=10>sum=3).
 * If markov-only is significant → there are real transition patterns in the data.
 * If session-only is significant → time-of-day matters for sum patterns.
 */
const path = require('path')
const fs = require('fs-extra')
const predict = require('../predictor/ensemble')

const HISTORY_FILE = path.join(__dirname, '../dataset/history.json')
const REPORT_FILE = path.join(__dirname, 'report_sum.json')
const WINDOW = 50  // minimum records before first sum prediction

// ── CLI flags ────────────────────────────────────────────────────────────
const VALID_MODELS = ['full', 'zscore-only', 'markov-only', 'session-only']
const modelArg = (() => {
  const idx = process.argv.indexOf('--model')
  if (idx >= 0 && process.argv[idx + 1]) {
    const m = process.argv[idx + 1]
    if (!VALID_MODELS.includes(m)) {
      console.error(`[backtest-sum] Unknown --model "${m}". Valid: ${VALID_MODELS.join(', ')}`)
      process.exit(1)
    }
    return m
  }
  return 'full'
})()
const sumOpts = { model: modelArg }  // passed to predict.predictSum()

async function runBacktestSum() {
    const data = await fs.readJSON(HISTORY_FILE).catch(() => [])
    const chron = [...data].sort((a, b) => Number(a.ky) - Number(b.ky))

    if (chron.length < WINDOW + 1) {
        console.error(`[backtest-sum] Need at least ${WINDOW + 1} records, got ${chron.length}.`)
        process.exit(1)
    }

    let top1Hit = 0, top3Hit = 0, top5Hit = 0
    const N = chron.length

    // Sample every Kth record to keep runtime manageable (target ~500 test windows)
    const SAMPLE_EVERY = Math.max(1, Math.floor(N / 500))
    // Start from 30% mark — early windows have too little data for Markov
    const START_I = Math.max(WINDOW, Math.floor(N * 0.3))
    let tested = 0

    console.log('── Backtest Sum Prediction ──────────────────')
    console.log(`   Model mode        : ${modelArg.toUpperCase()}`)
    console.log(`   Dataset          : ${N} records`)
    console.log(`   Start index      : ${START_I} (30% of dataset)`)
    console.log(`   Sample every     : ${SAMPLE_EVERY}`)
    console.log(`   Estimated tests  : ~${Math.floor((N - START_I) / SAMPLE_EVERY)}`)
    console.log('')

    const t0 = Date.now()
    for (let i = START_I; i < N; i += SAMPLE_EVERY) {
        const slice = chron.slice(0, i)
        const result = predict.predictSum(slice, sumOpts)
        if (!result || !result.sums || result.sums.length === 0) continue

        const actualSum = chron[i].sum || (chron[i].n1 + chron[i].n2 + chron[i].n3)
        const predSums = result.sums.map(s => s.sum)

        if (predSums[0] === actualSum) top1Hit++
        if (predSums.slice(0, 3).some(s => s === actualSum)) top3Hit++
        if (predSums.slice(0, 5).some(s => s === actualSum)) top5Hit++
        tested++

        if (tested % 100 === 0) {
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
            process.stdout.write(`\r   Progress: ${tested} tested (${elapsed}s)...`)
        }
    }
    process.stdout.write('\n')

    const RANDOM = { top1: 1 / 16, top3: 3 / 16, top5: 5 / 16 }
    const top1Acc = tested > 0 ? top1Hit / tested : 0
    const top3Acc = tested > 0 ? top3Hit / tested : 0
    const top5Acc = tested > 0 ? top5Hit / tested : 0

    // Binomial test (normal approximation): z = (obs - expected) / sqrt(p*(1-p)/n)
    function binomialPValue(observed, expected, n) {
        if (n === 0) return 1
        const se = Math.sqrt(expected * (1 - expected) / n)
        if (se === 0) return 1
        const z = (observed - expected) / se
        // Two-tailed p-value using normal approximation
        function normCDF(z) {
            const t = 1 / (1 + 0.2316419 * Math.abs(z))
            const d2 = 0.3989423 * Math.exp(-z * z / 2)
            const p = d2 * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
            return z > 0 ? 1 - p : p
        }
        return 2 * (1 - normCDF(Math.abs(z)))
    }

    const pTop1 = binomialPValue(top1Acc, RANDOM.top1, tested)
    const pTop3 = binomialPValue(top3Acc, RANDOM.top3, tested)
    const pTop5 = binomialPValue(top5Acc, RANDOM.top5, tested)

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    console.log('── Results ──────────────────────────────────')
    console.log(`   Time elapsed      : ${elapsed}s`)
    console.log(`   Rounds tested     : ${tested}`)
    console.log(`   Sample every      : ${SAMPLE_EVERY}`)
    console.log()
    console.log(`   Top-1 hit rate    : ${(top1Acc * 100).toFixed(2)}%  (${top1Hit}/${tested})  baseline=${(RANDOM.top1 * 100).toFixed(2)}%  p=${pTop1.toFixed(4)}  ${pTop1 < 0.05 ? '*** SIGNIFICANT' : 'ns'}`)
    console.log(`   Top-3 hit rate    : ${(top3Acc * 100).toFixed(2)}%  (${top3Hit}/${tested})  baseline=${(RANDOM.top3 * 100).toFixed(2)}%  p=${pTop3.toFixed(4)}  ${pTop3 < 0.05 ? '*** SIGNIFICANT' : 'ns'}`)
    console.log(`   Top-5 hit rate    : ${(top5Acc * 100).toFixed(2)}%  (${top5Hit}/${tested})  baseline=${(RANDOM.top5 * 100).toFixed(2)}%  p=${pTop5.toFixed(4)}  ${pTop5 < 0.05 ? '*** SIGNIFICANT' : 'ns'}`)
    console.log()

    // Interpretation
    if (pTop1 < 0.05 && top1Acc > RANDOM.top1) {
        console.log('   📊 CONCLUSION: Sum-level signal DETECTED (p < 0.05)')
        console.log('      → Focus on sum-level prediction; signal exists here')
    } else if (top1Acc > RANDOM.top1 && pTop1 < 0.20) {
        console.log('   📊 CONCLUSION: Weak signal at sum level (p < 0.20 but > 0.05)')
        console.log('      → Need more data to confirm; wait for 5-10k more draws')
    } else {
        console.log('   📊 CONCLUSION: No signal at sum level (random performance)')
        console.log('      → Move to P1 disaggregate experiments')
    }

    console.log('─────────────────────────────────────────────')

    const report = {
        date: new Date().toISOString(),
        model: modelArg,
        totalRecords: N,
        window: WINDOW,
        startIndex: START_I,
        sampleEvery: SAMPLE_EVERY,
        tested,
        top1Hit,
        top3Hit,
        top5Hit,
        accuracy: {
            top1: +top1Acc.toFixed(4),
            top3: +top3Acc.toFixed(4),
            top5: +top5Acc.toFixed(4),
        },
        pValues: {
            top1: +pTop1.toFixed(4),
            top3: +pTop3.toFixed(4),
            top5: +pTop5.toFixed(4),
        },
        baseline: {
            top1: +(RANDOM.top1 * 100).toFixed(2),
            top3: +(RANDOM.top3 * 100).toFixed(2),
            top5: +(RANDOM.top5 * 100).toFixed(2),
        },
    }

    await fs.ensureFile(REPORT_FILE)
    await fs.writeJSON(REPORT_FILE, report, { spaces: 2 })
    console.log(`   Report saved: ${REPORT_FILE}`)

    return report
}

runBacktestSum().catch(err => {
    console.error('[backtest-sum] ERROR:', err.message)
    process.exit(1)
})
