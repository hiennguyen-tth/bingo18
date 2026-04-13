'use strict'
/**
 * backtest/run_backtest.js
 * Walk-forward backtest: for each record i >= WINDOW, train on
 * data[0..i-1] and check if the ensemble's top-1 or top-3 prediction
 * matches data[i].
 *
 * Usage:  node backtest/run_backtest.js
 */
const path = require('path')
const fs = require('fs-extra')
const predict = require('../predictor/ensemble')

const HISTORY_FILE = path.join(__dirname, '../dataset/history.json')
const REPORT_FILE = path.join(__dirname, 'report.json')
const WINDOW = 10        // minimum records needed before first prediction

async function runBacktest() {
  const data = await fs.readJSON(HISTORY_FILE).catch(() => [])

  if (data.length < WINDOW + 1) {
    console.error(`[backtest] Need at least ${WINDOW + 1} records, got ${data.length}.`)
    console.error('           Run: node crawler/crawl.js')
    process.exit(1)
  }

  let top1Correct = 0
  let top3Correct = 0
  let top10Correct = 0
  const tested = data.length - WINDOW

  for (let i = WINDOW; i < data.length; i++) {
    const slice = data.slice(0, i)
    const scores = predict(slice)

    if (Object.keys(scores).length === 0) continue

    const actual = `${data[i].n1}-${data[i].n2}-${data[i].n3}`
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1])

    if (sorted[0]?.[0] === actual) top1Correct++
    if (sorted.slice(0, 3).some(([k]) => k === actual)) top3Correct++
    if (sorted.slice(0, 10).some(([k]) => k === actual)) top10Correct++
  }

  const top1Acc = tested > 0 ? top1Correct / tested : 0
  const top3Acc = tested > 0 ? top3Correct / tested : 0
  const top10Acc = tested > 0 ? top10Correct / tested : 0

  const RANDOM = { top1: 1 / 216, top3: 3 / 216, top10: 10 / 216 }

  console.log('── Backtest Results ──────────────────────')
  console.log(`   Records in dataset : ${data.length}`)
  console.log(`   Rounds tested      : ${tested}`)
  console.log(`   Top-1  accuracy    : ${(top1Acc * 100).toFixed(2)}%  (${top1Correct}/${tested})  baseline=${(RANDOM.top1 * 100).toFixed(2)}%`)
  console.log(`   Top-3  accuracy    : ${(top3Acc * 100).toFixed(2)}%  (${top3Correct}/${tested})  baseline=${(RANDOM.top3 * 100).toFixed(2)}%`)
  console.log(`   Top-10 accuracy    : ${(top10Acc * 100).toFixed(2)}%  (${top10Correct}/${tested})  baseline=${(RANDOM.top10 * 100).toFixed(2)}%`)
  console.log('─────────────────────────────────────────')

  const report = {
    date: new Date().toISOString(),
    totalRecords: data.length,
    window: WINDOW,
    tested,
    top1Correct,
    top3Correct,
    top10Correct,
    top1Accuracy: +top1Acc.toFixed(4),
    top3Accuracy: +top3Acc.toFixed(4),
    top10Accuracy: +top10Acc.toFixed(4),
    baseline: {
      top1: +(RANDOM.top1 * 100).toFixed(2),
      top3: +(RANDOM.top3 * 100).toFixed(2),
      top10: +(RANDOM.top10 * 100).toFixed(2),
    },
  }

  await fs.ensureFile(REPORT_FILE)
  await fs.writeJSON(REPORT_FILE, report, { spaces: 2 })
  console.log(`   Report saved       : backtest/report.json`)

  return report
}

runBacktest().catch(err => {
  console.error('[backtest] ERROR:', err.message)
  process.exit(1)
})
