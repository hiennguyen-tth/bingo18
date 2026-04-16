/**
 * Markov Reality Check — 7 experiments to determine whether the Markov-1 predictor
 * has genuine temporal signal or is only capturing the marginal frequency distribution.
 *
 * E1 — Baseline Accuracy: compare Markov, Always-top-K, and uniform-random.
 * E2 — Shuffle Test: if shuffling training order preserves accuracy → no temporal signal.
 * E3 — Conditional vs Marginal: measure how much P(next|prev) differs from P(next).
 * E4 — Mutual Information I(X_{t-1}; X_t).
 * E5 — KL Divergence of each row from the marginal.
 * E6 — Adversarial Dataset: Markov must detect biased synthetic data, fail on IID.
 * E7 — Base-rate Normalised: divide Markov score by marginal P(s) then run backtest.
 */
'use strict'

const fs = require('fs')
const path = require('path')

const DATASET_PATH = path.join(__dirname, '../dataset/history.json')
const DATA = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'))

// Each record has: { ky, drawTime, d1, d2, d3, sum }
// "sum" here is d1+d2+d3 (3..18), 16 distinct values.
const MIN_SUM = 3, MAX_SUM = 18
const NUM_SUMS = MAX_SUM - MIN_SUM + 1  // 16

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function getSum(r) {
    return Number(r.sum)
}

/** Chronological order (oldest → newest) */
function chronOrder(arr) {
    return [...arr].sort((a, b) => Number(a.ky) - Number(b.ky))
}

/** Build Markov-1 transition counts from a slice.  Returns matrix[prev][cur]. */
function buildTransitionCounts(slice) {
    const mk = {}
    for (let i = 1; i < slice.length; i++) {
        const prev = getSum(slice[i - 1])
        const cur = getSum(slice[i])
        if (!mk[prev]) mk[prev] = {}
        mk[prev][cur] = (mk[prev][cur] || 0) + 1
    }
    return mk
}

/** Build marginal probability (smoothed) from a slice.  Returns array[16]. */
function buildMarginal(slice, alpha = 0.5) {
    const counts = new Array(NUM_SUMS).fill(0)
    for (const r of slice) counts[getSum(r) - MIN_SUM]++
    const total = slice.length
    return counts.map(c => (c + alpha) / (total + alpha * NUM_SUMS))
}

/** Markov probability for next sum s given prev, with Laplace smoothing. */
function markovProb(mk, marginal, prev, s, alpha = 0.5) {
    const row = mk[prev] || {}
    const rowTotal = Object.values(row).reduce((a, v) => a + v, 0)
    if (rowTotal === 0) return marginal[s - MIN_SUM]
    return ((row[s] || 0) + alpha) / (rowTotal + alpha * NUM_SUMS)
}

/** Indices of top-K values in array (descending). */
function topK(arr, k) {
    return arr
        .map((v, i) => [v, i])
        .sort((a, b) => b[0] - a[0])
        .slice(0, k)
        .map(([, i]) => i)
}

/** Log-loss (nats).  prob is the model probability assigned to the true outcome. */
function logLoss(probs) {
    return -probs.reduce((s, p) => s + Math.log(Math.max(p, 1e-12)), 0) / probs.length
}

// ------------------------------------------------------------------
// Evaluation — build model on training split, evaluate on test split
// ------------------------------------------------------------------

/**
 * Simple train/test evaluation.
 * predictor(mk, marg, prev) → Array[NUM_SUMS] of probabilities.
 */
function evaluate(chron, trainFrac, buildModel, predict) {
    const split = Math.floor(chron.length * trainFrac)
    if (split < 2 || chron.length - split < 2) return { top1: 0, top3: 0, ll: 0 }
    const trainSlice = chron.slice(0, split)
    const testSlice = chron.slice(split)
    const model = buildModel(trainSlice)

    let hit1 = 0, hit3 = 0
    const lls = []
    for (let i = 1; i < testSlice.length; i++) {
        const prev = getSum(testSlice[i - 1])
        const actual = getSum(testSlice[i])
        const probs = predict(model, prev)
        const top1Idx = topK(probs, 1)[0]
        const top3Idx = topK(probs, 3)
        if (top1Idx + MIN_SUM === actual) hit1++
        if (top3Idx.some(idx => idx + MIN_SUM === actual)) hit3++
        lls.push(probs[actual - MIN_SUM])
    }
    const n = testSlice.length - 1
    return { top1: hit1 / n, top3: hit3 / n, ll: logLoss(lls) }
}

