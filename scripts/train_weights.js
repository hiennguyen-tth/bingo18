'use strict'
/**
 * scripts/train_weights.js
 * Walk-forward weight optimisation for the 4-model ensemble.
 *
 * Strategy — sigmod ensemble: score = sigmoid(wA·sA + wB·sB + wC·sC + wD·sD + wE·sE + bias)
 *   • Weights can be negative  → penalise noisy models
 *   • sC = 0 when session model inactive, sD = 0 when k-NN inactive → no issue
 *   • sE = 0 when Python GBM output (python/ml_output.json) absent or stale
 *   • For **ranking**, sigmoid is monotone ⇒ same as linear; benefit is the
 *     data-driven weight calibration (not the sigmoid nonlinearity itself)
 *
 * L2 regularisation: objective = top10_acc - λ·(wA²+wB²+wC²+wD²+wE²)
 *   • Prevents overfit to training set (extreme weights)
 *   • λ = 0.01 — small enough not to override accuracy signal
 *
 * Train / validation split:
 *   • Uses walk-forward: for each step i, train on draws 0..i-1, test on draw i
 *   • TRAIN window: steps [TRAIN_START .. VALID_START)  (sampled every STEP)
 *   • VALID window: steps [VALID_START .. N)             (all, no sampling)
 *
 * Search:
 *   • Phase 1: coarse grid  (fast — ~300 combinations × few hundred samples)
 *   • Phase 2: coordinate descent  (refine around best grid point)
 *
 * Output: dataset/model.json
 *
 * Usage:  node scripts/train_weights.js
 */

const path = require('path')
const fs = require('fs-extra')
const { getModelScores } = require('../predictor/ensemble')

const HISTORY_FILE = path.join(__dirname, '../dataset/history.json')
const WEIGHTS_FILE = path.join(__dirname, '../dataset/model.json')

const TRAIN_START = 50        // minimum draws before first prediction
const TRAIN_STEP = 2         // sample every Nth draw in training window (speed)
const VALID_RATIO = 0.25      // last 25% of steps = validation holdout

// ── sigmoid ───────────────────────────────────────────────────────────────
function sigmoid(x) { return 1 / (1 + Math.exp(-x)) }

const LAMBDA = 0.01   // L2 regularisation coefficient

// ── Scoring ──────────────────────────────────────────────────────

/** Top-10 hit rate with optional L2 regularisation. */
function hitRate(samples, wA, wB, wC, wD, wE, bias, lambda = 0) {
    let hits = 0
    for (const { perCombo, actual } of samples) {
        const scored = []
        for (const [combo, s] of Object.entries(perCombo)) {
            const { sA, sB, sC, sD, sE = 0 } = s
            scored.push({ combo, score: wA * sA + wB * sB + wC * sC + wD * sD + wE * sE + bias })
        }
        scored.sort((a, b) => b.score - a.score)
        if (scored.slice(0, 10).some(r => r.combo === actual)) hits++
    }
    const acc = samples.length ? hits / samples.length : 0
    const l2  = lambda * (wA ** 2 + wB ** 2 + wC ** 2 + wD ** 2 + wE ** 2)
    return acc - l2
}

// ── Pre-compute model scores ───────────────────────────────────────────────

async function precompute(chron, from, to, step) {
    const samples = []
    for (let i = from; i < to; i++) {
        if (step > 1 && (i - from) % step !== 0) continue
        const slice = chron.slice(0, i)
        const perCombo = getModelScores(slice)
        if (!perCombo || Object.keys(perCombo).length === 0) continue
        const actual = `${chron[i].n1}-${chron[i].n2}-${chron[i].n3}`
        samples.push({ perCombo, actual })
        if (process.stdout.isTTY && samples.length % 20 === 0) {
            process.stdout.write(`.`)
        }
    }
    return samples
}

// ── Phase 1: Coarse grid search ────────────────────────────────────────────

