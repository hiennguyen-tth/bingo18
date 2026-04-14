/**
 * web/app.jsx
 * Bingo18 AI Dashboard — React 18 / Babel Standalone
 * Served via Express static at http://localhost:3000/
 */
const { useState, useEffect, useCallback, memo } = React
const Heatmap = window.Heatmap // defined in heatmap.jsx (loaded first)

/** Format ISO draw time → "HH:mm dd/MM/yyyy" */
function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const hh = d.getHours().toString().padStart(2, '0')
  const mi = d.getMinutes().toString().padStart(2, '0')
  const dd = d.getDate().toString().padStart(2, '0')
  const mo = (d.getMonth() + 1).toString().padStart(2, '0')
  const yy = d.getFullYear()
  return `${hh}:${mi} ${dd}/${mo}/${yy}`
}

function predsSignature(preds) {
  return preds.map(p => `${p.combo}:${p.score}:${p.confidence}`).join('|')
}

function historySignature(records) {
  if (!records || records.length === 0) return '0'
  return `${records.length}:${records[0]?.ky || '0'}`
}

/* ─────────────────────────── Styles ───────────────────────────────────── */
const C = {
  app: { minHeight: '100vh', background: '#0f172a', color: '#e2e8f0', fontFamily: 'system-ui,-apple-system,sans-serif' },
  header: { background: 'linear-gradient(135deg,#1e1b4b 0%,#312e81 100%)', padding: '18px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(99,102,241,0.3)', flexWrap: 'wrap', gap: 12 },
  logo: { fontSize: 22, fontWeight: 800, color: '#a5b4fc', letterSpacing: '-0.5px' },
  sub: { fontSize: 12, color: '#6366f1', marginTop: 2 },
  pill: { fontSize: 11, background: 'rgba(99,102,241,0.2)', color: '#a5b4fc', padding: '4px 12px', borderRadius: 20, border: '1px solid rgba(99,102,241,0.4)' },
  main: { maxWidth: 1120, margin: '0 auto', padding: '28px 20px' },
  mainMobile: { maxWidth: 1120, margin: '0 auto', padding: '16px 12px' },
  sec: { marginBottom: 28 },
  label: { fontSize: 11, fontWeight: 700, color: '#6366f1', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 14 },
  card: { background: '#1e293b', borderRadius: 12, padding: '22px 24px', border: '1px solid rgba(255,255,255,0.06)' },
  grid3: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))', gap: 10 },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 },
  warn: { borderRadius: 8, padding: '11px 16px', marginBottom: 16, fontSize: 13 },
  tag: { display: 'inline-block', fontSize: 10, padding: '2px 8px', borderRadius: 10, fontWeight: 700 },
  btn: { background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 18px', cursor: 'pointer', fontSize: 13, fontWeight: 600, transition: 'opacity 0.15s' },
}

/* ─────────────────────────── PredCard ─────────────────────────────────── */
function getRankingBadge(normScore) {
  if (normScore >= 85) return { label: '🔥 HOT', color: '#FF6B3D', bg: 'rgba(255,107,61,0.18)', border: 'rgba(255,107,61,0.5)' }
  if (normScore >= 70) return { label: '⭐ STRONG', color: '#FFC857', bg: 'rgba(255,200,87,0.15)', border: 'rgba(255,200,87,0.45)' }
  if (normScore >= 55) return { label: '👍 GOOD', color: '#4CC9F0', bg: 'rgba(76,201,240,0.13)', border: 'rgba(76,201,240,0.4)' }
  if (normScore >= 40) return { label: '⚠️ WEAK', color: '#9D8DF1', bg: 'rgba(157,141,241,0.13)', border: 'rgba(157,141,241,0.4)' }
  return { label: '❄️ COLD', color: '#6B7280', bg: 'rgba(107,114,128,0.12)', border: 'rgba(107,114,128,0.35)' }
}