// ------------------------------------------------------------------
// E1 — Baseline Accuracy
// ------------------------------------------------------------------

function buildMarkovModel(slice) {
    return { mk: buildTransitionCounts(slice), marg: buildMarginal(slice) }
}

function predictMarkov({ mk, marg }, prev) {
    return Array.from({ length: NUM_SUMS }, (_, i) => markovProb(mk, marg, prev, i + MIN_SUM))
}

function predictMarginal({ marg }) {
    return marg.slice()
}

function predictUniform() {
    // Add tiny random jitter so tie-breaking is random (not always sum 3).
    return Array.from({ length: NUM_SUMS }, () => 1 / NUM_SUMS + Math.random() * 1e-10)
}

function e1_baseline(chron) {
    const FRAC = 0.8
    const unifResult = evaluate(chron, FRAC, buildMarkovModel, () => predictUniform())
    const margResult = evaluate(chron, FRAC, buildMarkovModel, (m) => predictMarginal(m))
    const mkResult = evaluate(chron, FRAC, buildMarkovModel, predictMarkov)

    return {
        uniform: { top1: pct(unifResult.top1), top3: pct(unifResult.top3), logLoss: round4(unifResult.ll) },
        marginal: { top1: pct(margResult.top1), top3: pct(margResult.top3), logLoss: round4(margResult.ll) },
        markov: { top1: pct(mkResult.top1), top3: pct(mkResult.top3), logLoss: round4(mkResult.ll) },
    }
}

// ------------------------------------------------------------------
// E2 — Shuffle Test (does temporal order matter?)
// ------------------------------------------------------------------

function e2_shuffle(chron) {
    const FRAC = 0.8
    const REPS = 5

    const ordered = evaluate(chron, FRAC, buildMarkovModel, predictMarkov)

    const split = Math.floor(chron.length * FRAC)
    const trainFull = chron.slice(0, split)
    const test = chron.slice(split)

    let shuffTop1Sum = 0, shuffTop3Sum = 0, shuffLlSum = 0
    for (let rep = 0; rep < REPS; rep++) {
        const shuffled = [...trainFull].sort(() => Math.random() - 0.5)
        const model = buildMarkovModel(shuffled)
        let h1 = 0, h3 = 0
        const lls = []
        for (let i = 1; i < test.length; i++) {
            const prev = getSum(test[i - 1])
            const actual = getSum(test[i])
            const probs = predictMarkov(model, prev)
            if (topK(probs, 1)[0] + MIN_SUM === actual) h1++
            if (topK(probs, 3).some(idx => idx + MIN_SUM === actual)) h3++
            lls.push(probs[actual - MIN_SUM])
        }
        const n = test.length - 1
        shuffTop1Sum += h1 / n
        shuffTop3Sum += h3 / n
        shuffLlSum += logLoss(lls)
    }

    return {
        ordered: { top1: pct(ordered.top1), top3: pct(ordered.top3), logLoss: round4(ordered.ll) },
        shuffled: { top1: pct(shuffTop1Sum / REPS), top3: pct(shuffTop3Sum / REPS), logLoss: round4(shuffLlSum / REPS) },
        // Threshold: 1 percentage point (0.01 in fraction). Smaller differences are noise.
        verdict: Math.abs((shuffTop1Sum / REPS) - ordered.top1) < 0.01
            ? 'SHUFFLE_SAME: no temporal signal — order does not matter'
            : 'SHUFFLE_DIFFERS: some temporal structure present',
    }
}

// ------------------------------------------------------------------
// E3 — Conditional vs Marginal Delta
// ------------------------------------------------------------------

