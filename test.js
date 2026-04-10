'use strict'
/**
 * test.js  —  Unit tests for predictor modules
 *
 * Usage:  npm test   -or-   node test.js
 *
 * Tests are run without any external framework — only Node's built-in
 * `assert` module is used.
 */
const assert = require('assert')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗  ${name}`)
    console.error(`     → ${e.message}`)
    failed++
  }
}

/* ── Fixtures ─────────────────────────────────────────────────────────── */
/**
 * Seven draws, deliberately chosen so we can calculate expected values
 * by hand and verify every module.
 *
 * Transitions (for Markov tests):
 *   '1-2-3' → '2-3-4'   (i=1)
 *   '2-3-4' → '1-1-1'   (i=2)
 *   '1-1-1' → '3-4-5'   (i=3)
 *   '3-4-5' → '6-6-6'   (i=4)
 *   '6-6-6' → '2-3-4'   (i=5)
 *   '2-3-4' → '1-2-3'   (i=6)  ← last record is '1-2-3' again
 */
const MOCK = [
  { id: 'a', n1: 1, n2: 2, n3: 3, sum: 6, pattern: 'normal' }, // 0
  { id: 'b', n1: 2, n2: 3, n3: 4, sum: 9, pattern: 'normal' }, // 1
  { id: 'c', n1: 1, n2: 1, n3: 1, sum: 3, pattern: 'triple' }, // 2
  { id: 'd', n1: 3, n2: 4, n3: 5, sum: 12, pattern: 'normal' }, // 3
  { id: 'e', n1: 6, n2: 6, n3: 6, sum: 18, pattern: 'triple' }, // 4
  { id: 'f', n1: 2, n2: 3, n3: 4, sum: 9, pattern: 'normal' }, // 5
  { id: 'g', n1: 1, n2: 2, n3: 3, sum: 6, pattern: 'normal' }, // 6  ← last
]

/* ════════════════════════════════════════════════════════════════════════
   predictor/frequency
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n── predictor/frequency ──────────────────')
const frequency = require('./predictor/frequency')

test('returns an object', () => assert.ok(typeof frequency(MOCK) === 'object'))
test('empty data → {}', () => assert.deepStrictEqual(frequency([]), {}))
test('1-2-3 appears 2 times', () => assert.strictEqual(frequency(MOCK)['1-2-3'], 2))
test('2-3-4 appears 2 times', () => assert.strictEqual(frequency(MOCK)['2-3-4'], 2))
test('1-1-1 appears 1 time', () => assert.strictEqual(frequency(MOCK)['1-1-1'], 1))
test('6-6-6 appears 1 time', () => assert.strictEqual(frequency(MOCK)['6-6-6'], 1))
test('no unknown keys', () => {
  const f = frequency(MOCK)
  const keys = Object.keys(f)
  assert.ok(keys.every(k => /^\d-\d-\d$/.test(k)), 'key format must be n-n-n')
})

/* ════════════════════════════════════════════════════════════════════════
   predictor/markov
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n── predictor/markov ─────────────────────')
const markov = require('./predictor/markov')
const mk = markov(MOCK)

test('returns an object', () => assert.ok(typeof mk === 'object'))
test('empty data → {}', () => assert.deepStrictEqual(markov([]), {}))
test('single record → {}', () => assert.deepStrictEqual(markov([MOCK[0]]), {}))
test('has transition 1-2-3 → 2-3-4 (count 1)', () => assert.strictEqual(mk['1-2-3']['2-3-4'], 1))
test('has transition 2-3-4 → 1-1-1 (count 1)', () => assert.strictEqual(mk['2-3-4']['1-1-1'], 1))
test('has transition 2-3-4 → 1-2-3 (count 1)', () => assert.strictEqual(mk['2-3-4']['1-2-3'], 1))
test('has transition 6-6-6 → 2-3-4 (count 1)', () => assert.strictEqual(mk['6-6-6']['2-3-4'], 1))
test('unknown key yields undefined', () => assert.strictEqual(mk['5-5-5'], undefined))

/* ════════════════════════════════════════════════════════════════════════
   predictor/features
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n── predictor/features ───────────────────')
const features = require('./predictor/features')
const feat = features(MOCK)

test('length equals input length', () => assert.strictEqual(feat.length, MOCK.length))
test('empty data → []', () => assert.deepStrictEqual(features([]), []))
test('first record sum = 6', () => assert.strictEqual(feat[0].sum, 6))
test('first record odd count = 2', () => assert.strictEqual(feat[0].odd, 2))  // 1,3 odd; 2 even
test('first record even count = 1', () => assert.strictEqual(feat[0].even, 1))
test('first record uniqueCount = 3', () => assert.strictEqual(feat[0].uniqueCount, 3))
test('first record prevKey = null', () => assert.strictEqual(feat[0].prevKey, null))
test('second record diff = 3', () => assert.strictEqual(feat[1].diff, 3))   // 9-6=3
test('second record prevKey = 1-2-3', () => assert.strictEqual(feat[1].prevKey, '1-2-3'))
test('triple record uniqueCount = 1', () => assert.strictEqual(feat[2].uniqueCount, 1)) // 1-1-1
test('triple record odd = 3', () => assert.strictEqual(feat[2].odd, 3))

/* ════════════════════════════════════════════════════════════════════════
   predictor/ensemble
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n── predictor/ensemble ───────────────────')
const predict = require('./predictor/ensemble')

test('empty data → {}', () => assert.deepStrictEqual(predict([]), {}))
test('single record → {}', () => assert.deepStrictEqual(predict([MOCK[0]]), {}))
test('returns object', () => assert.ok(typeof predict(MOCK) === 'object'))
test('has predictions', () => assert.ok(Object.keys(predict(MOCK)).length > 0))

const scores = predict(MOCK)

// New model scores all 216 combos (unseen combos dominate due to high overdue ratio)
test('all 216 combos scored', () => assert.strictEqual(Object.keys(scores).length, 216))
test('top prediction is never-seen combo', () => {
  // With only 7 known combos in MOCK, 209 combos are unseen → gap=N=7 → highest c1
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const topCombo = sorted[0][0]
  const seenInMock = MOCK.map(r => `${r.n1}-${r.n2}-${r.n3}`)
  // Top combo should be unseen (gap = N = 7, overdueRatio = 7/216 >> seen combos)
  const topIsUnseen = !seenInMock.includes(topCombo)
  assert.ok(topIsUnseen, `Expected unseen combo on top, got ${topCombo}`)
})
test('all scores are non-negative', () => {
  assert.ok(Object.values(scores).every(v => v >= 0))
})
test('all scores are numbers', () => {
  assert.ok(Object.values(scores).every(v => typeof v === 'number' && isFinite(v)))
})
test('predict.ranked returns array', () => {
  const ranked = predict.ranked(MOCK)
  assert.ok(Array.isArray(ranked) && ranked.length === 216)
})
test('ranked items have combo, score, comboGap', () => {
  const ranked = predict.ranked(MOCK)
  assert.ok(ranked[0].combo && typeof ranked[0].score === 'number' && typeof ranked[0].comboGap === 'number')
})

/* ════════════════════════════════════════════════════════════════════════
   Summary
   ════════════════════════════════════════════════════════════════════════ */
console.log('\n─────────────────────────────────────────')
console.log(`  Passed : ${passed}`)
console.log(`  Failed : ${failed}`)

if (failed > 0) {
  console.error('\n  Some tests failed.')
  process.exit(1)
} else {
  console.log('\n  All tests passed ✓')
}
