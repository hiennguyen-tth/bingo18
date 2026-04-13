'use strict'
/**
 * predictor/model_d.js — Model D: k-NN Temporal Similarity
 *
 * Non-parametric ML: for each incoming draw context (the last WINDOW draws),
 * find the k most historically similar contexts and score each combo by
 * inverse-distance-weighted frequency of what actually followed them.
 *
 * Feature vector (dim = 5 × WINDOW + 6):
 *   [sum/18, n1/6, n2/6, n3/6, pattern] × last WINDOW draws  (5 × WINDOW)
 *   digit frequency [1-6] across the whole WINDOW               (6 dims)
 *
 *   — normalised to [0,1] so all dimensions contribute equally
 *   — digit frequency captures which digits are "hot" in context
 *   — pattern (0=normal,0.5=pair,1=triple) captures streak type
 *
 * Distance: Euclidean in feature space
 * k: adaptive — max(K_MIN, 5% of eligible windows), capped at K_MAX
 *
 * Why pure JS?
 *   Works in production (node:20-alpine) with no Python dependency.
 *   At N≈1000 records this takes <1 ms per prediction call.
 */

const K_MIN = 15
const K_MAX = 60
const WINDOW = 8

/**
 * Build a normalised feature vector from a slice of WINDOW consecutive draws.
 * Dimensions: 5*WINDOW + 6
 *   - [sum/18, n1/6, n2/6, n3/6, pattern] × WINDOW  (lag features)
 *   - digit frequency [1..6] / maxCount              (6 global context dims)
 *
 * @param {Array} slice - exactly WINDOW draw objects with {sum, n1, n2, n3}
 * @returns {number[]} length-(5*WINDOW+6) vector
 */
function buildVec(slice) {
    const v = []
    // Lag features: per-draw values (5 dims × WINDOW)
    for (const r of slice) {
        v.push(r.sum / 18, r.n1 / 6, r.n2 / 6, r.n3 / 6)
        // Pattern encoding: 0=normal, 0.5=pair, 1.0=triple
        if (r.n1 === r.n2 && r.n2 === r.n3) v.push(1.0)
        else if (r.n1 === r.n2 || r.n2 === r.n3 || r.n1 === r.n3) v.push(0.5)
        else v.push(0.0)
    }
    // Digit frequency: how often each digit (1-6) appeared across all 3 positions
    // Normalised by max possible occurrences (3 × WINDOW)
    const cnt = [0, 0, 0, 0, 0, 0]
    for (const r of slice) { cnt[r.n1 - 1]++; cnt[r.n2 - 1]++; cnt[r.n3 - 1]++ }
    const maxCnt = 3 * slice.length
    for (const c of cnt) v.push(c / maxCnt)
    return v
}

function euclidean(a, b) {
    let d = 0
    for (let i = 0; i < a.length; i++) d += (a[i] - b[i]) ** 2
    return Math.sqrt(d)
}

/**
 * Model D: k-NN combo scorer.
 *
 * @param {Array} chron - chronologically sorted draw history (oldest → newest).
 * @returns {Object} score map {'1-1-1': number, …}; empty {} if < K_MIN+WINDOW+1 draws.
 */
function modelD(chron) {
    const N = chron.length
    if (N < WINDOW + K_MIN + 1) return {}

    // Query: the WINDOW draws immediately before the draw we want to predict
    const qVec = buildVec(chron.slice(N - WINDOW, N))

    // Adaptive k — at least K_MIN, at most 5% of eligible windows, capped at K_MAX
    const eligible = N - WINDOW - 1          // windows that have a known outcome
    const k = Math.min(K_MAX, Math.max(K_MIN, Math.floor(eligible * 0.05)))

    // Build (distance, outcome) pairs for every past window
    const dists = []
    for (let i = WINDOW; i < N - 1; i++) {
        const vec = buildVec(chron.slice(i - WINDOW, i))
        const dist = euclidean(qVec, vec)
        dists.push({ dist, r: chron[i] })       // chron[i] is what actually followed that context
    }

    // Sort ascending by distance and take the k nearest
    dists.sort((a, b) => a.dist - b.dist)
    const neighbors = dists.slice(0, k)

    // Score combos: inverse-distance weighted hit count
    const scores = {}
    for (const { dist, r } of neighbors) {
        const combo = `${r.n1}-${r.n2}-${r.n3}`
        const weight = 1 / (dist + 1e-9)         // ε prevents div-by-zero on exact match
        scores[combo] = (scores[combo] || 0) + weight
    }

    return scores
}

module.exports = modelD