const PredCard = memo(function PredCard({ combo, pct, rank, maxPct, score, maxScore, overdueRatio, comboGap, pat, stability, zScore, statNorm, mk2Norm, sessNorm, confidence: confFromServer, calBuckets }) {
  const nums = combo.split('-')
  const normScore = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0
  const badge = getRankingBadge(normScore)
  // Use server-computed confidence (35–80% range, varies by score spread)
  // Falls back to rank-based estimate if not provided
  const confidence = confFromServer != null ? confFromServer
    : Math.max(35, Math.round(80 - rank * 4.5))
  // Calibrated hit rate at this rank position from walk-forward backtest
  const calHitPct = calBuckets ? calBuckets.find(b => b.rank === rank + 1)?.hitPct : null

  const patLabel = { triple: '♦ Triple', pair: '◆ Pair', normal: '◇ Normal' }[pat] || pat || '◇ Normal'
  const patColor = { triple: '#c4b5fd', pair: '#7dd3fc', normal: '#94a3b8' }[pat] || '#94a3b8'
  const patBg = { triple: 'rgba(139,92,246,0.15)', pair: 'rgba(59,130,246,0.12)', normal: 'rgba(255,255,255,0.03)' }[pat] || 'rgba(255,255,255,0.03)'
  const numColor = { triple: '#c4b5fd', pair: '#7dd3fc', normal: '#f1f5f9' }[pat] || '#f1f5f9'

  const rankColor = ['#fbbf24', '#94a3b8', '#cd7c3a']
  const barW = maxPct > 0 ? (pct / maxPct) * 100 : 0

  // z-score display (gap-based z — positive = overdue = interesting)
  const zColor = (zScore == null) ? '#64748b' : zScore > 2.0 ? '#FF6B3D' : zScore > 1.0 ? '#FFC857' : '#94a3b8'
  const zLabel = zScore != null ? zScore.toFixed(2) : 'N/A'

  // 3-model breakdown bar (v4: stat / mk2 / sess)
  const breakdownModels = [
    { label: 'stat', val: statNorm ?? 0, color: '#818cf8' },
    { label: 'mk2', val: mk2Norm ?? 0, color: '#34d399' },
    { label: 'sess', val: sessNorm ?? 0, color: '#fb923c' },
  ]
  const breakTotal = breakdownModels.reduce((s, m) => s + m.val, 0) || 1

  return (
    <div style={{
      background: patBg,
      border: `1px solid ${badge.border}`,
      borderRadius: 12,
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      {/* Row 1: badge + rank */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{
          fontSize: 11, fontWeight: 800, letterSpacing: '0.04em',
          color: badge.color, background: badge.bg,
          padding: '3px 10px', borderRadius: 20,
          border: `1px solid ${badge.border}`,
        }}>{badge.label}</span>
        <span style={{ fontSize: 15, fontWeight: 900, color: rank < 3 ? rankColor[rank] : '#475569' }}>
          #{rank + 1}
        </span>
      </div>

      {/* Row 2: combo digits */}
      <div style={{
        fontSize: 28, fontWeight: 900, letterSpacing: 6,
        color: numColor, textAlign: 'center',
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1,
      }}>
        {nums.join(' ')}
      </div>

      {/* Row 3: stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 8px', fontSize: 11 }}>
        <span style={{ color: '#64748b' }}>z-score</span>
        <span style={{ color: zColor, textAlign: 'right', fontWeight: 700 }}>{zLabel}</span>
        <span style={{ color: '#64748b' }}>pattern</span>
        <span style={{ color: patColor, textAlign: 'right', fontWeight: 600 }}>{patLabel}</span>
        <span style={{ color: '#64748b' }}>stability</span>
        <span style={{ color: '#e2e8f0', textAlign: 'right', fontWeight: 700 }}>{stability != null ? stability.toFixed(2) : '—'}</span>
        <span style={{ color: '#64748b' }}>share</span>
        <span style={{ color: '#a5b4fc', textAlign: 'right', fontWeight: 700 }}>{pct}%</span>
      </div>

      {/* Row 4: 4-model breakdown */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#475569', marginBottom: 3 }}>
          {breakdownModels.map(m => (
            <span key={m.label} style={{ color: m.color }}>{m.label} {(m.val / breakTotal * 100).toFixed(0)}%</span>
          ))}
        </div>
        <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, display: 'flex', overflow: 'hidden' }}>
          {breakdownModels.map(m => (
            <div key={m.label} style={{
              width: `${m.val / breakTotal * 100}%`, height: '100%',
              background: m.color, opacity: 0.85,
              transition: 'width 0.6s ease',
            }} />
          ))}
        </div>
      </div>

      {/* Row 5: confidence bar */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#64748b', marginBottom: 4 }}>
          <span>confidence{calHitPct != null ? <span style={{ color: '#475569', fontWeight: 400 }}> · lịch sử: {calHitPct}%</span> : ''}</span>
          <span style={{ color: badge.color, fontWeight: 700 }}>{confidence}%</span>
        </div>
        <div style={{ height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            width: `${confidence}%`, height: '100%',
            background: `linear-gradient(90deg,${badge.color}88,${badge.color})`,
            borderRadius: 3, transition: 'width 0.6s ease',
          }} />
        </div>
      </div>

      {/* Row 5: probability bar */}
      <div style={{ height: 3, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          width: `${barW}%`, height: '100%',
          background: pat === 'triple' ? 'linear-gradient(90deg,#7c3aed,#a78bfa)'
            : pat === 'pair' ? 'linear-gradient(90deg,#1d4ed8,#60a5fa)'
              : 'linear-gradient(90deg,#4f46e5,#818cf8)',
          borderRadius: 2, transition: 'width 0.6s ease',
        }} />
      </div>
    </div>
  )
})

/* ─────────────────────────── SumBar ───────────────────────────────────── */
const SumBar = memo(function SumBar({ sum, pct, maxPct }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
        <span style={{ fontWeight: 700, color: '#e2e8f0' }}>Sum {sum}</span>
        <span style={{ color: '#94a3b8' }}>{pct}%</span>
      </div>
      <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          width: `${maxPct > 0 ? (pct / maxPct) * 100 : 0}%`,
          height: '100%',
          background: 'linear-gradient(90deg,#6366f1,#818cf8)',
          borderRadius: 3,
          transition: 'width 0.6s ease',
        }} />
      </div>
    </div>
  )
})