function coarseSearch(trainSamples) {
    const grid = {
        wA: [0.2, 0.35, 0.5, 0.65, 0.8],
        wB: [0.1, 0.2, 0.3, 0.4, 0.5],
        wC: [-0.1, 0.0, 0.1, 0.2],
        wD: [-0.1, 0.0, 0.1, 0.2],
        wE: [-0.1, 0.0, 0.1, 0.2],
        bias: [-0.5, -0.2, 0.0, 0.2, 0.5],
    }
    const total = grid.wA.length * grid.wB.length * grid.wC.length * grid.wD.length * grid.wE.length * grid.bias.length
    console.log(`  Grid: ${total} combinations...`)

    let best = { acc: 0, wA: 0.4, wB: 0.25, wC: 0.15, wD: 0.2, wE: 0, bias: 0 }

    for (const wA of grid.wA)
        for (const wB of grid.wB)
            for (const wC of grid.wC)
                for (const wD of grid.wD)
                    for (const wE of grid.wE)
                        for (const bias of grid.bias) {
                            const acc = hitRate(trainSamples, wA, wB, wC, wD, wE, bias, LAMBDA)
                            if (acc > best.acc) best = { acc, wA, wB, wC, wD, wE, bias }
                        }
    return best
}

// ── Phase 2: Coordinate descent (refine) ──────────────────────────────────

