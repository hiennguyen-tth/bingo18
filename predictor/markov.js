'use strict'
/**
 * predictor/markov.js
 * Builds a first-order Markov transition table:
 *   map[prevCombo][nextCombo] = count
 *
 * Keys use the format "n1-n2-n3" (e.g. "1-2-3").
 *
 * @param {Array} data - draw records (chronological order)
 * @returns {Object} transition map
 */
function markov(data) {
  const map = {}

  for (let i = 1; i < data.length; i++) {
    const prev = `${data[i - 1].n1}-${data[i - 1].n2}-${data[i - 1].n3}`
    const curr = `${data[i].n1}-${data[i].n2}-${data[i].n3}`

    if (!map[prev]) map[prev] = {}
    map[prev][curr] = (map[prev][curr] || 0) + 1
  }

  return map
}

module.exports = markov
