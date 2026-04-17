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

function predsSignature(preds, latestKy) {
  return `${latestKy || '0'}::${preds.map(p => `${p.combo}:${p.score}:${p.confidence}`).join('|')}`
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
function getRankingBadge(rank, zScore, sessNorm, isUniform) {
  // When no_pattern (uniform scores), show diversity-aware labels instead of misleading "HOT 80%"
  if (isUniform || rank >= 10) {
    // Overdue-based badge
    if (zScore != null && zScore > 2.0) return { label: '🔴 Quá hạn', color: '#FF6B3D', bg: 'rgba(255,107,61,0.18)', border: 'rgba(255,107,61,0.5)' }
    if (zScore != null && zScore > 1.0) return { label: '🟡 Khá hạn', color: '#FFC857', bg: 'rgba(255,200,87,0.15)', border: 'rgba(255,200,87,0.45)' }
    if (sessNorm != null && sessNorm < 0.1) return { label: '🟣 Hiếm', color: '#a78bfa', bg: 'rgba(167,139,250,0.15)', border: 'rgba(167,139,250,0.4)' }
    return { label: '⚪ Đa dạng', color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.35)' }
  }
  // Pattern mode: rank-based
  if (rank < 3) return { label: '🔥 HOT', color: '#FF6B3D', bg: 'rgba(255,107,61,0.18)', border: 'rgba(255,107,61,0.5)' }
  if (rank < 5) return { label: '⭐ STRONG', color: '#FFC857', bg: 'rgba(255,200,87,0.15)', border: 'rgba(255,200,87,0.45)' }
  if (rank < 7) return { label: '👍 GOOD', color: '#4CC9F0', bg: 'rgba(76,201,240,0.13)', border: 'rgba(76,201,240,0.4)' }
  return { label: '⚠️ OK', color: '#9D8DF1', bg: 'rgba(157,141,241,0.13)', border: 'rgba(157,141,241,0.4)' }
}

const PredCard = memo(function PredCard({ combo, pct, rank, maxPct, score, maxScore, overdueRatio, comboGap, pat, stability, zScore, statNorm, mk2Norm, sessNorm, confidence: confFromServer, calBuckets, isUniform }) {
  const nums = combo.split('-')
  const badge = getRankingBadge(rank, zScore, sessNorm, isUniform)
  // Calibrated hit rate at this rank position from walk-forward backtest
  const calHitPct = calBuckets ? calBuckets.find(b => b.rank === rank + 1)?.hitPct : null
  // Display calibrated hit rate when available, else server confidence
  const displayConf = calHitPct != null ? calHitPct : confFromServer

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
        <span style={{ color: '#64748b' }}>chưa về</span>
        <span style={{ color: comboGap > 500 ? '#FF6B3D' : comboGap > 250 ? '#FFC857' : '#94a3b8', textAlign: 'right', fontWeight: 700 }}>{comboGap != null ? `${comboGap}k` : '—'}</span>
        <span style={{ color: '#64748b' }}>share</span>
        <span style={{ color: '#a5b4fc', textAlign: 'right', fontWeight: 700 }}>{pct}%</span>
      </div>

      {/* Row 4: model breakdown OR diversity note */}
      {isUniform ? (
        // When all pattern-models are disabled (no_pattern → shrink=0), scores are
        // uniform. The breakdown bar would show raw z-rank, not actual contribution.
        // Show z-overdue context instead — the only meaningful per-combo signal.
        <div style={{ fontSize: 9, color: '#475569', display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#334155' }}>portfolio diversity · chọn theo digit coverage</span>
          {zScore != null && zScore > 0 && (
            <span style={{ color: zColor, fontWeight: 700 }}>z+{zScore.toFixed(2)} overdue</span>
          )}
        </div>
      ) : (
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
      )}

      {/* Row 5: calibrated hit rate (replaces misleading confidence %) */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#64748b', marginBottom: 4 }}>
          <span>{calHitPct != null ? 'lịch sử' : 'confidence'}{calHitPct != null && <span style={{ color: '#475569', fontWeight: 400 }}> (backtest)</span>}</span>
          <span style={{ color: calHitPct != null ? '#34d399' : badge.color, fontWeight: 700 }}>{calHitPct != null ? `${calHitPct}%` : displayConf != null ? `${displayConf}%` : '—'}</span>
        </div>
        <div style={{ height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            width: `${Math.min(100, (displayConf || 0) * (calHitPct != null ? 50 : 1))}%`, height: '100%',
            background: calHitPct != null
              ? 'linear-gradient(90deg,#34d39988,#34d399)'
              : `linear-gradient(90deg,${badge.color}88,${badge.color})`,
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
    <div style={{ color: '#475569', fontSize: 13, padding: '20px 0' }}>Đang tải…</div>
  )
  // Server is computing backtest for the first time — show message, not infinite spinner
  if (stats?.computing) return (
    <div style={{ color: '#fbbf24', fontSize: 12, lineHeight: 1.8, padding: '8px 0' }}>
      ⏳ Đang tính backtest lần đầu (khoảng 30–60 giây)…<br />
      <span style={{ color: '#475569' }}>Trang sẽ tự làm mới sau 1 phút. Bạn có thể tiếp tục xem dự đoán bình thường.</span>
    </div>
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

  // P0: CI95 and p-value badge for top10 accuracy
  const ci = accuracy.top10CI95
  const pVal = accuracy.top10PValueVsBaseline
  const isSig = accuracy.top10SignificantVsBaseline

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
          {/* P0: CI95 + significance badge — only shown for top10 */}
          {r.key === 'top10' && ci && (
            <div style={{
              marginTop: 6, padding: '5px 8px', borderRadius: 6,
              background: isSig ? 'rgba(52,211,153,0.07)' : 'rgba(248,113,113,0.07)',
              border: `1px solid ${isSig ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.25)'}`,
              fontSize: 10, lineHeight: 1.55,
            }}>
              <span style={{ color: isSig ? '#34d399' : '#f87171', fontWeight: 700 }}>
                {isSig ? '✓ Có ý nghĩa thống kê' : '⚠ Chưa có ý nghĩa thống kê'}
              </span>
              <span style={{ color: '#64748b', marginLeft: 6 }}>
                p={pVal} · 95% CI [{ci.lower}% – {ci.upper}%]
              </span>
              {!isSig && (
                <div style={{ color: '#475569', marginTop: 2 }}>
                  Margin nằm trong noise ({accuracy.top10}% vs baseline {baseline.top10}%). Đừng hiểu là "beat random" khi p &gt; 0.05.
                </div>
              )}
            </div>
          )}
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(100px,1fr))', gap: 8 }}>
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
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, minWidth: 360 }}>
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
              </div>
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
            {level === 'LOW' ? `Chưa đến lúc (${sinceLastTriple}/${expectedGap} kỳ)` : 'Đang tính…'}
          </div>
        )}
        {!aiConfirmed && (
          <div style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>Hoa lên top tự nhiên khi kỳ chưa về vượt mức trung bình.</div>
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

/* ─────────────────────── DrawPivotTable (lịch sử theo giờ) ─────────────── */
const DrawPivotTable = memo(function DrawPivotTable({ history, total }) {
  const [filter, setFilter] = useState('all')
  const [isMobile, setIsMobile] = useState((typeof window !== 'undefined') ? window.innerWidth < 720 : false)

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 720)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  if (!history || history.length === 0) return (
    <div style={{ color: '#475569', fontSize: 13, padding: '16px 0' }}>Không có dữ liệu</div>
  )

  // Use ACTUAL draw times from the crawl data as slot labels — no canonical snapping.
  // Rationale: xoso.net.vn timestamps are the publication time, which can be 1-6 minutes
  // after the canonical 06:05+6min schedule. Snapping to a fixed grid causes:
  //   (a) draws published near a slot boundary to collide → one gets silently dropped
  //   (b) the first draw found (newest-first) occupies the slot, later draws skipped
  // Dynamic slots use exact HH:MM from drawTime — every draw is visible, no collisions.
  const VN_OFF = 7 * 3600_000
  const bySlot = {}  // "HH:MM" → { "YYYY-MM-DD" → record }
  const dateSet = new Set()
  const slotSet = new Set()

  for (const r of history) {
    if (!r.drawTime) continue
    const vnMs = new Date(r.drawTime).getTime() + VN_OFF
    const vnD = new Date(vnMs)
    const h = vnD.getUTCHours(), m = vnD.getUTCMinutes()
    if (h < 6 || h >= 22) continue  // skip draws outside operating hours
    const slot = h.toString().padStart(2, '0') + ':' + m.toString().padStart(2, '0')
    const dateStr = vnD.getUTCFullYear() + '-' +
      (vnD.getUTCMonth() + 1).toString().padStart(2, '0') + '-' +
      vnD.getUTCDate().toString().padStart(2, '0')
    if (!bySlot[slot]) bySlot[slot] = {}
    if (!bySlot[slot][dateStr]) bySlot[slot][dateStr] = r
    dateSet.add(dateStr)
    slotSet.add(slot)
  }

  // ALL_SLOTS: all unique HH:MM values across history, sorted chronologically.
  // These are the actual published draw times — no hardcoded canonical grid.
  const ALL_SLOTS = [...slotSet].sort()

  // Up to 5 most-recent dates as columns, newest → oldest (left → right)
  const dates = [...dateSet].sort((a, b) => b.localeCompare(a)).slice(0, isMobile ? 3 : 5)

  // Use all 159 canonical slots, filtered by period.
  let slots = ALL_SLOTS
  if (filter === 'morning') slots = slots.filter(s => +s.slice(0, 2) < 12)
  if (filter === 'afternoon') slots = slots.filter(s => { const h = +s.slice(0, 2); return h >= 12 && h < 18 })
  if (filter === 'evening') slots = slots.filter(s => +s.slice(0, 2) >= 18)

  const DAY_VN = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
  function fmtDateHdr(ds) {
    const [y, mo, dd] = ds.split('-').map(Number)
    const day = new Date(Date.UTC(y, mo - 1, dd)).getUTCDay()
    return DAY_VN[day] + ' ' + dd + '/' + mo
  }

  function isTriple(r) { return r.n1 === r.n2 && r.n2 === r.n3 }
  function isPair(r) { return !isTriple(r) && (r.n1 === r.n2 || r.n2 === r.n3 || r.n1 === r.n3) }
  function getSum(r) { return r.sum != null ? r.sum : r.n1 + r.n2 + r.n3 }

  // Highlight flags for a given (slot, column-index) cell
  function getHL(slot, di) {
    const cur = bySlot[slot]?.[dates[di]]
    if (!cur) return {}
    const h = {}
    if (isTriple(cur)) h.triple = true
    else if (isPair(cur)) h.pair = true
    const curSum = getSum(cur)
    // Compare against immediate neighbours (previous and next column)
    for (const adj of [bySlot[slot]?.[dates[di - 1]], bySlot[slot]?.[dates[di + 1]]]) {
      if (!adj) continue
      if (getSum(adj) === curSum) h.sameSum = true
      if (isTriple(cur) && isTriple(adj)) h.sameTriple = true
      if (isPair(cur) && isPair(adj)) h.samePair = true
    }
    return h
  }

  function cellCS(h) { // background + box-shadow for the <td>
    if (h.sameTriple) return { background: 'rgba(251,191,36,0.28)', boxShadow: 'inset 0 0 0 2px rgba(251,191,36,0.65)' }
    if (h.triple) return { background: 'rgba(251,191,36,0.12)', boxShadow: 'inset 0 0 0 1px rgba(251,191,36,0.38)' }
    if (h.samePair) return { background: 'rgba(167,139,250,0.20)', boxShadow: 'inset 0 0 0 2px rgba(167,139,250,0.58)' }
    if (h.pair) return { background: 'rgba(125,211,252,0.10)', boxShadow: 'inset 0 0 0 1px rgba(125,211,252,0.28)' }
    if (h.sameSum) return { background: 'rgba(251,113,133,0.12)', boxShadow: 'inset 0 0 0 2px rgba(251,113,133,0.52)' }
    return { background: 'transparent', boxShadow: 'none' }
  }
  function ballColor(h) {
    return (h.sameTriple || h.triple) ? '#fbbf24' : (h.samePair || h.pair) ? '#7dd3fc' : '#c4b5fd'
  }
  function ballBg(h) {
    return (h.sameTriple || h.triple) ? 'rgba(251,191,36,0.22)' : (h.samePair || h.pair) ? 'rgba(125,211,252,0.18)' : 'rgba(99,102,241,0.18)'
  }
  function ballBorder(h) {
    return (h.sameTriple || h.triple) ? '1px solid rgba(251,191,36,0.45)' : (h.samePair || h.pair) ? '1px solid rgba(125,211,252,0.35)' : '1px solid rgba(99,102,241,0.30)'
  }

  // Footer summary per date column
  const colSum = dates.map(date => {
    let t = 0, p = 0, n = 0
    for (const slot of slots) {
      const r = bySlot[slot]?.[date]
      if (!r) continue
      if (isTriple(r)) t++; else if (isPair(r)) p++; else n++
    }
    return { t, p, n }
  })

  const TH = { padding: isMobile ? '6px 4px' : '8px 6px', textAlign: 'center', color: '#64748b', fontSize: isMobile ? 9 : 10, fontWeight: 700, letterSpacing: '0.05em', borderBottom: '1px solid rgba(255,255,255,0.08)', background: '#1e293b' }
  const ROW_BD = { borderBottom: '1px solid rgba(255,255,255,0.04)' }
  const BALL_SIZE = isMobile ? 18 : 21

  return (
    <div>
      {/* Filter buttons + legend */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['all', 'Tất cả'], ['morning', 'Sáng 6–12h'], ['afternoon', 'Chiều 12–18h'], ['evening', 'Tối 18–22h']].map(([v, l]) => (
          <button key={v} onClick={() => setFilter(v)} style={{
            background: filter === v ? 'rgba(99,102,241,0.22)' : 'rgba(255,255,255,0.04)',
            color: filter === v ? '#a5b4fc' : '#475569',
            border: filter === v ? '1px solid rgba(99,102,241,0.45)' : '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6, padding: isMobile ? '4px 9px' : '4px 11px', cursor: 'pointer', fontSize: isMobile ? 10 : 11,
          }}>{l}</button>
        ))}
        <span style={{ fontSize: isMobile ? 10 : 11, color: '#334155', marginLeft: 4 }}>{history.length} / {total.toLocaleString()} kỳ · 159 kỳ/ngày · {dates.length} ngày</span>
        <div style={{ marginLeft: isMobile ? 0 : 'auto', width: isMobile ? '100%' : 'auto', display: 'flex', gap: 10, fontSize: 10, color: '#64748b', flexWrap: 'wrap', alignItems: 'center' }}>
          {[['rgba(251,191,36,0.40)', 'HOA'], ['rgba(125,211,252,0.35)', 'Đôi'], ['rgba(251,113,133,0.35)', 'Same Tổng'], ['rgba(167,139,250,0.35)', 'Same Đôi']].map(([c, l]) => (
            <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ display: 'inline-block', width: 10, height: 10, background: c, borderRadius: 2 }} />{l}
            </span>
          ))}
        </div>
      </div>

      {/* Summary first (before detailed table) */}
      <div style={{ marginBottom: 10, overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, dates.length)}, minmax(${isMobile ? 120 : 160}px,1fr))`, gap: 8, minWidth: dates.length ? `${dates.length * (isMobile ? 120 : 160)}px` : 'auto' }}>
          {dates.map((d, i) => (
            <div key={d} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: isMobile ? '7px 8px' : '8px 10px' }}>
              <div style={{ fontSize: isMobile ? 10 : 11, color: '#64748b', marginBottom: 4, fontWeight: 700 }}>{fmtDateHdr(d)}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: isMobile ? 11 : 12 }}>
                <span style={{ color: '#fbbf24', fontWeight: 700 }}>HOA {colSum[i]?.t ?? 0}</span>
                <span style={{ color: '#7dd3fc', fontWeight: 700 }}>Đôi {colSum[i]?.p ?? 0}</span>
                <span style={{ color: '#94a3b8', fontWeight: 700 }}>Thường {colSum[i]?.n ?? 0}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Scrollable pivot table */}
      <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: isMobile ? 420 : 540 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ ...TH, textAlign: 'left', position: 'sticky', left: 0, zIndex: 3, minWidth: isMobile ? 44 : 52, padding: isMobile ? '6px 8px' : '8px 10px' }}>Giờ</th>
              {dates.map(d => <th key={d} style={{ ...TH, minWidth: isMobile ? 92 : 110 }}>{fmtDateHdr(d)}</th>)}
            </tr>
          </thead>
          <tbody>
            {slots.map(slot => {
              return (
                <tr key={slot}>
                  <td style={{ ...ROW_BD, padding: isMobile ? '4px 6px' : '4px 10px', color: '#475569', fontSize: isMobile ? 10 : 11, fontWeight: 700, position: 'sticky', left: 0, background: '#1e293b', zIndex: 1 }}>{slot}</td>
                  {dates.map((date, di) => {
                    const r = bySlot[slot]?.[date]
                    const h = r ? getHL(slot, di) : {}
                    const bc = ballColor(h), bbg = ballBg(h), bb = ballBorder(h)
                    return (
                      <td key={date} style={{ ...ROW_BD, padding: isMobile ? '3px 4px' : '4px 6px', textAlign: 'center', ...cellCS(h) }}>
                        {r ? (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                            {[r.n1, r.n2, r.n3].map((n, j) => (
                              <span key={j} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: BALL_SIZE, height: BALL_SIZE, background: bbg, border: bb, borderRadius: 5, fontWeight: 800, color: bc, fontSize: isMobile ? 10 : 11 }}>{n}</span>
                            ))}
                            <span style={{ fontSize: isMobile ? 9 : 10, color: '#475569', marginLeft: 2 }}>{getSum(r)}</span>
                          </div>
                        ) : (
                          <span style={{ color: '#1e3a5f', fontSize: 11 }}>—</span>
                        )}
                      </td>
                    )
                  })}
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
function NewDrawToast({ info, onDismiss, onRefresh }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 12_000)
    return () => clearTimeout(t)
  }, [info])

  if (!info) return null

  const handleRefresh = () => { onRefresh(); onDismiss() }

  return (
    <div style={{
      position: 'fixed', top: 18, right: 12, left: 12, zIndex: 9999,
      background: 'linear-gradient(135deg,#065f46,#047857)',
      color: '#ecfdf5', borderRadius: 12, padding: '14px 20px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      border: '1px solid rgba(52,211,153,0.4)',
      maxWidth: 340, width: 'min(340px, calc(100vw - 24px))', marginLeft: 'auto', animation: 'fadeIn 0.3s ease',
    }}>
      <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 4 }}>
        🎯 Kỳ mới! #{info.latestKy}
      </div>
      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 10 }}>
        +{info.added} kỳ vừa mở thưởng — nhấn để xem kết quả mới
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={handleRefresh} style={{
          flex: 1, background: 'rgba(52,211,153,0.25)', border: '1px solid rgba(52,211,153,0.5)',
          color: '#ecfdf5', borderRadius: 8, padding: '6px 0', cursor: 'pointer',
          fontSize: 12, fontWeight: 700,
        }}>↻ Cập nhật ngay</button>
        <button onClick={onDismiss} style={{
          background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)',
          color: '#ecfdf5', borderRadius: 8, padding: '6px 12px', cursor: 'pointer',
          fontSize: 12,
        }}>Bỏ qua</button>
      </div>
    </div>
  )
}

/* ─────────────────────────── SumPredPanel ─────────────────────────────── */
const SumPredPanel = memo(function SumPredPanel({ data }) {
  if (!data || !data.sums || data.sums.length === 0) return null
  const top5 = data.sums.slice(0, 5)
  const maxScore = top5[0]?.score || 1

  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 10, padding: '12px 14px', marginBottom: 12 }}>
      <div style={{ fontSize: 10, color: '#6366f1', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
        🎯 Dự đoán Sum (16 outcomes · Markov + z-score)
        <span style={{ color: '#475569', fontWeight: 400, textTransform: 'none', marginLeft: 8 }}>· sum trước: {data.prevSum} · {data.session}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {top5.map((s, i) => (
          <div key={s.sum} style={{
            flex: '1 1 80px', minWidth: 75, background: i === 0 ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${i === 0 ? 'rgba(99,102,241,0.4)' : 'rgba(255,255,255,0.08)'}`,
            borderRadius: 8, padding: '8px 10px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 22, fontWeight: 900, color: i === 0 ? '#a5b4fc' : '#e2e8f0' }}>{s.sum}</div>
            <div style={{ fontSize: 9, color: '#64748b', marginTop: 4 }}>
              z={s.z} · Mk {s.mkProb}%
            </div>
            <div style={{ fontSize: 9, color: s.z > 1 ? '#FF6B3D' : '#475569' }}>
              gap {s.curGap}{s.avgGap ? `/${s.avgGap}` : ''}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
})

/* ─────────────────────────── App ──────────────────────────────────────── */
function App() {
  const [preds, setPreds] = useState([])
  const [sumStats, setSumStats] = useState([])
  const [maxScore, setMaxScore] = useState(1)
  const [history, setHistory] = useState([])
  // Refs store cheap signatures instead of whole payloads.
  const predsRef = React.useRef('')
  const historyRef = React.useRef('')
  // ETag refs — store server ETag per endpoint and send If-None-Match on polls
  // so the server returns 304 when nothing changed → skip all state updates
  const predETagRef = React.useRef(null)
  const histETagRef = React.useRef(null)
  const overdueETagRef = React.useRef(null)
  const statsETagRef = React.useRef(null)
  const predictBasisRef = React.useRef(null)
  const basisFlashTimerRef = React.useRef(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [updated, setUpdated] = useState('—')
  const [toast, setToast] = useState(null)
  const [liveKy, setLiveKy] = useState(null)
  const [predictBasisKy, setPredictBasisKy] = useState(null)
  const [basisJustChanged, setBasisJustChanged] = useState(false)
  const [sseConnected, setSseConnected] = useState(false)
  const [stats, setStats] = useState(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [overdue, setOverdue] = useState(null)
  const [overdueLoading, setOverdueLoading] = useState(true)
  const [crawling, setCrawling] = useState(false)
  const [tripleSignal, setTripleSignal] = useState(null)
  const [modelContrib, setModelContrib] = useState(null)
  const [verdict, setVerdict] = useState(null)
  const [sumPreds, setSumPreds] = useState(null)

  // Bingo18 operating hours: 06:00–21:54 Vietnam time (UTC+7)
  const isNowOperating = () => {
    const vnMin = ((new Date().getUTCHours() + 7) % 24) * 60 + new Date().getUTCMinutes()
    return vnMin >= 360 && vnMin <= 1320
  }
  const [bingoClosed, setBingoClosed] = React.useState(!isNowOperating())

  const loadOverdue = useCallback(async () => {
    setOverdueLoading(true)
    try {
      const headers = overdueETagRef.current ? { 'If-None-Match': overdueETagRef.current } : {}
      const r = await fetch('/overdue', { cache: 'no-cache', headers })
      if (r.status !== 304) {
        const etag = r.headers.get('ETag')
        if (etag) overdueETagRef.current = etag
        setOverdue(await r.json())
      }
      // 304 → data unchanged, skip re-render
    } catch (_) { }
    setOverdueLoading(false)
  }, [])

  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    try {
      const headers = statsETagRef.current ? { 'If-None-Match': statsETagRef.current } : {}
      const r = await fetch('/stats', { cache: 'no-cache', headers })
      if (r.status !== 304) {
        const etag = r.headers.get('ETag')
        if (etag) statsETagRef.current = etag
        const s = await r.json()
        setStats(s)
        // Server is computing for the first time — auto-retry after 60s
        if (s?.computing) setTimeout(() => loadStatsRef.current(), 60_000)
      }
      // 304 → data unchanged, skip re-render
    } catch (_) { }
    setStatsLoading(false)
  }, [])

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const predH = predETagRef.current ? { 'If-None-Match': predETagRef.current } : {}
      const histH = histETagRef.current ? { 'If-None-Match': histETagRef.current } : {}
      const [pRaw, hRaw, sumRaw] = await Promise.all([
        fetch('/predict', { cache: 'no-cache', headers: predH }),
        fetch('/history?limit=800', { headers: histH }),
        fetch('/predict-sum', { cache: 'no-cache' }),
      ])

      // Both unchanged — nothing to do, skip all state updates
      if (pRaw.status === 304 && hRaw.status === 304) return

      if (pRaw.status !== 304 && !pRaw.ok) throw new Error(`API ${pRaw.status}`)

      const pRes = pRaw.status !== 304 ? await pRaw.json() : null
      const hRes = hRaw.status !== 304 ? await hRaw.json() : null

      if (pRes) {
        const etag = pRaw.headers.get('ETag')
        if (etag) predETagRef.current = etag
        const newPreds = pRes.next || []
        const nextBasisKy = pRes.latestKy || null
        const nextSig = predsSignature(newPreds, nextBasisKy || pRes.total)
        if (nextSig !== predsRef.current) {
          predsRef.current = nextSig
          setPreds(newPreds)
        }
        if (nextBasisKy && predictBasisRef.current && nextBasisKy !== predictBasisRef.current) {
          setBasisJustChanged(true)
          clearTimeout(basisFlashTimerRef.current)
          basisFlashTimerRef.current = setTimeout(() => setBasisJustChanged(false), 20_000)
        }
        predictBasisRef.current = nextBasisKy
        setMaxScore(pRes.maxScore || 1)
        setPredictBasisKy(nextBasisKy)
        setTripleSignal(pRes.tripleSignal || null)
        setModelContrib(pRes.modelContrib || null)
        setVerdict(pRes.verdict || null)
        setSumStats(pRes.sumStats || [])
        setTotal(pRes.total || 0)
        setUpdated(new Date().toLocaleTimeString('vi-VN'))
      }
      if (hRes) {
        const etag = hRaw.headers.get('ETag')
        if (etag) histETagRef.current = etag
        const newHistory = hRes.records || []
        const nextSig = historySignature(newHistory)
        if (nextSig !== historyRef.current) {
          historyRef.current = nextSig
          setHistory(newHistory)
        }
      }
      // Sum prediction response
      if (sumRaw.ok) {
        try { setSumPreds(await sumRaw.json()) } catch (_) { }
      }
    } catch (e) {
      setError(e.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])  // stable — ETag refs mutated in place, no closure deps needed

  // Use refs so SSE handler always calls latest version of load functions
  const loadRef = React.useRef(load)
  const loadStatsRef = React.useRef(loadStats)
  const loadOverdueRef = React.useRef(loadOverdue)
  useEffect(() => { loadRef.current = load }, [load])
  useEffect(() => { loadStatsRef.current = loadStats }, [loadStats])
  useEffect(() => { loadOverdueRef.current = loadOverdue }, [loadOverdue])
  useEffect(() => () => clearTimeout(basisFlashTimerRef.current), [])

  // ── SSE subscription ──────────────────────────────────────────────────
  useEffect(() => {
    let es
    let reconnectTimer
    let mounted = true
    let everConnected = false

    function connect() {
      if (!mounted) return
      setSseConnected(false)
      es = new EventSource('/events')

      es.onopen = () => {
        if (!mounted) return
        setSseConnected(true)
        if (everConnected) {
          // Reconnected after drop — might have missed a draw while offline.
          // Re-fetch without clearing ETags; server returns 304 if nothing changed, 200 if a new draw came in.
          loadRef.current(true)
        }
        everConnected = true
      }

      es.addEventListener('new-draw', e => {
        if (!mounted) return
        const info = JSON.parse(e.data)
        setLiveKy(info.latestKy)
        // Show toast only — user clicks "↻ Cập nhật ngay" to force-refresh.
        // Auto-rerender on every draw causes jarring mid-session updates;
        // the 60s polling is already a silent safety net.
        setToast(info)
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
      return vnMin >= 360 && vnMin <= 1320  // 06:00–22:00 VN
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
      <NewDrawToast info={toast} onDismiss={() => setToast(null)} onRefresh={() => {
        predETagRef.current = null
        histETagRef.current = null
        overdueETagRef.current = null
        statsETagRef.current = null
        loadRef.current(true)
        loadStatsRef.current()
        loadOverdueRef.current()
      }} />

      {/* ── Header ── */}
      <div style={C.header}>
        <div>
          <div style={C.logo}>📊 Bingo18 Analyzer</div>
          <div style={C.sub} className="hide-mobile">Phân tích thống kê combo · Realtime SSE · Walk-forward Backtest</div>
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
              try {
                const r = await fetch('/crawl', { method: 'POST', cache: 'no-store' })
                const j = await r.json().catch(() => ({}))
                if (!r.ok || j?.ok === false) throw new Error(j?.message || `API ${r.status}`)

                // Always force-refresh all views after manual crawl trigger.
                predETagRef.current = null
                histETagRef.current = null
                overdueETagRef.current = null
                statsETagRef.current = null

                await Promise.all([
                  loadRef.current(true),
                  loadStatsRef.current(),
                  loadOverdueRef.current(),
                ])
              } catch (e) {
                setError(e.message || 'Không thể cập nhật dữ liệu')
              } finally {
                setCrawling(false)
              }
            }}
            disabled={crawling || loading}>
            {crawling ? 'Đang tải…' : loading ? 'Loading…' : '⬇ Cập nhật'}
          </button>
        </div>
      </div>

      {/* ―― Disclaimer banner (sticky) ―― */}
      <div style={{ background: 'rgba(251,191,36,0.08)', borderBottom: '1px solid rgba(251,191,36,0.25)', padding: '8px 24px', textAlign: 'center', fontSize: 12, color: '#fbbf24', fontWeight: 600, position: 'sticky', top: 0, zIndex: 100, backdropFilter: 'blur(8px)' }}>
        ⚠️ Hệ thống này chọn combo đa dạng — không dự đoán kết quả. Bingo18 là trò chơi ngẫu nhiên (autocorr p=0.41).
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={C.label}>Top 10 Combo dự đoán</div>
              {updated !== '—' && (
                <span style={{ fontSize: 10, color: '#475569' }}>⟳ {updated}</span>
              )}
              {predictBasisKy && (
                <span style={{ fontSize: 10, color: '#94a3b8' }}>Dựa trên kỳ #{predictBasisKy}</span>
              )}
              {basisJustChanged && predictBasisKy && (
                <span style={{ fontSize: 10, color: '#34d399', border: '1px solid rgba(52,211,153,0.35)', background: 'rgba(52,211,153,0.08)', borderRadius: 999, padding: '3px 8px', fontWeight: 700 }}>
                  Đã nhận kỳ mới #{predictBasisKy}
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: '#475569' }} className="hide-mobile">
              % = tỷ lệ trong top-10 · X.Xx = số lần quá hạn so với kỳ vọng (1x = bình thường, &gt;1x = lâu chưa về)
            </div>
          </div>
          <TripleSignalCard signal={tripleSignal} anyTriple={overdue?.anyTriple} />
          <SumPredPanel data={sumPreds} />

          {/* P4: Effective model contribution bar */}
          {modelContrib && (
            <div style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 10,
              padding: '10px 14px',
              marginBottom: 12,
            }}>
              <div style={{ fontSize: 10, color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                {modelContrib._uniform ? '⚪ Chế độ: Diversity Selection' : 'Đóng góp model thực tế'}
                {modelContrib._uniform && (
                  <span style={{ marginLeft: 6, color: '#94a3b8', fontWeight: 400, textTransform: 'none' }}>
                    · không phát hiện pattern → chọn combo đa dạng, phân bổ đều
                  </span>
                )}
              </div>
              {!modelContrib._uniform ? (
                <div style={{ display: 'flex', gap: 2, height: 8, borderRadius: 4, overflow: 'hidden' }}>
                  {[
                    { key: 'stat', label: 'stat', color: '#818cf8' },
                    { key: 'mk2', label: 'mk2', color: '#34d399' },
                    { key: 'sess', label: 'sess', color: '#fb923c' },
                    { key: 'knn', label: 'knn', color: '#a78bfa' },
                    { key: 'gbm', label: 'gbm', color: '#60a5fa' },
                  ].filter(m => (modelContrib[m.key] ?? 0) > 0).map(m => (
                    <div key={m.key} title={`${m.label}: ${modelContrib[m.key]}%`}
                      style={{ width: `${modelContrib[m.key]}%`, background: m.color, minWidth: modelContrib[m.key] > 0 ? 2 : 0 }} />
                  ))}
                </div>
              ) : (
                <div style={{ height: 8, borderRadius: 4, background: 'repeating-linear-gradient(45deg,#334155,#334155 4px,#1e293b 4px,#1e293b 8px)' }} />
              )}
              {!modelContrib._uniform && (
                <div style={{ display: 'flex', gap: 10, marginTop: 5, flexWrap: 'wrap' }}>
                  {[
                    { key: 'stat', label: 'stat (z-score)', color: '#818cf8' },
                    { key: 'mk2', label: 'mk2 (Markov)', color: '#34d399' },
                    { key: 'sess', label: 'sess', color: '#fb923c' },
                    { key: 'knn', label: 'knn', color: '#a78bfa' },
                    { key: 'gbm', label: 'gbm', color: '#60a5fa' },
                  ].filter(m => (modelContrib[m.key] ?? 0) > 0).map(m => (
                    <span key={m.key} style={{ fontSize: 10, color: m.color }}>
                      {m.label} {modelContrib[m.key]}%
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="grid3">
            {preds.length === 0 && !loading && (
              <div style={{ color: '#64748b', fontSize: 13 }}>Chưa có dự đoán.</div>
            )}
            {preds.map((p, i) => (
              <PredCard key={`${predictBasisKy || 'base'}:${p.combo}`} combo={p.combo} pct={p.pct} rank={i}
                maxPct={maxPct} score={p.score} maxScore={maxScore}
                overdueRatio={p.overdueRatio} comboGap={p.comboGap ?? 0}
                pat={p.pat} stability={p.stability}
                zScore={p.zScore} statNorm={p.statNorm ?? p.coreNorm}
                mk2Norm={p.mk2Norm} sessNorm={p.sessNorm}
                confidence={p.confidence} calBuckets={stats?.calBuckets}
                isUniform={!!modelContrib?._uniform} />
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

        {/* ── Daily schedule pivot table (replaces flat history list) ── */}
        <div style={{ ...C.card, marginBottom: 28 }}>
          <div style={{ ...C.label, marginBottom: 14 }}>
            Lịch sử theo giờ
            <span style={{ fontWeight: 400, textTransform: 'none', color: '#475569', marginLeft: 8 }}>
              (hiển thị {history.length.toLocaleString()} / {total.toLocaleString()} kỳ)
            </span>
          </div>
          <DrawPivotTable history={history} total={total} />
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

        {/* ── Accuracy (all screens) ── */}
        <div style={{ ...C.card, marginBottom: 28 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16, flexWrap: 'wrap', gap: 6 }}>
            <div style={C.label}>Độ chính xác dự đoán</div>
            <div style={{ fontSize: 11, color: '#475569' }} className="hide-mobile">Walk-forward backtest — huấn luyện trên data quá khứ, kiểm tra trên kỳ tiếp theo</div>
          </div>
          <AccuracyPanel stats={stats} loading={statsLoading} />
        </div>
        {/* ── Heatmap (desktop only — canvas layout doesn't adapt to small screens) ── */}
        <div className="hide-mobile" style={{ ...C.card, marginBottom: 28 }}>
          <Heatmap history={history} />
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