/* ─────────────────────────── PatternTag ───────────────────────────────── */
const PatTag = memo(function PatTag({ pat }) {
  const s = {
    triple: { background: 'rgba(139,92,246,0.3)', color: '#c4b5fd' },
    pair: { background: 'rgba(59,130,246,0.25)', color: '#7dd3fc' },
    normal: { background: 'rgba(255,255,255,0.06)', color: '#94a3b8' },
  }[pat] || { background: 'rgba(255,255,255,0.06)', color: '#94a3b8' }
  return <span style={{ ...C.tag, ...s }}>{pat || 'normal'}</span>
})

/* ─────────────────────────── AccuracyPanel ─────────────────────────────── */
const AccuracyPanel = memo(function AccuracyPanel({ stats, loading }) {
  const [showReality, setShowReality] = React.useState(false)

  if (loading) return (
    <div style={{ color: '#475569', fontSize: 13, padding: '20px 0' }}>Đang tính độ chính xác…</div>
  )
  if (!stats || stats.message || stats.error || !stats.accuracy) return (
    <div style={{ color: '#fcd34d', fontSize: 12, lineHeight: 1.6 }}>
      Cần thêm dữ liệu để tính chính xác.<br />
      Hiện có: {stats?.total || 0} kỳ, cần ít nhất 12 kỳ.
    </div>
  )

  const { accuracy, hits, tested, baseline, segments, statTests } = stats

  const rows = [
    { label: 'Top 1', key: 'top1', desc: 'đoán đúng combo #1', color: '#fbbf24' },
    { label: 'Top 3', key: 'top3', desc: 'combo nằm trong top 3', color: '#60a5fa' },
    { label: 'Top 10', key: 'top10', desc: 'combo nằm trong top 10', color: '#34d399' },
  ]

  const vsBase = (acc, base) => {
    const diff = (acc - base).toFixed(2)
    const better = diff > 0
    return (
      <span style={{ fontSize: 10, color: better ? '#34d399' : '#f87171', marginLeft: 6 }}>
        {better ? '▲' : '▼'} {Math.abs(diff)}% vs random
      </span>
    )
  }

  // Reality check rendering
  const verdictMeta = statTests && {
    no_pattern: { label: 'Không phát hiện pattern', color: '#34d399', icon: '✓' },
    weak_pattern: { label: 'Có thể có pattern yếu', color: '#fbbf24', icon: '⚠' },
    pattern_detected: { label: 'Phát hiện pattern có ý nghĩa', color: '#f87171', icon: '!' },
  }[statTests.verdict]

  const pCell = (p) => {
    if (p == null) return <span style={{ color: '#475569' }}>—</span>
    const sig = p < 0.05
    return <span style={{ color: sig ? '#f87171' : '#34d399', fontWeight: sig ? 700 : 400 }}>{p}</span>
  }

  // Segment overfit indicator: compare train top10 vs forward top10
  const overfit = segments && segments.train && segments.forward
    ? +(segments.train.top10 - segments.forward.top10).toFixed(2)
    : null

  return (
    <div>
      <div style={{ fontSize: 11, color: '#475569', marginBottom: 16 }}>
        Walk-forward test trên <strong style={{ color: '#e2e8f0' }}>{tested}</strong> kỳ
        &nbsp;·&nbsp;Random baseline: top1={baseline.top1}% / top3={baseline.top3}% / top10={baseline.top10}%
      </div>

      {rows.map(r => (
        <div key={r.key} style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
            <span style={{ fontWeight: 700, color: '#e2e8f0' }}>
              {r.label}
              <span style={{ fontWeight: 400, color: '#64748b', marginLeft: 8 }}>{r.desc}</span>
            </span>
            <span style={{ color: r.color, fontWeight: 800 }}>
              {accuracy[r.key]}%
              {vsBase(accuracy[r.key], baseline[r.key])}
            </span>
          </div>
          <div style={{ height: 8, background: 'rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{
              width: `${Math.min(accuracy[r.key], 100)}%`,
              height: '100%',
              background: r.color,
              borderRadius: 4,
              transition: 'width 0.8s ease',
              boxShadow: `0 0 8px ${r.color}55`,
            }} />
          </div>
          <div style={{ fontSize: 10, color: '#475569', marginTop: 3 }}>
            Đúng {hits[r.key]}/{tested} kỳ
          </div>
        </div>
      ))}

      {/* Segmented accuracy: train / valid / forward */}
      {segments && (
        <div style={{ marginTop: 18, marginBottom: 4 }}>
          <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
            Overfitting check — Train / Valid / Forward
            {overfit !== null && (
              <span style={{ marginLeft: 8, color: overfit > 1 ? '#f87171' : '#34d399', fontWeight: 400 }}>
                (train−forward top10: {overfit > 0 ? '+' : ''}{overfit}%)
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            {[
              { key: 'train', label: 'Train (60%)', color: '#60a5fa' },
              { key: 'valid', label: 'Valid (20%)', color: '#a78bfa' },
              { key: 'forward', label: 'Forward (20%)', color: '#34d399' },
            ].map(({ key, label, color }) => {
              const s = segments[key]
              if (!s) return null
              return (
                <div key={key} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ fontSize: 10, color, fontWeight: 700, marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 11, color: '#e2e8f0' }}>Top10: <strong>{s.top10}%</strong></div>
                  <div style={{ fontSize: 10, color: '#64748b' }}>Top1: {s.top1}% · {s.tested}kỳ</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Reality Check (statistical tests) */}
      {statTests && (
        <div style={{ marginTop: 16 }}>
          <button
            onClick={() => setShowReality(v => !v)}
            style={{
              background: 'none', border: `1px solid ${verdictMeta.color}44`,
              borderRadius: 6, padding: '5px 10px', cursor: 'pointer',
              color: verdictMeta.color, fontSize: 11, display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <span>{verdictMeta.icon}</span>
            <span>Reality Check: {verdictMeta.label}</span>
            <span style={{ marginLeft: 'auto', opacity: 0.6 }}>{showReality ? '▲' : '▼'}</span>
          </button>

          {showReality && (
            <div style={{ marginTop: 8, fontSize: 11, background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ color: '#64748b', marginBottom: 8 }}>
                p &lt; 0.05 = có ý nghĩa thống kê (reject H0). Nếu tất cả p &gt; 0.05 → game random → model A/B/D có thể chỉ fit noise.
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr>
                    {['Test', 'Stat', 'p-value', 'Ý nghĩa'].map(h => (
                      <th key={h} style={{ textAlign: 'left', color: '#475569', fontWeight: 600, paddingBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ color: '#e2e8f0', paddingTop: 6, paddingRight: 8 }}>Chi-square</td>
                    <td style={{ color: '#94a3b8', paddingRight: 8 }}>{statTests.chiSquare.stat ?? '—'}</td>
                    <td>{pCell(statTests.chiSquare.pValue)}</td>
                    <td style={{ color: '#475569' }}>Tần suất combo phẳng?</td>
                  </tr>
                  <tr>
                    <td style={{ color: '#e2e8f0', paddingTop: 4, paddingRight: 8 }}>Autocorr</td>
                    <td style={{ color: '#94a3b8', paddingRight: 8 }}>{statTests.autocorr.r ?? '—'}</td>
                    <td>{pCell(statTests.autocorr.pValue)}</td>
                    <td style={{ color: '#475569' }}>Sum liên tiếp tương quan?</td>
                  </tr>
                  <tr>
                    <td style={{ color: '#e2e8f0', paddingTop: 4, paddingRight: 8 }}>Runs</td>
                    <td style={{ color: '#94a3b8', paddingRight: 8 }}>{statTests.runs.runs ?? '—'}</td>
                    <td>{pCell(statTests.runs.pValue)}</td>
                    <td style={{ color: '#475569' }}>Chuỗi trên/dưới trung vị ngẫu nhiên?</td>
                  </tr>
                </tbody>
              </table>
              <div style={{ marginTop: 8, color: '#475569', fontSize: 10, lineHeight: 1.5 }}>
                * Ý nghĩa thống kê ≠ khả năng dự đoán. Chi-square có thể reject H0 chỉ vì tần suất không hoàn toàn phẳng, không có nghĩa là combo cụ thể nào có thể dự đoán được.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

/* ─────────────────────────── TripleSignalCard ──────────────────────────── */
const TripleSignalCard = memo(function TripleSignalCard({ signal, anyTriple }) {
  if (!signal) return null
  const { sinceLastTriple, expectedGap, avgGap, overdueRatio, boostMult, hotTriples, verdict, aiConfirmed } = signal

  const level = overdueRatio >= 2 ? 'HIGH' : overdueRatio >= 1 ? 'MED' : 'LOW'
  const levelColor = { HIGH: '#f87171', MED: '#fbbf24', LOW: '#34d399' }[level]
  const levelBg = { HIGH: 'rgba(248,113,113,0.08)', MED: 'rgba(251,191,36,0.08)', LOW: 'rgba(52,211,153,0.06)' }[level]
  const barW = Math.min(100, (overdueRatio / 3) * 100)

  return (
    <div style={{
      background: levelBg,
      border: `1px solid ${levelColor}44`,
      borderRadius: 12, padding: '12px 16px', marginBottom: 16,
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
      gap: '10px 20px',
      alignItems: 'start',
    }}>
      {/* Tín hiệu hoa */}
      <div>
        <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
          🎲 Tín hiệu hoa (xxx)
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 22, fontWeight: 900, color: levelColor }}>{overdueRatio.toFixed(2)}x</span>
          <span style={{ fontSize: 11, color: '#64748b' }}>quá hạn</span>
        </div>
        <div style={{ height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
          <div style={{ width: `${barW}%`, height: '100%', background: levelColor, borderRadius: 3, transition: 'width 0.6s ease' }} />
        </div>
        <div style={{ fontSize: 11, color: '#64748b' }}>
          Chưa ra: <span style={{ color: levelColor, fontWeight: 700 }}>{sinceLastTriple}</span> kỳ
          &nbsp;·&nbsp;TB: <span style={{ color: '#e2e8f0' }}>{avgGap}</span> kỳ/lần
        </div>
      </div>

      {/* Thống kê */}
      <div>
        <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
          📊 Thống kê xxx
        </div>
        <div style={{ fontSize: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 8px' }}>
          <span style={{ color: '#64748b' }}>Tổng lần ra</span>
          <span style={{ color: '#e2e8f0', fontWeight: 700 }}>{anyTriple?.appeared ?? '—'}</span>
          <span style={{ color: '#64748b' }}>TB mỗi kỳ</span>
          <span style={{ color: '#e2e8f0', fontWeight: 700 }}>{anyTriple?.avgInterval ?? avgGap}ky</span>
          <span style={{ color: '#64748b' }}>Boost hiện tại</span>
          <span style={{ color: boostMult >= 1.3 ? '#f87171' : '#fbbf24', fontWeight: 700 }}>{boostMult}×</span>
        </div>
      </div>

      {/* Hoa khả năng nhất */}
      <div>
        <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
          {level === 'HIGH' ? '🔥 Hoa khả năng cao' : '💡 Hoa tiềm năng'}
        </div>
        {hotTriples && hotTriples.length > 0 ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {hotTriples.map((combo, i) => {
              const [n] = combo.split('-')
              return (
                <div key={combo} style={{
                  background: i === 0 ? 'rgba(196,181,253,0.15)' : 'rgba(255,255,255,0.05)',
                  border: `1px solid ${i === 0 ? 'rgba(196,181,253,0.4)' : 'rgba(255,255,255,0.1)'}`,
                  borderRadius: 8, padding: '4px 10px', fontSize: 16, fontWeight: 900,
                  color: i === 0 ? '#c4b5fd' : '#94a3b8',
                  letterSpacing: 2,
                }}>
                  {n}{n}{n}
                </div>
              )
            })}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#475569' }}>
            {verdict === 'no_pattern' ? 'AI chưa xác nhận combo hoa đủ mạnh' : level === 'LOW' ? 'Chưa đến lúc' : 'Đang tính…'}
          </div>
        )}
        {!aiConfirmed && (
          <div style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>Hoa chỉ hiện khi điểm cuối cùng đủ mạnh, không còn bị ưu tiên ép lên top.</div>
        )}
        {level === 'LOW' && (
          <div style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>Khả năng ra hoa chưa cao, chờ thêm {Math.round((expectedGap - sinceLastTriple))} kỳ</div>
        )}
      </div>
    </div>
  )
})

/* ─────────────────────────── OverdueTable ─────────────────────────────── */
const OverdueTable = memo(function OverdueTable({ items, loading, title }) {
  if (loading) return <div style={{ color: '#475569', fontSize: 13, padding: '16px 0' }}>Đang tính…</div>
  if (!items || items.length === 0) return <div style={{ color: '#475569', fontSize: 13, padding: '16px 0' }}>Không có dữ liệu</div>

  const maxScore = Math.max(...items.map(x => x.overdueScore || 0), 1)

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ ...C.label, marginBottom: 12 }}>{title}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              {['Giá trị', 'Số lần', 'Kỳ chưa về', 'TB mỗi kỳ', 'Quá hạn'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#64748b', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((row, i) => {
              const overdue = row.overdueScore >= 1
              const barW = Math.min((row.overdueScore / maxScore) * 100, 100)
              const barColor = row.overdueScore >= 2 ? '#f87171'
                : row.overdueScore >= 1 ? '#fbbf24'
                  : '#4f46e5'
              return (
                <tr key={row.key} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: overdue ? 'rgba(251,191,36,0.04)' : 'transparent' }}>
                  <td style={{ padding: '8px 12px', fontWeight: 700, color: overdue ? '#fbbf24' : '#e2e8f0' }}>{row.label}</td>
                  <td style={{ padding: '8px 12px', color: '#94a3b8' }}>{row.appeared}</td>
                  <td style={{ padding: '8px 12px', color: overdue ? '#f87171' : '#94a3b8', fontWeight: overdue ? 700 : 400 }}>{row.kySinceLast ?? '—'}</td>
                  <td style={{ padding: '8px 12px', color: '#94a3b8' }}>{typeof row.avgInterval === 'number' ? Math.round(row.avgInterval) : '—'}</td>
                  <td style={{ padding: '8px 12px', minWidth: 120 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ width: `${barW}%`, height: '100%', background: barColor, borderRadius: 3, transition: 'width 0.5s ease' }} />
                      </div>
                      <span style={{ fontSize: 11, color: barColor, fontWeight: 700, minWidth: 34, textAlign: 'right' }}>
                        {row.overdueScore ? row.overdueScore.toFixed(2) : '0.00'}x
                      </span>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
})

/* ─────────────────────────── NewDrawToast ──────────────────────────────── */
function NewDrawToast({ info, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6_000)
    return () => clearTimeout(t)
  }, [info])

  if (!info) return null
  return (
    <div style={{
      position: 'fixed', top: 18, right: 12, left: 12, zIndex: 9999,
      background: 'linear-gradient(135deg,#065f46,#047857)',
      color: '#ecfdf5', borderRadius: 12, padding: '14px 20px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      border: '1px solid rgba(52,211,153,0.4)',
      maxWidth: 320, width: 'min(320px, calc(100vw - 24px))', marginLeft: 'auto', animation: 'fadeIn 0.3s ease',
      cursor: 'pointer',
    }} onClick={onDismiss}>
      <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 4 }}>
        🎯 Kỳ mới! #{info.latestKy}
      </div>
      <div style={{ fontSize: 12, opacity: 0.85 }}>
        +{info.added} kỳ vừa mở thưởng — dự đoán đã cập nhật
      </div>
    </div>
  )
}

/* ─────────────────────────── App ──────────────────────────────────────── */
function App() {
  const [preds, setPreds] = useState([])
  const [sumStats, setSumStats] = useState([])
  const [maxScore, setMaxScore] = useState(1)
  const [history, setHistory] = useState([])
  // Refs store cheap signatures instead of whole payloads.
  const predsRef = React.useRef('')
  const historyRef = React.useRef('')
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [updated, setUpdated] = useState('—')
  const [toast, setToast] = useState(null)
  const [liveKy, setLiveKy] = useState(null)
  const [sseConnected, setSseConnected] = useState(false)
  const [stats, setStats] = useState(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [overdue, setOverdue] = useState(null)
  const [overdueLoading, setOverdueLoading] = useState(true)
  const [crawling, setCrawling] = useState(false)
  const [tripleSignal, setTripleSignal] = useState(null)

  // Bingo18 operating hours: 06:00–21:54 Vietnam time (UTC+7)
  const isNowOperating = () => {
    const vnMin = ((new Date().getUTCHours() + 7) % 24) * 60 + new Date().getUTCMinutes()
    return vnMin >= 360 && vnMin <= 1314
  }
  const [bingoClosed, setBingoClosed] = React.useState(!isNowOperating())

  const loadOverdue = useCallback(async () => {
    setOverdueLoading(true)
    try {
      const d = await fetch('/overdue', { cache: 'no-store' }).then(r => r.json())
      setOverdue(d)
    } catch (_) { }
    setOverdueLoading(false)
  }, [])

  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    try {
      const s = await fetch('/stats', { cache: 'no-store' }).then(r => r.json())
      setStats(s)
    } catch (_) { }
    setStatsLoading(false)
  }, [])

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [pRes, hRes] = await Promise.all([
        fetch('/predict', { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(`API ${r.status}`); return r.json() }),
        fetch('/history?limit=500', { cache: 'no-store' }).then(r => r.json()),
      ])
      const newPreds = pRes.next || []
      const newHistory = hRes.records || []
      const nextPredsSig = predsSignature(newPreds)
      const nextHistorySig = historySignature(newHistory)
      const predsChanged = nextPredsSig !== predsRef.current
      const historyChanged = nextHistorySig !== historyRef.current

      if (predsChanged) {
        predsRef.current = nextPredsSig
        setPreds(newPreds)
        setMaxScore(pRes.maxScore || 1)
        setTripleSignal(pRes.tripleSignal || null)
        setSumStats(pRes.sumStats || [])
      }
      if (historyChanged) {
        historyRef.current = nextHistorySig
        setHistory(newHistory)
      }
      if (predsChanged || historyChanged || !silent) {
        setTotal(pRes.total || 0)
        setUpdated(new Date().toLocaleTimeString('vi-VN'))
      }
    } catch (e) {
      setError(e.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])  // stable — state comparison uses refs, not closure values

  // Use refs so SSE handler always calls latest version of load functions
  const loadRef = React.useRef(load)
  const loadStatsRef = React.useRef(loadStats)
  const loadOverdueRef = React.useRef(loadOverdue)
  useEffect(() => { loadRef.current = load }, [load])
  useEffect(() => { loadStatsRef.current = loadStats }, [loadStats])
  useEffect(() => { loadOverdueRef.current = loadOverdue }, [loadOverdue])

  // ── SSE subscription ──────────────────────────────────────────────────
  useEffect(() => {
    let es
    let reconnectTimer
    let mounted = true

    function connect() {
      if (!mounted) return
      setSseConnected(false)
      es = new EventSource('/events')

      es.onopen = () => {
        if (mounted) setSseConnected(true)
      }

      es.addEventListener('new-draw', e => {
        if (!mounted) return
        const info = JSON.parse(e.data)
        setLiveKy(info.latestKy)
        setToast(info)
        loadRef.current(true)
        loadStatsRef.current()
        loadOverdueRef.current()
      })

      es.onerror = () => {
        if (!mounted) return
        setSseConnected(false)
        es.close()
        // Reconnect after 5s (prevent storm)
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(connect, 5_000)
      }
    }

    connect()
    return () => {
      mounted = false
      clearTimeout(reconnectTimer)
      if (es) es.close()
    }
  }, []) // stable — callbacks accessed via refs

  // ── Periodic data refresh ──
  // - Skip all fetches when the browser tab is hidden (saves mobile battery + server CPU)
  // - predict+history: every 60s during operating hours (06:00–21:54 VN), else every 5min
  // - stats+overdue:   every 5 minutes (heavy O(N²) backtest, changes slowly)
  // SSE handles instant updates when a new draw appears; polling is just a safety net.
  useEffect(() => {
    function isOperatingHours() {
      const vnMin = ((new Date().getUTCHours() + 7) % 24) * 60 + new Date().getUTCMinutes()
      return vnMin >= 360 && vnMin <= 1314  // 06:00–21:54 VN
    }

    load()
    loadStats()
    loadOverdue()
    const tFast = setInterval(() => {
      if (document.hidden) return          // tab not visible — skip
      if (!isOperatingHours()) return      // no new draws outside hours
      load(true)
    }, 60_000)
    const tSlow = setInterval(() => {
      if (document.hidden) return          // tab not visible — skip
      if (!isOperatingHours()) return      // no new draws outside hours
      loadStats()
      loadOverdue()
    }, 5 * 60_000)
    return () => {
      clearInterval(tFast)
      clearInterval(tSlow)
    }
  }, [load, loadStats, loadOverdue])

  const maxPct = Math.max(...preds.map(p => p.pct || 0), 1)

  return (
    <div style={C.app}>
      <NewDrawToast info={toast} onDismiss={() => setToast(null)} />

      {/* ── Header ── */}
      <div style={C.header}>
        <div>
          <div style={C.logo}>🎰 Bingo18 AI</div>
          <div style={C.sub} className="hide-mobile">AI Ensemble 7 Tín Hiệu · Realtime SSE · Walk-forward Backtest</div>
        </div>
        <div className="header-actions">
          <span style={C.pill}>{total} records</span>
          <span style={{
            ...C.pill,
            color: sseConnected ? '#34d399' : '#f87171',
            borderColor: sseConnected ? 'rgba(52,211,153,0.4)' : 'rgba(248,113,113,0.4)',
            background: sseConnected ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)',
          }}>
            {sseConnected ? '🟢 Live' : '🔴 Connecting…'}{liveKy ? ` · #${liveKy}` : ''}
          </span>
          {bingoClosed && (
            <span style={{
              ...C.pill,
              color: '#fbbf24',
              borderColor: 'rgba(251,191,36,0.4)',
              background: 'rgba(251,191,36,0.08)',
            }} title="Bingo18 mở 06:00–21:54 VN. Không có kỳ mới ngoài giờ này.">
              🔕 Ngoài giờ Bingo
            </span>
          )}
          <span style={{ ...C.pill, color: '#94a3b8' }}>
            ⟳ {updated}
          </span>
          <button style={{ ...C.btn, opacity: (crawling || loading) ? 0.6 : 1, background: 'rgba(52,211,153,0.15)', borderColor: 'rgba(52,211,153,0.4)', color: '#34d399' }}
            onClick={async () => {
              setCrawling(true)
              await fetch('/crawl', { method: 'POST' }).catch(() => { })
              setCrawling(false)
              load()
            }}
            disabled={crawling || loading}>
            {crawling ? 'Đang tải…' : loading ? 'Loading…' : '⬇ Cập nhật'}
          </button>
        </div>
      </div>

      {/* ―― Disclaimer ―― */}
      <div style={{ background: 'rgba(15,23,42,0.8)', borderBottom: '1px solid rgba(99,102,241,0.15)', padding: '7px 24px', textAlign: 'center', fontSize: 11, color: '#64748b' }}>
        ⚠️ Đây là công cụ thống kê giải trí. Bingo18 là xổ số ngẫu nhiên — không có mô hình AI nào có thể dự đoán chính xác kết quả. Chơi có trách nhiệm.
      </div>

      <div style={{ maxWidth: 1120, margin: '0 auto', padding: 'clamp(12px,3vw,28px) clamp(12px,3vw,20px)' }}>

        {/* ── Error banner ── */}
        {error && (
          <div style={{ ...C.warn, color: '#fca5a5', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}>
            ⚠ {error} — Hãy chắc chắn API đang chạy và có dữ liệu (cần ít nhất 100 kỳ để dự đoán). Click "Cập nhật" để thử lại.
          </div>
        )}
        {!loading && !error && total === 0 && (
          <div style={{ ...C.warn, color: '#fcd34d', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)' }}>
            Chưa có dữ liệu. Chờ hệ thống thu thập đủ kỳ mở thưởng để bắt đầu dự đoán (cần ít nhất 100 kỳ).
          </div>
        )}

        {/* ── Top-10 Predictions ── */}
        <div style={C.sec}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14, flexWrap: 'wrap', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={C.label}>Top 10 Combo dự đoán</div>
              {updated !== '—' && (
                <span style={{ fontSize: 10, color: '#475569' }}>⟳ {updated}</span>
              )}
            </div>
            <div style={{ fontSize: 11, color: '#475569' }} className="hide-mobile">
              % = tỷ lệ trong top-10 · X.Xx = số lần quá hạn so với kỳ vọng (1x = bình thường, &gt;1x = lâu chưa về)
            </div>
          </div>
          <TripleSignalCard signal={tripleSignal} anyTriple={overdue?.anyTriple} />
          <div className="grid3">
            {preds.length === 0 && !loading && (
              <div style={{ color: '#64748b', fontSize: 13 }}>Chưa có dự đoán.</div>
            )}
            {preds.map((p, i) => (
              <PredCard key={p.combo} combo={p.combo} pct={p.pct} rank={i}
                maxPct={maxPct} score={p.score} maxScore={maxScore}
                overdueRatio={p.overdueRatio} comboGap={p.comboGap ?? 0}
                pat={p.pat} stability={p.stability}
                zScore={p.zScore} statNorm={p.statNorm ?? p.coreNorm}
                mk2Norm={p.mk2Norm} sessNorm={p.sessNorm}
                confidence={p.confidence} calBuckets={stats?.calBuckets} />
            ))}
          </div>
        </div>

        {/* ── Overdue stats ── */}
        {overdue && (
          <div style={{ ...C.card, marginBottom: 28 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
              <div style={C.label}>Thống kê quá hạn</div>
              <div style={{ fontSize: 11, color: '#475569' }} className="hide-mobile">Số kỳ chưa về ÷ TB mỗi kỳ — &gt;1x là quá hạn</div>
            </div>
            <div className="grid-overdue">
              <OverdueTable
                items={overdue.anyTriple ? [overdue.anyTriple, ...overdue.triples] : overdue.triples}
                loading={overdueLoading}
                title={`Hoa — 111~666 (${overdue.triples?.length || 0})`}
              />
              <OverdueTable items={overdue.pairs} loading={overdueLoading} title={`D - 11~66 (${overdue.pairs?.length || 0})`} />
              <OverdueTable items={overdue.sums} loading={overdueLoading} title={`T — 3~18 (${overdue.sums?.length || 0})`} />
            </div>
          </div>
        )}

        {/* ── History table ── */}
        <div style={{ ...C.card, marginBottom: 28 }}>
          <div style={C.label}>Lịch sử gần nhất ({history.length} records)</div>
          <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ position: 'sticky', top: 0, background: '#1e293b', zIndex: 1 }}>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  <th style={{ padding: '7px 10px', textAlign: 'left', color: '#64748b', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>#</th>
                  <th style={{ padding: '7px 10px', textAlign: 'left', color: '#64748b', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Kỳ</th>
                  <th style={{ padding: '7px 10px', textAlign: 'left', color: '#64748b', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>N1</th>
                  <th style={{ padding: '7px 10px', textAlign: 'left', color: '#64748b', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>N2</th>
                  <th style={{ padding: '7px 10px', textAlign: 'left', color: '#64748b', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>N3</th>
                  <th className="hide-mobile" style={{ padding: '7px 10px', textAlign: 'left', color: '#64748b', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sum</th>
                  <th className="hide-mobile" style={{ padding: '7px 10px', textAlign: 'left', color: '#64748b', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Pattern</th>
                  <th style={{ padding: '7px 10px', textAlign: 'left', color: '#64748b', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Giờ mở</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r, i) => (
                  <tr key={r.id || i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={{ padding: '7px 10px', color: '#475569', fontSize: 12 }}>{i + 1}</td>
                    <td style={{ padding: '7px 10px', color: '#6366f1', fontWeight: 700, fontSize: 11 }}>#{r.ky || '—'}</td>
                    {[r.n1, r.n2, r.n3].map((n, j) => (
                      <td key={j} style={{ padding: '7px 10px' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.35)', borderRadius: 6, fontWeight: 800, color: '#a5b4fc', fontSize: 12 }}>{n}</span>
                      </td>
                    ))}
                    <td className="hide-mobile" style={{ padding: '7px 10px', fontWeight: 700, color: '#f1f5f9' }}>{r.sum}</td>
                    <td className="hide-mobile" style={{ padding: '7px 10px' }}><PatTag pat={r.pattern} /></td>
                    <td style={{ padding: '7px 10px', color: '#475569', fontSize: 11, whiteSpace: 'nowrap' }}>{fmtTime(r.drawTime)}</td>
                  </tr>
                ))}
                {history.length === 0 && (
                  <tr><td colSpan={8} style={{ padding: '24px', textAlign: 'center', color: '#475569' }}>Không có dữ liệu</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Sum distribution (visible on all screen sizes) ── */}
        {sumStats.length > 0 && (
          <div style={{ ...C.card, marginBottom: 28 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
              <div style={C.label}>Phân phối Sum</div>
              <div style={{ fontSize: 11, color: '#475569' }}>% kỳ có tổng n1+n2+n3 = X · Lý thuyết: Sum 10/11 = 12.5% cao nhất</div>
            </div>
            {(() => {
              const maxSumPct = Math.max(...sumStats.map(x => x.pct), 1)
              return sumStats.slice(0, 16).map(s => (
                <SumBar key={s.sum} sum={s.sum} pct={s.pct} maxPct={maxSumPct} />
              ))
            })()}
          </div>
        )}

        {/* ── Accuracy + Heatmap (desktop only — complex layout) ── */}
        <div className="hide-mobile">
          <div style={{ ...C.card, marginBottom: 28 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
              <div style={C.label}>Độ chính xác dự đoán</div>
              <div style={{ fontSize: 11, color: '#475569' }}>Walk-forward backtest — huấn luyện trên data quá khứ, kiểm tra trên kỳ tiếp theo</div>
            </div>
            <AccuracyPanel stats={stats} loading={statsLoading} />
          </div>
          <div style={C.card}>
            <Heatmap history={history} />
          </div>
        </div>

      </div>

      {/* ── Footer ── */}
      <footer style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '28px 24px', textAlign: 'center', marginTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
          {[
            { href: '/about', label: 'Về chúng tôi' },
            { href: '/how-it-works', label: 'Cách hoạt động' },
            { href: '/blog/what-is-bingo18', label: 'Bingo18 là gì?' },
            { href: '/blog/best-strategy-2026', label: 'Chiến thuật 2026' },
            { href: '/privacy-policy', label: 'Chính sách bảo mật' },
          ].map(({ href, label }) => (
            <a key={href} href={href} style={{ fontSize: 13, color: '#475569', textDecoration: 'none' }}>
              {label}
            </a>
          ))}
        </div>
        <div style={{ fontSize: 12, color: '#334155' }}>
          © 2026 Bingo18 AI · Chỉ dành cho mục đích tham khảo thống kê · Không khuyến khích cờ bạc
        </div>
      </footer>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('app')).render(<App />)
