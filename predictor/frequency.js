'use strict'
/**
 * predictor/frequency.js
 * Counts how many times each n1-n2-n3 combination has appeared.
 *
 * @param {Array} data - draw records
 * @returns {Object}  { "1-2-3": 4, "2-3-4": 2, … }
 */
function frequency(data) {
  const freq = {}
  for (const d of data) {
    const k = `${d.n1}-${d.n2}-${d.n3}`
    freq[k] = (freq[k] || 0) + 1
  }
  return freq
}

module.exports = frequency
