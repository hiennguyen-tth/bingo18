'use strict'
/**
 * predictor/stats_tests.js — Statistical Reality Check
 *
 * Tests whether the draw sequence shows patterns beyond chance.
 * H0 for every test: each draw is IID uniform over the 216 combos.
 *
 *   1. Chi-square uniformity   — are combo frequencies flat?
 *   2. Lag-1 autocorrelation   — is the sum serially correlated?
 *   3. Runs test               — is the above/below-median sequence random?
 *
 * Interpretation (per test):
 *   p > 0.05 → fail to reject H0  → consistent with random
 *   p < 0.05 → reject H0          → evidence of non-randomness
 *
 * If ALL tests fail to reject H0, models A/B/D are working on noise.
 * If ANY test rejects H0, there is structural evidence in the data.
 *
 * NOTE: Statistical significance ≠ predictive utility.
 *   A significant chi-square only means frequencies aren't perfectly flat.
 *   It does not guarantee any combo-level predictability.
 */

// ── Normal CDF (Abramowitz & Stegun 26.2.17, max error 7.5e-8) ───────────
function normalCDF(z) {
    if (z === Infinity) return 1
    if (z === -Infinity) return 0
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
    const sign = z < 0 ? -1 : 1
    const az = Math.abs(z) / Math.SQRT2
    const t = 1 / (1 + p * az)
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-az * az)
    return 0.5 * (1 + sign * y)
}

// Two-tailed p-value: P(|Z| > |z|) under N(0,1)
function normalP2(z) {
    return 2 * (1 - normalCDF(Math.abs(z)))
}

// Upper-tail p-value P(Chi²_df > chi2stat) via Wilson-Hilferty approximation.
// Accurate for df ≥ 30. For df=215 error < 0.003.
function chiSquarePValue(chi2stat, df) {
    if (chi2stat <= 0) return 1
    const h = (chi2stat / df) ** (1 / 3)
    const mu = 1 - 2 / (9 * df)
    const sigma = Math.sqrt(2 / (9 * df))
    return 1 - normalCDF((h - mu) / sigma)
}

// ── Test 1: Chi-square uniformity over all 216 combos ─────────────────────
/**
 * H0: P(combo) = 1/216 for all 216 combos.
 * χ² = Σ (O - E)² / E  where E = N/216
 * df = 215
 * Requires N ≥ 216 (E ≥ 1) for a valid approximation; recommend N ≥ 500.
 */
function chiSquareTest(chron) {
    const N = chron.length
    if (N < 216) return { stat: null, df: 215, pValue: null, note: 'need_216_draws' }

    const observed = {}
    for (const r of chron) {
        const k = `${r.n1}-${r.n2}-${r.n3}`
        observed[k] = (observed[k] || 0) + 1
    }

    const E = N / 216
    let chi2 = 0
    for (let a = 1; a <= 6; a++)
        for (let b = 1; b <= 6; b++)
            for (let c = 1; c <= 6; c++) {
                const O = observed[`${a}-${b}-${c}`] || 0
                chi2 += (O - E) ** 2 / E
            }

    const pValue = chiSquarePValue(chi2, 215)
    return {
        stat: +chi2.toFixed(2),
        df: 215,
        pValue: +pValue.toFixed(4),
        significant: pValue < 0.05,
    }
}

// ── Test 2: Lag-1 autocorrelation on draw sums ────────────────────────────
/**
 * H0: r₁ = 0 (sums are serially independent).
 * z = r₁ × √N  ~  N(0, 1) under H0.
 * Two-tailed test.
 */
function autocorrTest(chron) {
    const N = chron.length
    if (N < 30) return { r: null, z: null, pValue: null, note: 'need_30_draws' }

    const sums = chron.map(r => r.sum != null ? r.sum : r.n1 + r.n2 + r.n3)
    const mean = sums.reduce((a, b) => a + b, 0) / N
    const centered = sums.map(s => s - mean)

    let cov = 0, variance = 0
    for (let i = 1; i < N; i++) cov += centered[i] * centered[i - 1]
    for (let i = 0; i < N; i++) variance += centered[i] ** 2

    if (variance === 0) return { r: 0, z: 0, pValue: 1, significant: false }

    // Pearson lag-1: denominator uses full N for variance (standard biased estimator)
    const r = cov / variance
    const z = r * Math.sqrt(N)
    const pValue = normalP2(z)

    return {
        r: +r.toFixed(4),
        z: +z.toFixed(3),
        pValue: +pValue.toFixed(4),
        significant: pValue < 0.05,
    }
}

// ── Test 3: Runs test (above / below median sum) ──────────────────────────
/**
 * H0: sequence is random (no runs structure).
 * Convert to binary sequence: 1 if sum > median, 0 otherwise.
 * Count R = number of runs (maximal consecutive identical subsequences).
 * Normal approximation: z = (R - E[R]) / SD[R].
 * Two-tailed test.
 */
function runsTest(chron) {
    const N = chron.length
    if (N < 30) return { runs: null, z: null, pValue: null, note: 'need_30_draws' }

    const sums = chron.map(r => r.sum != null ? r.sum : r.n1 + r.n2 + r.n3)
    const sorted = [...sums].sort((a, b) => a - b)
    const median = (sorted[Math.floor((N - 1) / 2)] + sorted[Math.ceil((N - 1) / 2)]) / 2

    const binary = sums.map(s => (s > median ? 1 : 0))
    const n1 = binary.filter(x => x === 1).length
    const n2 = N - n1

    if (n1 < 10 || n2 < 10) {
        return { runs: null, z: null, pValue: null, note: 'insufficient_split' }
    }

    let runs = 1
    for (let i = 1; i < N; i++) if (binary[i] !== binary[i - 1]) runs++

    const eRuns = (2 * n1 * n2) / N + 1
    const vRuns = (2 * n1 * n2 * (2 * n1 * n2 - N)) / (N * N * (N - 1))
    if (vRuns <= 0) return { runs, z: null, pValue: null, note: 'degenerate' }

    const z = (runs - eRuns) / Math.sqrt(vRuns)
    const pValue = normalP2(z)

    return {
        runs,
        expected: +eRuns.toFixed(1),
        z: +z.toFixed(3),
        pValue: +pValue.toFixed(4),
        significant: pValue < 0.05,
    }
}

// ── Public API ────────────────────────────────────────────────────────────
/**
 * Run all three tests and return a combined verdict.
 *
 * verdict:
 *   'no_pattern'       — 0 tests significant (consistent with IID random)
 *   'weak_pattern'     — 1 test significant (possible noise)
 *   'pattern_detected' — 2-3 tests significant (structural evidence)
 *
 * @param {Array} chron - chronological draw array (oldest first)
 */
function runStatTests(chron) {
    const chiSquare = chiSquareTest(chron)
    const autocorr = autocorrTest(chron)
    const runs = runsTest(chron)

    const sigCount = [chiSquare.significant, autocorr.significant, runs.significant]
        .filter(Boolean).length

    const verdict = sigCount === 0 ? 'no_pattern'
        : sigCount === 1 ? 'weak_pattern'
            : 'pattern_detected'

    return {
        chiSquare,
        autocorr,
        runs,
        anySignificant: sigCount > 0,
        verdict,
    }
}

module.exports = { runStatTests, chiSquareTest, autocorrTest, runsTest }