function e3_conditional_delta(chron) {
    const mk = buildTransitionCounts(chron)
    const marg = buildMarginal(chron, 0)  // unsmoothed marginal for cleaner delta

    let sumDelta = 0, maxDelta = 0
    let nPairs = 0
    const deltaMatrix = {}

    for (let prev = MIN_SUM; prev <= MAX_SUM; prev++) {
        const rowCounts = mk[prev] || {}
        const rowTotal = Object.values(rowCounts).reduce((a, v) => a + v, 0)
        if (rowTotal === 0) continue
        deltaMatrix[prev] = {}
        for (let s = MIN_SUM; s <= MAX_SUM; s++) {
            const condP = ((rowCounts[s] || 0) + 0.5) / (rowTotal + 0.5 * NUM_SUMS)
            const margP = marg[s - MIN_SUM]
            const delta = Math.abs(condP - margP)
            deltaMatrix[prev][s] = round4(delta)
            sumDelta += delta
            maxDelta = Math.max(maxDelta, delta)
            nPairs++
        }
    }

    return {
        meanAbsDelta: round4(sumDelta / nPairs),
        maxAbsDelta: round4(maxDelta),
        note: 'Delta = |P(next=s|prev) - P(next=s)|. Near-zero → Markov adds nothing beyond marginal.',
    }
}

// ------------------------------------------------------------------
// E4 — Mutual Information I(X_{t-1}; X_t)
// ------------------------------------------------------------------

function e4_mutual_information(chron) {
    // Joint counts
    const joint = {}
    const margX = new Array(NUM_SUMS).fill(0)
    const margY = new Array(NUM_SUMS).fill(0)
    let N = 0

    for (let i = 1; i < chron.length; i++) {
        const x = getSum(chron[i - 1]) - MIN_SUM
        const y = getSum(chron[i]) - MIN_SUM
        if (!joint[x]) joint[x] = {}
        joint[x][y] = (joint[x][y] || 0) + 1
        margX[x]++
        margY[y]++
        N++
    }

    let mi = 0
    for (let x = 0; x < NUM_SUMS; x++) {
        for (let y = 0; y < NUM_SUMS; y++) {
            const n_xy = (joint[x] && joint[x][y]) || 0
            if (n_xy === 0) continue
            const p_xy = n_xy / N
            const p_x = (margX[x] + 0.5) / (N + 0.5 * NUM_SUMS)
            const p_y = (margY[y] + 0.5) / (N + 0.5 * NUM_SUMS)
            mi += p_xy * Math.log(p_xy / (p_x * p_y))
        }
    }

    // Max MI (log2 of NUM_SUMS bits)
    const maxMI = Math.log(NUM_SUMS)

    return {
        mutualInformation: round4(Math.max(mi, 0)),
        maxPossible: round4(maxMI),
        fractionOfMax: round4(Math.max(mi, 0) / maxMI),
        N,
        note: 'I(X_{t-1}; X_t) in nats. Near 0 → almost independent.',
    }
}

// ------------------------------------------------------------------
// E5 — KL Divergence per row from marginal
// ------------------------------------------------------------------

function e5_kl_divergence(chron) {
    const mk = buildTransitionCounts(chron)
    const marg = buildMarginal(chron)
    const alpha = 0.5

    const kls = {}
    let sumKL = 0, maxKL = 0, count = 0

    for (let prev = MIN_SUM; prev <= MAX_SUM; prev++) {
        const row = mk[prev] || {}
        const rowTotal = Object.values(row).reduce((a, v) => a + v, 0)
        if (rowTotal < 5) continue  // too sparse to trust
        let kl = 0
        for (let s = MIN_SUM; s <= MAX_SUM; s++) {
            const q = ((row[s] || 0) + alpha) / (rowTotal + alpha * NUM_SUMS)
            const p = marg[s - MIN_SUM]
            kl += q * Math.log(q / p)
        }
        kls[prev] = round4(kl)
        sumKL += kl
        maxKL = Math.max(maxKL, kl)
        count++
    }

    return {
        perRow: kls,
        meanKL: round4(count ? sumKL / count : 0),
        maxKL: round4(maxKL),
        note: 'KL(P(·|prev) || P(·)) for each conditioning sum. Near 0 → rows ≈ marginal.',
    }
}

// ------------------------------------------------------------------
// E6 — Adversarial Dataset
// ------------------------------------------------------------------