function coordinateDescent(trainSamples, init) {
    let best = { ...init }
    const PARAMS = ['wA', 'wB', 'wC', 'wD', 'wE', 'bias']
    const STEPS = [0.05, 0.02, 0.01]

    for (const step of STEPS) {
        let improved = true
        while (improved) {
            improved = false
            for (const param of PARAMS) {
                for (const delta of [-step, step]) {
                    const candidate = { ...best, [param]: +(best[param] + delta).toFixed(4) }
                    const acc = hitRate(trainSamples,
                        candidate.wA, candidate.wB, candidate.wC, candidate.wD, candidate.wE, candidate.bias, LAMBDA)
                    if (acc > best.acc) { best = { ...candidate, acc }; improved = true }
                }
            }
        }
    }
    return best
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
    const data = await fs.readJSON(HISTORY_FILE)
    const chron = [...data].sort((a, b) => Number(a.ky) - Number(b.ky))
    const N = chron.length

    console.log(`[train_weights] Dataset: ${N} draws (chronological)`)

    if (N < TRAIN_START + 30) {
        console.error(`[train_weights] ERROR: need at least ${TRAIN_START + 30} draws, got ${N}`)
        process.exit(1)
    }

    const validStart = Math.max(TRAIN_START + 50, Math.floor(N * (1 - VALID_RATIO)))

    console.log(`[train_weights] TRAIN: steps ${TRAIN_START}..${validStart - 1}  (every ${TRAIN_STEP}nd)`)
    console.log(`[train_weights] VALID: steps ${validStart}..${N - 1}`)

    // ── Pre-compute ───────────────────────────────────────────────────────────
    process.stdout.write('[train_weights] Pre-computing train scores')
    const trainSamples = await precompute(chron, TRAIN_START, validStart, TRAIN_STEP)
    console.log(`  ${trainSamples.length} samples`)

    process.stdout.write('[train_weights] Pre-computing valid scores')
    const validSamples = await precompute(chron, validStart, N, 1)
    console.log(`  ${validSamples.length} samples`)

    if (trainSamples.length < 20) {
        console.error('[train_weights] Too few training samples — crawl more data first.')
        process.exit(1)
    }

    // ── Fixed baseline ─────────────────────────────────────────────────────────
    // Note: raw accuracy (lambda=0) used as baseline — applies L2 only during search.
    const fixedTrainAcc = hitRate(trainSamples, 0.40, 0.25, 0.15, 0.20, 0, 0, 0)
    const fixedValidAcc = validSamples.length ? hitRate(validSamples, 0.40, 0.25, 0.15, 0.20, 0, 0, 0) : null
    console.log(`\n[train_weights] FIXED  weights train acc: ${(fixedTrainAcc * 100).toFixed(2)}%`)
    if (fixedValidAcc !== null)
        console.log(`[train_weights] FIXED  weights valid acc: ${(fixedValidAcc * 100).toFixed(2)}%`)

    // ── Phase 1: Grid search ────────────────────────────────────────────────
    console.log('\n[train_weights] Phase 1: Coarse grid search...')
    const coarseBest = coarseSearch(trainSamples)
    console.log(`  Best: wA=${coarseBest.wA} wB=${coarseBest.wB} wC=${coarseBest.wC} wD=${coarseBest.wD} wE=${coarseBest.wE} bias=${coarseBest.bias}  train=${(coarseBest.acc * 100).toFixed(2)}%`)

    // ── Phase 2: Coordinate descent ────────────────────────────────
    console.log('[train_weights] Phase 2: Coordinate descent...')
    const refined = coordinateDescent(trainSamples, coarseBest)
    console.log(`  Best: wA=${refined.wA} wB=${refined.wB} wC=${refined.wC} wD=${refined.wD} wE=${refined.wE} bias=${refined.bias}  train=${(refined.acc * 100).toFixed(2)}%`)

    // ── Validation ───────────────────────────────────────────────
    // Use lambda=0 for validation comparison (unpenalised accuracy)
    const learnedValidAcc = validSamples.length
        ? hitRate(validSamples, refined.wA, refined.wB, refined.wC, refined.wD, refined.wE, refined.bias, 0)
        : null

    console.log('\n[train_weights] ─────── VERDICT ───────')
    console.log(`  TRAIN  fixed: ${(fixedTrainAcc * 100).toFixed(2)}%  learned: ${(refined.acc * 100).toFixed(2)}%`)
    if (learnedValidAcc !== null && fixedValidAcc !== null) {
        const delta = ((learnedValidAcc - fixedValidAcc) * 100).toFixed(2)
        const better = learnedValidAcc >= fixedValidAcc
        console.log(`  VALID  fixed: ${(fixedValidAcc * 100).toFixed(2)}%  learned: ${(learnedValidAcc * 100).toFixed(2)}%  (${delta > 0 ? '+' : ''}${delta}pp)`)
        console.log(`  Result: ${better ? '✅ Learned weights saved — ensemble will use sigmoid' : '⚠️  No valid improvement — fixed weights remain better'}`)
    }

    // ── Save (always write; ensemble picks up if valid_acc >= fixed_acc) ──────
    const improves = learnedValidAcc !== null ? learnedValidAcc >= fixedValidAcc : true

    const output = {
        trainedAt: new Date().toISOString(),
        trainSamples: trainSamples.length,
        validSamples: validSamples.length,
        wA: refined.wA,
        wB: refined.wB,
        wC: refined.wC,
        wD: refined.wD,
        wE: refined.wE,
        bias: refined.bias,
        lambda: LAMBDA,
        trainTop10Acc: +refined.acc.toFixed(4),
        fixedTrainAcc: +fixedTrainAcc.toFixed(4),
        fixedValidAcc: fixedValidAcc !== null ? +fixedValidAcc.toFixed(4) : null,
        learnedValidAcc: learnedValidAcc !== null ? +learnedValidAcc.toFixed(4) : null,
        // Flag for ensemble.js — if false it will fall back to fixed weights
        improvesValid: improves,
    }

    await fs.ensureFile(WEIGHTS_FILE)
    await fs.writeJSON(WEIGHTS_FILE, output, { spaces: 2 })
    console.log(`[train_weights] Saved → ${WEIGHTS_FILE}`)
}

main().catch(err => {
    console.error('[train_weights] ERROR:', err.message)
    process.exit(1)
})
