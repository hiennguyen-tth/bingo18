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

const HISTORY_FILE  = path.join(__dirname, '../dataset/history.json')
const REPORT_FILE   = path.join(__dirname, 'report.json')
const BT_HIST_FILE  = path.join(__dirname, '../dataset/backtest_history.json')
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
    // Use predict.ranked() — same pipeline as production (diversity cap + triple boost)
    const ranked = predict.ranked(slice)
    if (!ranked || ranked.length === 0) continue

    const actual = `${data[i].n1}-${data[i].n2}-${data[i].n3}`
    const top = ranked.map(r => r.combo)

    if (top[0] === actual) top1Correct++
    if (top.slice(0, 3).some(c => c === actual)) top3Correct++
    if (top.slice(0, 10).some(c => c === actual)) top10Correct++
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

  // Append to backtest history — track accuracy over time as dataset grows.
  const btEntry = {
    ts: report.date,
    N: data.length,
    top1: +top1Acc.toFixed(4),
    top3: +top3Acc.toFixed(4),
    top10: +top10Acc.toFixed(4),
  }
  let btHistory = []
  try { btHistory = await fs.readJSON(BT_HIST_FILE) } catch (_) {}
  btHistory.push(btEntry)
  await fs.ensureFile(BT_HIST_FILE)
  await fs.writeJSON(BT_HIST_FILE, btHistory, { spaces: 2 })
  console.log(`   History appended   : dataset/backtest_history.json (${btHistory.length} entries)`)

  return report
}

runBacktest().catch(err => {
  console.error('[backtest] ERROR:', err.message)
  process.exit(1)
})