function e6_adversarial() {
    function sumOfDice() {
        return Math.ceil(Math.random() * 6) + Math.ceil(Math.random() * 6) + Math.ceil(Math.random() * 6)
    }

    // IID synthetic (should get ~6.25% top-1)
    const iidData = Array.from({ length: 10000 }, (_, i) => ({ ky: i, sum: sumOfDice() }))

    // Biased: P(s+1 | s) = 0.3, rest uniform over remaining 0.7
    function biasedNext(prev) {
        if (Math.random() < 0.3) return Math.min(prev + 1, MAX_SUM)
        return Math.floor(Math.random() * NUM_SUMS) + MIN_SUM
    }
    const biasedData = [{ ky: 0, sum: sumOfDice() }]
    for (let i = 1; i < 10000; i++) {
        biasedData.push({ ky: i, sum: biasedNext(biasedData[i - 1].sum) })
    }

    function evalMarkov(dataset) {
        const chron = dataset
        const split = Math.floor(chron.length * 0.8)
        const train = chron.slice(0, split)
        const test = chron.slice(split)
        const mk = buildTransitionCounts(train)
        const marg = buildMarginal(train)
        let h1 = 0
        for (let i = 1; i < test.length; i++) {
            const prev = getSum(test[i - 1])
            const actual = getSum(test[i])
            const probs = Array.from({ length: NUM_SUMS }, (_, s) => markovProb(mk, marg, prev, s + MIN_SUM))
            if (topK(probs, 1)[0] + MIN_SUM === actual) h1++
        }
        return pct(h1 / (test.length - 1))
    }

    return {
        iidTop1: evalMarkov(iidData),
        biasedTop1: evalMarkov(biasedData),
        expectedIID: pct(1 / NUM_SUMS),
        note: 'IID should be ~6.25%. Biased should be >6.25% if Markov detects signal.',
    }
}

// ------------------------------------------------------------------
// E7 — Base-rate Normalised Markov
// ------------------------------------------------------------------

function e7_normalised(chron) {
    const FRAC = 0.8
    const result = evaluate(chron, FRAC, buildMarkovModel, (model, prev) => {
        const { mk, marg } = model
        const raw = Array.from({ length: NUM_SUMS }, (_, i) => markovProb(mk, marg, prev, i + MIN_SUM))
        // Divide by marginal: score_s = P(next=s|prev) / P(next=s). Removes base-rate advantage.
        return raw.map((p, i) => p / marg[i])
    })
    return {
        top1: pct(result.top1),
        top3: pct(result.top3),
        logLoss: round4(result.ll),
        note: 'Scores = P(next|prev) / P(next). Removes base-rate. If top1 drops to ~6.25%, Markov was riding frequency.',
    }
}

// ------------------------------------------------------------------
// Utilities
// ------------------------------------------------------------------

function pct(v) { return Math.round(v * 10000) / 100 }  // 0.1248 → 12.48
function round4(v) { return Math.round(v * 10000) / 10000 }

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

function runAll() {
    const chron = chronOrder(DATA)
    if (chron.length < 100) throw new Error(`Not enough data: ${chron.length} records`)

    const e1 = e1_baseline(chron)
    const e2 = e2_shuffle(chron)
    const e3 = e3_conditional_delta(chron)
    const e4 = e4_mutual_information(chron)
    const e5 = e5_kl_divergence(chron)
    const e6 = e6_adversarial()
    const e7 = e7_normalised(chron)

    // Overall verdict
    const markovGain = e1.markov.top1 - e1.uniform.top1
    const isTemporal = (
        Math.abs(e2.ordered.top1 - e2.shuffled.top1) > 0.5 ||
        e4.mutualInformation > 0.01 ||
        e5.maxKL > 0.05
    )
    const verdict = isTemporal ? 'TEMPORAL_SIGNAL_PRESENT' : 'MARKOV_IS_ILLUSION'
    const verdictNote = isTemporal
        ? 'At least one experiment indicates genuine temporal structure.'
        : 'Markov accuracy is indistinguishable from base-rate. Any gain comes from the marginal distribution, not sequential order.'

    return {
        experiments: { e1, e2, e3, e4, e5, e6, e7 },
        summary: {
            markovGainVsUniform: round4(e1.markov.top1 - e1.uniform.top1),
            markovGainVsMarginal: round4(e1.markov.top1 - e1.marginal.top1),
            shuffleDelta: round4(e2.ordered.top1 - e2.shuffled.top1),
            mutualInformation: e4.mutualInformation,
            meanKL: e5.meanKL,
            verdict,
            verdictNote,
        },
        _computedAt: Date.now(),
        _N: chron.length,
    }
}

module.exports = { runAll }

// When run directly: print results
if (require.main === module) {
    console.time('markov-reality')
    const result = runAll()
    console.timeEnd('markov-reality')
    console.log(JSON.stringify(result, null, 2))
}
