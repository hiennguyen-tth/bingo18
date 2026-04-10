'use strict'
/**
 * predictor/features.js
 * Converts raw draw history into feature vectors for downstream models.
 *
 * @param {Array} history - array of draw records
 * @returns {Array} feature objects
 */
function features(history) {
  return history.map((r, i) => {
    const prev = history[i - 1] || {}
    const nums = [r.n1, r.n2, r.n3]

    return {
      // ── raw draw ──────────────────────
      sum: r.sum,
      n1: r.n1, n2: r.n2, n3: r.n3,

      // ── parity ────────────────────────
      odd: nums.filter(x => x % 2 !== 0).length,
      even: nums.filter(x => x % 2 === 0).length,

      // ── delta from previous draw ──────
      diff: r.sum - (prev.sum || 0),

      // ── diversity ─────────────────────
      uniqueCount: new Set(nums).size,   // 1=triple, 2=pair, 3=all different
      pattern: r.pattern || 'normal',

      // ── Markov key of previous draw ───
      prevKey: prev.n1 !== undefined
        ? `${prev.n1}-${prev.n2}-${prev.n3}`
        : null,
    }
  })
}

module.exports = features
