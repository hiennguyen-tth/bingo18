/**
 * web/app.jsx
 * Bingo18 AI Dashboard — React 18 / Babel Standalone
 * Served via Express static at http://localhost:3000/
 */
const {
  useState,
  useEffect,
  useCallback,
  memo
} = React;
const Heatmap = window.Heatmap; // defined in heatmap.jsx (loaded first)

/** Format ISO draw time → "HH:mm dd/MM/yyyy" */
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const hh = d.getHours().toString().padStart(2, '0');
  const mi = d.getMinutes().toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  const mo = (d.getMonth() + 1).toString().padStart(2, '0');
  const yy = d.getFullYear();
  return `${hh}:${mi} ${dd}/${mo}/${yy}`;
}
function predsSignature(preds) {
  return preds.map(p => `${p.combo}:${p.score}:${p.confidence}`).join('|');
}
function historySignature(records) {
  if (!records || records.length === 0) return '0';
  return `${records.length}:${records[0]?.ky || '0'}`;
}

/* ─────────────────────────── Styles ───────────────────────────────────── */
const C = {
  app: {
    minHeight: '100vh',
    background: '#0f172a',
    color: '#e2e8f0',
    fontFamily: 'system-ui,-apple-system,sans-serif'
  },
  header: {
    background: 'linear-gradient(135deg,#1e1b4b 0%,#312e81 100%)',
    padding: '18px 28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottom: '1px solid rgba(99,102,241,0.3)',
    flexWrap: 'wrap',
    gap: 12
  },
  logo: {
    fontSize: 22,
    fontWeight: 800,
    color: '#a5b4fc',
    letterSpacing: '-0.5px'
  },
  sub: {
    fontSize: 12,
    color: '#6366f1',
    marginTop: 2
  },
  pill: {
    fontSize: 11,
    background: 'rgba(99,102,241,0.2)',
    color: '#a5b4fc',
    padding: '4px 12px',
    borderRadius: 20,
    border: '1px solid rgba(99,102,241,0.4)'
  },
  main: {
    maxWidth: 1120,
    margin: '0 auto',
    padding: '28px 20px'
  },
  mainMobile: {
    maxWidth: 1120,
    margin: '0 auto',
    padding: '16px 12px'
  },
  sec: {
    marginBottom: 28
  },
  label: {
    fontSize: 11,
    fontWeight: 700,
    color: '#6366f1',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: 14
  },
  card: {
    background: '#1e293b',
    borderRadius: 12,
    padding: '22px 24px',
    border: '1px solid rgba(255,255,255,0.06)'
  },
  grid3: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))',
    gap: 10
  },
  grid2: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 16
  },
  warn: {
    borderRadius: 8,
    padding: '11px 16px',
    marginBottom: 16,
    fontSize: 13
  },
  tag: {
    display: 'inline-block',
    fontSize: 10,
    padding: '2px 8px',
    borderRadius: 10,
    fontWeight: 700
  },
  btn: {
    background: '#6366f1',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '7px 18px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    transition: 'opacity 0.15s'
  }
};

/* ─────────────────────────── PredCard ─────────────────────────────────── */
function getRankingBadge(normScore) {
  if (normScore >= 85) return {
    label: '🔥 HOT',
    color: '#FF6B3D',
    bg: 'rgba(255,107,61,0.18)',
    border: 'rgba(255,107,61,0.5)'
  };
  if (normScore >= 70) return {
    label: '⭐ STRONG',
    color: '#FFC857',
    bg: 'rgba(255,200,87,0.15)',
    border: 'rgba(255,200,87,0.45)'
  };
  if (normScore >= 55) return {
    label: '👍 GOOD',
    color: '#4CC9F0',
    bg: 'rgba(76,201,240,0.13)',
    border: 'rgba(76,201,240,0.4)'
  };
  if (normScore >= 40) return {
    label: '⚠️ WEAK',
    color: '#9D8DF1',
    bg: 'rgba(157,141,241,0.13)',
    border: 'rgba(157,141,241,0.4)'
  };
  return {
    label: '❄️ COLD',
    color: '#6B7280',
    bg: 'rgba(107,114,128,0.12)',
    border: 'rgba(107,114,128,0.35)'
  };
}
const PredCard = memo(function PredCard({
  combo,
  pct,
  rank,
  maxPct,
  score,
  maxScore,
  overdueRatio,
  comboGap,
  pat,
  stability,
  zScore,
  statNorm,
  mk2Norm,
  sessNorm,
  confidence: confFromServer,
  calBuckets,
  isUniform
}) {
  const nums = combo.split('-');
  const normScore = maxScore > 0 ? Math.round(score / maxScore * 100) : 0;
  const badge = getRankingBadge(normScore);
  // Use server-computed confidence (35–80% range, varies by score spread)
  // Falls back to rank-based estimate if not provided
  const confidence = confFromServer != null ? confFromServer : Math.max(35, Math.round(80 - rank * 4.5));
  // Calibrated hit rate at this rank position from walk-forward backtest
  const calHitPct = calBuckets ? calBuckets.find(b => b.rank === rank + 1)?.hitPct : null;
  const patLabel = {
    triple: '♦ Triple',
    pair: '◆ Pair',
    normal: '◇ Normal'
  }[pat] || pat || '◇ Normal';
  const patColor = {
    triple: '#c4b5fd',
    pair: '#7dd3fc',
    normal: '#94a3b8'
  }[pat] || '#94a3b8';
  const patBg = {
    triple: 'rgba(139,92,246,0.15)',
    pair: 'rgba(59,130,246,0.12)',
    normal: 'rgba(255,255,255,0.03)'
  }[pat] || 'rgba(255,255,255,0.03)';
  const numColor = {
    triple: '#c4b5fd',
    pair: '#7dd3fc',
    normal: '#f1f5f9'
  }[pat] || '#f1f5f9';
  const rankColor = ['#fbbf24', '#94a3b8', '#cd7c3a'];
  const barW = maxPct > 0 ? pct / maxPct * 100 : 0;

  // z-score display (gap-based z — positive = overdue = interesting)
  const zColor = zScore == null ? '#64748b' : zScore > 2.0 ? '#FF6B3D' : zScore > 1.0 ? '#FFC857' : '#94a3b8';
  const zLabel = zScore != null ? zScore.toFixed(2) : 'N/A';

  // 3-model breakdown bar (v4: stat / mk2 / sess)
  const breakdownModels = [{
    label: 'stat',
    val: statNorm ?? 0,
    color: '#818cf8'
  }, {
    label: 'mk2',
    val: mk2Norm ?? 0,
    color: '#34d399'
  }, {
    label: 'sess',
    val: sessNorm ?? 0,
    color: '#fb923c'
  }];
  const breakTotal = breakdownModels.reduce((s, m) => s + m.val, 0) || 1;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: patBg,
      border: `1px solid ${badge.border}`,
      borderRadius: 12,
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: 800,
      letterSpacing: '0.04em',
      color: badge.color,
      background: badge.bg,
      padding: '3px 10px',
      borderRadius: 20,
      border: `1px solid ${badge.border}`
    }
  }, badge.label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 15,
      fontWeight: 900,
      color: rank < 3 ? rankColor[rank] : '#475569'
    }
  }, "#", rank + 1)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 28,
      fontWeight: 900,
      letterSpacing: 6,
      color: numColor,
      textAlign: 'center',
      fontVariantNumeric: 'tabular-nums',
      lineHeight: 1
    }
  }, nums.join(' ')), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '4px 8px',
      fontSize: 11
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#64748b'
    }
  }, "z-score"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: zColor,
      textAlign: 'right',
      fontWeight: 700
    }
  }, zLabel), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#64748b'
    }
  }, "pattern"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: patColor,
      textAlign: 'right',
      fontWeight: 600
    }
  }, patLabel), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#64748b'
    }
  }, "stability"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#e2e8f0',
      textAlign: 'right',
      fontWeight: 700
    }
  }, stability != null ? stability.toFixed(2) : '—'), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#64748b'
    }
  }, "share"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#a5b4fc',
      textAlign: 'right',
      fontWeight: 700
    }
  }, pct, "%")), isUniform ?
  /*#__PURE__*/
  // When all pattern-models are disabled (no_pattern → shrink=0), scores are
  // uniform. The breakdown bar would show raw z-rank, not actual contribution.
  // Show z-overdue context instead — the only meaningful per-combo signal.
  React.createElement("div", {
    style: {
      fontSize: 9,
      color: '#475569',
      display: 'flex',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#334155'
    }
  }, "portfolio diversity \xB7 ch\u1ECDn theo digit coverage"), zScore != null && zScore > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      color: zColor,
      fontWeight: 700
    }
  }, "z+", zScore.toFixed(2), " overdue")) : /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 9,
      color: '#475569',
      marginBottom: 3
    }
  }, breakdownModels.map(m => /*#__PURE__*/React.createElement("span", {
    key: m.label,
    style: {
      color: m.color
    }
  }, m.label, " ", (m.val / breakTotal * 100).toFixed(0), "%"))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 4,
      background: 'rgba(255,255,255,0.05)',
      borderRadius: 2,
      display: 'flex',
      overflow: 'hidden'
    }
  }, breakdownModels.map(m => /*#__PURE__*/React.createElement("div", {
    key: m.label,
    style: {
      width: `${m.val / breakTotal * 100}%`,
      height: '100%',
      background: m.color,
      opacity: 0.85,
      transition: 'width 0.6s ease'
    }
  })))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 10,
      color: '#64748b',
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("span", null, "confidence", calHitPct != null ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#475569',
      fontWeight: 400
    }
  }, " \xB7 l\u1ECBch s\u1EED: ", calHitPct, "%") : ''), /*#__PURE__*/React.createElement("span", {
    style: {
      color: badge.color,
      fontWeight: 700
    }
  }, confidence, "%")), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 5,
      background: 'rgba(255,255,255,0.06)',
      borderRadius: 3,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${confidence}%`,
      height: '100%',
      background: `linear-gradient(90deg,${badge.color}88,${badge.color})`,
      borderRadius: 3,
      transition: 'width 0.6s ease'
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 3,
      background: 'rgba(255,255,255,0.05)',
      borderRadius: 2,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${barW}%`,
      height: '100%',
      background: pat === 'triple' ? 'linear-gradient(90deg,#7c3aed,#a78bfa)' : pat === 'pair' ? 'linear-gradient(90deg,#1d4ed8,#60a5fa)' : 'linear-gradient(90deg,#4f46e5,#818cf8)',
      borderRadius: 2,
      transition: 'width 0.6s ease'
    }
  })));
});

/* ─────────────────────────── SumBar ───────────────────────────────────── */
const SumBar = memo(function SumBar({
  sum,
  pct,
  maxPct
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 12,
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      color: '#e2e8f0'
    }
  }, "Sum ", sum), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#94a3b8'
    }
  }, pct, "%")), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 6,
      background: 'rgba(255,255,255,0.06)',
      borderRadius: 3,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${maxPct > 0 ? pct / maxPct * 100 : 0}%`,
      height: '100%',
      background: 'linear-gradient(90deg,#6366f1,#818cf8)',
      borderRadius: 3,
      transition: 'width 0.6s ease'
    }
  })));
});

/* ─────────────────────────── PatternTag ───────────────────────────────── */
const PatTag = memo(function PatTag({
  pat
}) {
  const s = {
    triple: {
      background: 'rgba(139,92,246,0.3)',
      color: '#c4b5fd'
    },
    pair: {
      background: 'rgba(59,130,246,0.25)',
      color: '#7dd3fc'
    },
    normal: {
      background: 'rgba(255,255,255,0.06)',
      color: '#94a3b8'
    }
  }[pat] || {
    background: 'rgba(255,255,255,0.06)',
    color: '#94a3b8'
  };
  return /*#__PURE__*/React.createElement("span", {
    style: {
      ...C.tag,
      ...s
    }
  }, pat || 'normal');
});

/* ─────────────────────────── AccuracyPanel ─────────────────────────────── */
const AccuracyPanel = memo(function AccuracyPanel({
  stats,
  loading
}) {
  const [showReality, setShowReality] = React.useState(false);
  if (loading) return /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#475569',
      fontSize: 13,
      padding: '20px 0'
    }
  }, "\u0110ang t\u1EA3i\u2026");
  // Server is computing backtest for the first time — show message, not infinite spinner
  if (stats?.computing) return /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#fbbf24',
      fontSize: 12,
      lineHeight: 1.8,
      padding: '8px 0'
    }
  }, "\u23F3 \u0110ang t\xEDnh backtest l\u1EA7n \u0111\u1EA7u (kho\u1EA3ng 30\u201360 gi\xE2y)\u2026", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#475569'
    }
  }, "Trang s\u1EBD t\u1EF1 l\xE0m m\u1EDBi sau 1 ph\xFAt. B\u1EA1n c\xF3 th\u1EC3 ti\u1EBFp t\u1EE5c xem d\u1EF1 \u0111o\xE1n b\xECnh th\u01B0\u1EDDng."));
  if (!stats || stats.message || stats.error || !stats.accuracy) return /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#fcd34d',
      fontSize: 12,
      lineHeight: 1.6
    }
  }, "C\u1EA7n th\xEAm d\u1EEF li\u1EC7u \u0111\u1EC3 t\xEDnh ch\xEDnh x\xE1c.", /*#__PURE__*/React.createElement("br", null), "Hi\u1EC7n c\xF3: ", stats?.total || 0, " k\u1EF3, c\u1EA7n \xEDt nh\u1EA5t 12 k\u1EF3.");
  const {
    accuracy,
    hits,
    tested,
    baseline,
    segments,
    statTests
  } = stats;
  const rows = [{
    label: 'Top 1',
    key: 'top1',
    desc: 'đoán đúng combo #1',
    color: '#fbbf24'
  }, {
    label: 'Top 3',
    key: 'top3',
    desc: 'combo nằm trong top 3',
    color: '#60a5fa'
  }, {
    label: 'Top 10',
    key: 'top10',
    desc: 'combo nằm trong top 10',
    color: '#34d399'
  }];
  const vsBase = (acc, base) => {
    const diff = (acc - base).toFixed(2);
    const better = diff > 0;
    return /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        color: better ? '#34d399' : '#f87171',
        marginLeft: 6
      }
    }, better ? '▲' : '▼', " ", Math.abs(diff), "% vs random");
  };

  // P0: CI95 and p-value badge for top10 accuracy
  const ci = accuracy.top10CI95;
  const pVal = accuracy.top10PValueVsBaseline;
  const isSig = accuracy.top10SignificantVsBaseline;

  // Reality check rendering
  const verdictMeta = statTests && {
    no_pattern: {
      label: 'Không phát hiện pattern',
      color: '#34d399',
      icon: '✓'
    },
    weak_pattern: {
      label: 'Có thể có pattern yếu',
      color: '#fbbf24',
      icon: '⚠'
    },
    pattern_detected: {
      label: 'Phát hiện pattern có ý nghĩa',
      color: '#f87171',
      icon: '!'
    }
  }[statTests.verdict];
  const pCell = p => {
    if (p == null) return /*#__PURE__*/React.createElement("span", {
      style: {
        color: '#475569'
      }
    }, "\u2014");
    const sig = p < 0.05;
    return /*#__PURE__*/React.createElement("span", {
      style: {
        color: sig ? '#f87171' : '#34d399',
        fontWeight: sig ? 700 : 400
      }
    }, p);
  };

  // Segment overfit indicator: compare train top10 vs forward top10
  const overfit = segments && segments.train && segments.forward ? +(segments.train.top10 - segments.forward.top10).toFixed(2) : null;
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#475569',
      marginBottom: 16
    }
  }, "Walk-forward test tr\xEAn ", /*#__PURE__*/React.createElement("strong", {
    style: {
      color: '#e2e8f0'
    }
  }, tested), " k\u1EF3 \xA0\xB7\xA0Random baseline: top1=", baseline.top1, "% / top3=", baseline.top3, "% / top10=", baseline.top10, "%"), rows.map(r => /*#__PURE__*/React.createElement("div", {
    key: r.key,
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontSize: 12,
      marginBottom: 5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      color: '#e2e8f0'
    }
  }, r.label, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 400,
      color: '#64748b',
      marginLeft: 8
    }
  }, r.desc)), /*#__PURE__*/React.createElement("span", {
    style: {
      color: r.color,
      fontWeight: 800
    }
  }, accuracy[r.key], "%", vsBase(accuracy[r.key], baseline[r.key]))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 8,
      background: 'rgba(255,255,255,0.06)',
      borderRadius: 4,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${Math.min(accuracy[r.key], 100)}%`,
      height: '100%',
      background: r.color,
      borderRadius: 4,
      transition: 'width 0.8s ease',
      boxShadow: `0 0 8px ${r.color}55`
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#475569',
      marginTop: 3
    }
  }, "\u0110\xFAng ", hits[r.key], "/", tested, " k\u1EF3"), r.key === 'top10' && ci && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      padding: '5px 8px',
      borderRadius: 6,
      background: isSig ? 'rgba(52,211,153,0.07)' : 'rgba(248,113,113,0.07)',
      border: `1px solid ${isSig ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.25)'}`,
      fontSize: 10,
      lineHeight: 1.55
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: isSig ? '#34d399' : '#f87171',
      fontWeight: 700
    }
  }, isSig ? '✓ Có ý nghĩa thống kê' : '⚠ Chưa có ý nghĩa thống kê'), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#64748b',
      marginLeft: 6
    }
  }, "p=", pVal, " \xB7 95% CI [", ci.lower, "% \u2013 ", ci.upper, "%]"), !isSig && /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#475569',
      marginTop: 2
    }
  }, "Margin n\u1EB1m trong noise (", accuracy.top10, "% vs baseline ", baseline.top10, "%). \u0110\u1EEBng hi\u1EC3u l\xE0 \"beat random\" khi p > 0.05.")))), segments && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 18,
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#64748b',
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      marginBottom: 8
    }
  }, "Overfitting check \u2014 Train / Valid / Forward", overfit !== null && /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 8,
      color: overfit > 1 ? '#f87171' : '#34d399',
      fontWeight: 400
    }
  }, "(train\u2212forward top10: ", overfit > 0 ? '+' : '', overfit, "%)")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit,minmax(100px,1fr))',
      gap: 8
    }
  }, [{
    key: 'train',
    label: 'Train (60%)',
    color: '#60a5fa'
  }, {
    key: 'valid',
    label: 'Valid (20%)',
    color: '#a78bfa'
  }, {
    key: 'forward',
    label: 'Forward (20%)',
    color: '#34d399'
  }].map(({
    key,
    label,
    color
  }) => {
    const s = segments[key];
    if (!s) return null;
    return /*#__PURE__*/React.createElement("div", {
      key: key,
      style: {
        background: 'rgba(255,255,255,0.04)',
        borderRadius: 8,
        padding: '8px 10px'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color,
        fontWeight: 700,
        marginBottom: 4
      }
    }, label), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: '#e2e8f0'
      }
    }, "Top10: ", /*#__PURE__*/React.createElement("strong", null, s.top10, "%")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: '#64748b'
      }
    }, "Top1: ", s.top1, "% \xB7 ", s.tested, "k\u1EF3"));
  }))), statTests && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowReality(v => !v),
    style: {
      background: 'none',
      border: `1px solid ${verdictMeta.color}44`,
      borderRadius: 6,
      padding: '5px 10px',
      cursor: 'pointer',
      color: verdictMeta.color,
      fontSize: 11,
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", null, verdictMeta.icon), /*#__PURE__*/React.createElement("span", null, "Reality Check: ", verdictMeta.label), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      opacity: 0.6
    }
  }, showReality ? '▲' : '▼')), showReality && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      fontSize: 11,
      background: 'rgba(255,255,255,0.03)',
      borderRadius: 8,
      padding: '10px 12px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#64748b',
      marginBottom: 8
    }
  }, "p < 0.05 = c\xF3 \xFD ngh\u0129a th\u1ED1ng k\xEA (reject H0). N\u1EBFu t\u1EA5t c\u1EA3 p > 0.05 \u2192 game random \u2192 model A/B/D c\xF3 th\u1EC3 ch\u1EC9 fit noise."), /*#__PURE__*/React.createElement("div", {
    style: {
      overflowX: 'auto'
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 11,
      minWidth: 360
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, ['Test', 'Stat', 'p-value', 'Ý nghĩa'].map(h => /*#__PURE__*/React.createElement("th", {
    key: h,
    style: {
      textAlign: 'left',
      color: '#475569',
      fontWeight: 600,
      paddingBottom: 6,
      borderBottom: '1px solid rgba(255,255,255,0.06)'
    }
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    style: {
      color: '#e2e8f0',
      paddingTop: 6,
      paddingRight: 8
    }
  }, "Chi-square"), /*#__PURE__*/React.createElement("td", {
    style: {
      color: '#94a3b8',
      paddingRight: 8
    }
  }, statTests.chiSquare.stat ?? '—'), /*#__PURE__*/React.createElement("td", null, pCell(statTests.chiSquare.pValue)), /*#__PURE__*/React.createElement("td", {
    style: {
      color: '#475569'
    }
  }, "T\u1EA7n su\u1EA5t combo ph\u1EB3ng?")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    style: {
      color: '#e2e8f0',
      paddingTop: 4,
      paddingRight: 8
    }
  }, "Autocorr"), /*#__PURE__*/React.createElement("td", {
    style: {
      color: '#94a3b8',
      paddingRight: 8
    }
  }, statTests.autocorr.r ?? '—'), /*#__PURE__*/React.createElement("td", null, pCell(statTests.autocorr.pValue)), /*#__PURE__*/React.createElement("td", {
    style: {
      color: '#475569'
    }
  }, "Sum li\xEAn ti\u1EBFp t\u01B0\u01A1ng quan?")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    style: {
      color: '#e2e8f0',
      paddingTop: 4,
      paddingRight: 8
    }
  }, "Runs"), /*#__PURE__*/React.createElement("td", {
    style: {
      color: '#94a3b8',
      paddingRight: 8
    }
  }, statTests.runs.runs ?? '—'), /*#__PURE__*/React.createElement("td", null, pCell(statTests.runs.pValue)), /*#__PURE__*/React.createElement("td", {
    style: {
      color: '#475569'
    }
  }, "Chu\u1ED7i tr\xEAn/d\u01B0\u1EDBi trung v\u1ECB ng\u1EABu nhi\xEAn?"))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      color: '#475569',
      fontSize: 10,
      lineHeight: 1.5
    }
  }, "* \xDD ngh\u0129a th\u1ED1ng k\xEA \u2260 kh\u1EA3 n\u0103ng d\u1EF1 \u0111o\xE1n. Chi-square c\xF3 th\u1EC3 reject H0 ch\u1EC9 v\xEC t\u1EA7n su\u1EA5t kh\xF4ng ho\xE0n to\xE0n ph\u1EB3ng, kh\xF4ng c\xF3 ngh\u0129a l\xE0 combo c\u1EE5 th\u1EC3 n\xE0o c\xF3 th\u1EC3 d\u1EF1 \u0111o\xE1n \u0111\u01B0\u1EE3c."))));
});

/* ─────────────────────────── TripleSignalCard ──────────────────────────── */
const TripleSignalCard = memo(function TripleSignalCard({
  signal,
  anyTriple
}) {
  if (!signal) return null;
  const {
    sinceLastTriple,
    expectedGap,
    avgGap,
    overdueRatio,
    boostMult,
    hotTriples,
    verdict,
    aiConfirmed
  } = signal;
  const level = overdueRatio >= 2 ? 'HIGH' : overdueRatio >= 1 ? 'MED' : 'LOW';
  const levelColor = {
    HIGH: '#f87171',
    MED: '#fbbf24',
    LOW: '#34d399'
  }[level];
  const levelBg = {
    HIGH: 'rgba(248,113,113,0.08)',
    MED: 'rgba(251,191,36,0.08)',
    LOW: 'rgba(52,211,153,0.06)'
  }[level];
  const barW = Math.min(100, overdueRatio / 3 * 100);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: levelBg,
      border: `1px solid ${levelColor}44`,
      borderRadius: 12,
      padding: '12px 16px',
      marginBottom: 16,
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
      gap: '10px 20px',
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#64748b',
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      marginBottom: 6
    }
  }, "\uD83C\uDFB2 T\xEDn hi\u1EC7u hoa (xxx)"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 22,
      fontWeight: 900,
      color: levelColor
    }
  }, overdueRatio.toFixed(2), "x"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: '#64748b'
    }
  }, "qu\xE1 h\u1EA1n")), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 5,
      background: 'rgba(255,255,255,0.06)',
      borderRadius: 3,
      overflow: 'hidden',
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${barW}%`,
      height: '100%',
      background: levelColor,
      borderRadius: 3,
      transition: 'width 0.6s ease'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#64748b'
    }
  }, "Ch\u01B0a ra: ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: levelColor,
      fontWeight: 700
    }
  }, sinceLastTriple), " k\u1EF3 \xA0\xB7\xA0TB: ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#e2e8f0'
    }
  }, avgGap), " k\u1EF3/l\u1EA7n")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#64748b',
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      marginBottom: 6
    }
  }, "\uD83D\uDCCA Th\u1ED1ng k\xEA xxx"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '3px 8px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#64748b'
    }
  }, "T\u1ED5ng l\u1EA7n ra"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#e2e8f0',
      fontWeight: 700
    }
  }, anyTriple?.appeared ?? '—'), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#64748b'
    }
  }, "TB m\u1ED7i k\u1EF3"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#e2e8f0',
      fontWeight: 700
    }
  }, anyTriple?.avgInterval ?? avgGap, "ky"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#64748b'
    }
  }, "Boost hi\u1EC7n t\u1EA1i"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: boostMult >= 1.3 ? '#f87171' : '#fbbf24',
      fontWeight: 700
    }
  }, boostMult, "\xD7"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#64748b',
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      marginBottom: 6
    }
  }, level === 'HIGH' ? '🔥 Hoa khả năng cao' : '💡 Hoa tiềm năng'), hotTriples && hotTriples.length > 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      flexWrap: 'wrap'
    }
  }, hotTriples.map((combo, i) => {
    const [n] = combo.split('-');
    return /*#__PURE__*/React.createElement("div", {
      key: combo,
      style: {
        background: i === 0 ? 'rgba(196,181,253,0.15)' : 'rgba(255,255,255,0.05)',
        border: `1px solid ${i === 0 ? 'rgba(196,181,253,0.4)' : 'rgba(255,255,255,0.1)'}`,
        borderRadius: 8,
        padding: '4px 10px',
        fontSize: 16,
        fontWeight: 900,
        color: i === 0 ? '#c4b5fd' : '#94a3b8',
        letterSpacing: 2
      }
    }, n, n, n);
  })) : /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: '#475569'
    }
  }, level === 'LOW' ? `Chưa đến lúc (${sinceLastTriple}/${expectedGap} kỳ)` : 'Đang tính…'), !aiConfirmed && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#475569',
      marginTop: 4
    }
  }, "Hoa l\xEAn top t\u1EF1 nhi\xEAn khi k\u1EF3 ch\u01B0a v\u1EC1 v\u01B0\u1EE3t m\u1EE9c trung b\xECnh."), level === 'LOW' && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#475569',
      marginTop: 4
    }
  }, "Kh\u1EA3 n\u0103ng ra hoa ch\u01B0a cao, ch\u1EDD th\xEAm ", Math.round(expectedGap - sinceLastTriple), " k\u1EF3")));
});

/* ─────────────────────────── OverdueTable ─────────────────────────────── */
const OverdueTable = memo(function OverdueTable({
  items,
  loading,
  title
}) {
  if (loading) return /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#475569',
      fontSize: 13,
      padding: '16px 0'
    }
  }, "\u0110ang t\xEDnh\u2026");
  if (!items || items.length === 0) return /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#475569',
      fontSize: 13,
      padding: '16px 0'
    }
  }, "Kh\xF4ng c\xF3 d\u1EEF li\u1EC7u");
  const maxScore = Math.max(...items.map(x => x.overdueScore || 0), 1);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 24
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...C.label,
      marginBottom: 12
    }
  }, title), /*#__PURE__*/React.createElement("div", {
    style: {
      overflowX: 'auto'
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    style: {
      borderBottom: '1px solid rgba(255,255,255,0.08)'
    }
  }, ['Giá trị', 'Số lần', 'Kỳ chưa về', 'TB mỗi kỳ', 'Quá hạn'].map(h => /*#__PURE__*/React.createElement("th", {
    key: h,
    style: {
      padding: '8px 12px',
      textAlign: 'left',
      color: '#64748b',
      fontSize: 10,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.06em'
    }
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, items.map((row, i) => {
    const overdue = row.overdueScore >= 1;
    const barW = Math.min(row.overdueScore / maxScore * 100, 100);
    const barColor = row.overdueScore >= 2 ? '#f87171' : row.overdueScore >= 1 ? '#fbbf24' : '#4f46e5';
    return /*#__PURE__*/React.createElement("tr", {
      key: row.key,
      style: {
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        background: overdue ? 'rgba(251,191,36,0.04)' : 'transparent'
      }
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '8px 12px',
        fontWeight: 700,
        color: overdue ? '#fbbf24' : '#e2e8f0'
      }
    }, row.label), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '8px 12px',
        color: '#94a3b8'
      }
    }, row.appeared), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '8px 12px',
        color: overdue ? '#f87171' : '#94a3b8',
        fontWeight: overdue ? 700 : 400
      }
    }, row.kySinceLast ?? '—'), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '8px 12px',
        color: '#94a3b8'
      }
    }, typeof row.avgInterval === 'number' ? Math.round(row.avgInterval) : '—'), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: '8px 12px',
        minWidth: 120
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        height: 6,
        background: 'rgba(255,255,255,0.06)',
        borderRadius: 3,
        overflow: 'hidden'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: `${barW}%`,
        height: '100%',
        background: barColor,
        borderRadius: 3,
        transition: 'width 0.5s ease'
      }
    })), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: barColor,
        fontWeight: 700,
        minWidth: 34,
        textAlign: 'right'
      }
    }, row.overdueScore ? row.overdueScore.toFixed(2) : '0.00', "x"))));
  })))));
});

/* ─────────────────────── DrawPivotTable (lịch sử theo giờ) ─────────────── */
const DrawPivotTable = memo(function DrawPivotTable({
  history,
  total
}) {
  const [filter, setFilter] = useState('all');
  if (!history || history.length === 0) return /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#475569',
      fontSize: 13,
      padding: '16px 0'
    }
  }, "Kh\xF4ng c\xF3 d\u1EEF li\u1EC7u");

  // Group by VN date × time slot (UTC+7 explicit to work in any browser timezone)
  const VN_OFF = 7 * 3600_000;
  const bySlot = {}; // HH:MM → { YYYY-MM-DD → record }
  const dateSet = new Set();
  for (const r of history) {
    if (!r.drawTime) continue;
    const vnMs = new Date(r.drawTime).getTime() + VN_OFF;
    const vnD = new Date(vnMs);
    const h = vnD.getUTCHours(),
      m = vnD.getUTCMinutes();
    const slot = h.toString().padStart(2, '0') + ':' + m.toString().padStart(2, '0');
    const dateStr = vnD.getUTCFullYear() + '-' + (vnD.getUTCMonth() + 1).toString().padStart(2, '0') + '-' + vnD.getUTCDate().toString().padStart(2, '0');
    if (!bySlot[slot]) bySlot[slot] = {};
    if (!bySlot[slot][dateStr]) bySlot[slot][dateStr] = r; // keep newest (first seen)
    dateSet.add(dateStr);
  }

  // Up to 5 most-recent dates as columns, newest → oldest (left → right)
  const dates = [...dateSet].sort((a, b) => b.localeCompare(a)).slice(0, 5);

  // All time slots sorted ascending, filtered by period
  let slots = Object.keys(bySlot).sort();
  if (filter === 'morning') slots = slots.filter(s => +s.slice(0, 2) < 12);
  if (filter === 'afternoon') slots = slots.filter(s => {
    const h = +s.slice(0, 2);
    return h >= 12 && h < 18;
  });
  if (filter === 'evening') slots = slots.filter(s => +s.slice(0, 2) >= 18);
  const DAY_VN = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  function fmtDateHdr(ds) {
    const [y, mo, dd] = ds.split('-').map(Number);
    const day = new Date(Date.UTC(y, mo - 1, dd)).getUTCDay();
    return DAY_VN[day] + ' ' + dd + '/' + mo;
  }
  function isTriple(r) {
    return r.n1 === r.n2 && r.n2 === r.n3;
  }
  function isPair(r) {
    return !isTriple(r) && (r.n1 === r.n2 || r.n2 === r.n3 || r.n1 === r.n3);
  }
  function getSum(r) {
    return r.sum != null ? r.sum : r.n1 + r.n2 + r.n3;
  }

  // Highlight flags for a given (slot, column-index) cell
  function getHL(slot, di) {
    const cur = bySlot[slot]?.[dates[di]];
    if (!cur) return {};
    const h = {};
    if (isTriple(cur)) h.triple = true;else if (isPair(cur)) h.pair = true;
    const curSum = getSum(cur);
    // Compare against immediate neighbours (previous and next column)
    for (const adj of [bySlot[slot]?.[dates[di - 1]], bySlot[slot]?.[dates[di + 1]]]) {
      if (!adj) continue;
      if (getSum(adj) === curSum) h.sameSum = true;
      if (isTriple(cur) && isTriple(adj)) h.sameTriple = true;
      if (isPair(cur) && isPair(adj)) h.samePair = true;
    }
    return h;
  }
  function cellCS(h) {
    // background + box-shadow for the <td>
    if (h.sameTriple) return {
      background: 'rgba(251,191,36,0.28)',
      boxShadow: 'inset 0 0 0 2px rgba(251,191,36,0.65)'
    };
    if (h.triple) return {
      background: 'rgba(251,191,36,0.12)',
      boxShadow: 'inset 0 0 0 1px rgba(251,191,36,0.38)'
    };
    if (h.samePair) return {
      background: 'rgba(167,139,250,0.20)',
      boxShadow: 'inset 0 0 0 2px rgba(167,139,250,0.58)'
    };
    if (h.pair) return {
      background: 'rgba(125,211,252,0.10)',
      boxShadow: 'inset 0 0 0 1px rgba(125,211,252,0.28)'
    };
    if (h.sameSum) return {
      background: 'rgba(251,113,133,0.12)',
      boxShadow: 'inset 0 0 0 2px rgba(251,113,133,0.52)'
    };
    return {
      background: 'transparent',
      boxShadow: 'none'
    };
  }
  function ballColor(h) {
    return h.sameTriple || h.triple ? '#fbbf24' : h.samePair || h.pair ? '#7dd3fc' : '#c4b5fd';
  }
  function ballBg(h) {
    return h.sameTriple || h.triple ? 'rgba(251,191,36,0.22)' : h.samePair || h.pair ? 'rgba(125,211,252,0.18)' : 'rgba(99,102,241,0.18)';
  }
  function ballBorder(h) {
    return h.sameTriple || h.triple ? '1px solid rgba(251,191,36,0.45)' : h.samePair || h.pair ? '1px solid rgba(125,211,252,0.35)' : '1px solid rgba(99,102,241,0.30)';
  }

  // Footer summary per date column
  const colSum = dates.map(date => {
    let t = 0,
      p = 0,
      n = 0;
    for (const slot of slots) {
      const r = bySlot[slot]?.[date];
      if (!r) continue;
      if (isTriple(r)) t++;else if (isPair(r)) p++;else n++;
    }
    return {
      t,
      p,
      n
    };
  });
  const TH = {
    padding: '8px 6px',
    textAlign: 'center',
    color: '#64748b',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.05em',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    background: '#1e293b'
  };
  const ROW_BD = {
    borderBottom: '1px solid rgba(255,255,255,0.04)'
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginBottom: 14,
      flexWrap: 'wrap',
      alignItems: 'center'
    }
  }, [['all', 'Tất cả'], ['morning', 'Sáng 6–12h'], ['afternoon', 'Chiều 12–18h'], ['evening', 'Tối 18–22h']].map(([v, l]) => /*#__PURE__*/React.createElement("button", {
    key: v,
    onClick: () => setFilter(v),
    style: {
      background: filter === v ? 'rgba(99,102,241,0.22)' : 'rgba(255,255,255,0.04)',
      color: filter === v ? '#a5b4fc' : '#475569',
      border: filter === v ? '1px solid rgba(99,102,241,0.45)' : '1px solid rgba(255,255,255,0.08)',
      borderRadius: 6,
      padding: '4px 11px',
      cursor: 'pointer',
      fontSize: 11
    }
  }, l)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: '#334155',
      marginLeft: 4
    }
  }, total.toLocaleString(), " k\u1EF3 t\u1ED5ng \xB7 ", dates.length, " ng\xE0y g\u1EA7n nh\u1EA5t"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      gap: 10,
      fontSize: 10,
      color: '#64748b',
      flexWrap: 'wrap',
      alignItems: 'center'
    }
  }, [['rgba(251,191,36,0.40)', 'HOA'], ['rgba(125,211,252,0.35)', 'Đôi'], ['rgba(251,113,133,0.35)', 'Same Tổng'], ['rgba(167,139,250,0.35)', 'Same Đôi']].map(([c, l]) => /*#__PURE__*/React.createElement("span", {
    key: l,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-block',
      width: 10,
      height: 10,
      background: c,
      borderRadius: 2
    }
  }), l)))), /*#__PURE__*/React.createElement("div", {
    style: {
      overflowX: 'auto',
      overflowY: 'auto',
      maxHeight: 540
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      ...TH,
      textAlign: 'left',
      position: 'sticky',
      left: 0,
      zIndex: 3,
      minWidth: 52,
      padding: '8px 10px'
    }
  }, "Gi\u1EDD"), dates.map(d => /*#__PURE__*/React.createElement("th", {
    key: d,
    style: {
      ...TH,
      minWidth: 110
    }
  }, fmtDateHdr(d))))), /*#__PURE__*/React.createElement("tbody", null, slots.map(slot => {
    if (!dates.some(d => bySlot[slot]?.[d])) return null;
    return /*#__PURE__*/React.createElement("tr", {
      key: slot
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        ...ROW_BD,
        padding: '4px 10px',
        color: '#475569',
        fontSize: 11,
        fontWeight: 700,
        position: 'sticky',
        left: 0,
        background: '#1e293b',
        zIndex: 1
      }
    }, slot), dates.map((date, di) => {
      const r = bySlot[slot]?.[date];
      const h = r ? getHL(slot, di) : {};
      const bc = ballColor(h),
        bbg = ballBg(h),
        bb = ballBorder(h);
      return /*#__PURE__*/React.createElement("td", {
        key: date,
        style: {
          ...ROW_BD,
          padding: '4px 6px',
          textAlign: 'center',
          ...cellCS(h)
        }
      }, r ? /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2
        }
      }, [r.n1, r.n2, r.n3].map((n, j) => /*#__PURE__*/React.createElement("span", {
        key: j,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 21,
          height: 21,
          background: bbg,
          border: bb,
          borderRadius: 5,
          fontWeight: 800,
          color: bc,
          fontSize: 11
        }
      }, n)), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 10,
          color: '#475569',
          marginLeft: 2
        }
      }, getSum(r))) : /*#__PURE__*/React.createElement("span", {
        style: {
          color: '#1e3a5f',
          fontSize: 11
        }
      }, "\u2014"));
    }));
  })), /*#__PURE__*/React.createElement("tfoot", null, /*#__PURE__*/React.createElement("tr", {
    style: {
      borderTop: '2px solid rgba(255,255,255,0.10)'
    }
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '6px 10px',
      fontSize: 10,
      color: '#fbbf24',
      fontWeight: 700,
      position: 'sticky',
      left: 0,
      background: '#1e293b'
    }
  }, "HOA"), colSum.map((s, i) => /*#__PURE__*/React.createElement("td", {
    key: i,
    style: {
      padding: '6px 6px',
      textAlign: 'center',
      color: '#fbbf24',
      fontWeight: 700,
      fontSize: 13
    }
  }, s.t))), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '3px 10px',
      fontSize: 10,
      color: '#7dd3fc',
      fontWeight: 700,
      position: 'sticky',
      left: 0,
      background: '#1e293b'
    }
  }, "\u0110\xF4i"), colSum.map((s, i) => /*#__PURE__*/React.createElement("td", {
    key: i,
    style: {
      padding: '3px 6px',
      textAlign: 'center',
      color: '#7dd3fc',
      fontSize: 13
    }
  }, s.p))), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '3px 10px 8px',
      fontSize: 10,
      color: '#64748b',
      fontWeight: 700,
      position: 'sticky',
      left: 0,
      background: '#1e293b'
    }
  }, "Th\u01B0\u1EDDng"), colSum.map((s, i) => /*#__PURE__*/React.createElement("td", {
    key: i,
    style: {
      padding: '3px 6px 8px',
      textAlign: 'center',
      color: '#64748b',
      fontSize: 12
    }
  }, s.n)))))));
});

/* ─────────────────────────── NewDrawToast ──────────────────────────────── */
function NewDrawToast({
  info,
  onDismiss
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6_000);
    return () => clearTimeout(t);
  }, [info]);
  if (!info) return null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      top: 18,
      right: 12,
      left: 12,
      zIndex: 9999,
      background: 'linear-gradient(135deg,#065f46,#047857)',
      color: '#ecfdf5',
      borderRadius: 12,
      padding: '14px 20px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      border: '1px solid rgba(52,211,153,0.4)',
      maxWidth: 320,
      width: 'min(320px, calc(100vw - 24px))',
      marginLeft: 'auto',
      animation: 'fadeIn 0.3s ease',
      cursor: 'pointer'
    },
    onClick: onDismiss
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 800,
      fontSize: 14,
      marginBottom: 4
    }
  }, "\uD83C\uDFAF K\u1EF3 m\u1EDBi! #", info.latestKy), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      opacity: 0.85
    }
  }, "+", info.added, " k\u1EF3 v\u1EEBa m\u1EDF th\u01B0\u1EDFng \u2014 d\u1EF1 \u0111o\xE1n \u0111\xE3 c\u1EADp nh\u1EADt"));
}

/* ─────────────────────────── App ──────────────────────────────────────── */
function App() {
  const [preds, setPreds] = useState([]);
  const [sumStats, setSumStats] = useState([]);
  const [maxScore, setMaxScore] = useState(1);
  const [history, setHistory] = useState([]);
  // Refs store cheap signatures instead of whole payloads.
  const predsRef = React.useRef('');
  const historyRef = React.useRef('');
  // ETag refs — store server ETag per endpoint and send If-None-Match on polls
  // so the server returns 304 when nothing changed → skip all state updates
  const predETagRef = React.useRef(null);
  const histETagRef = React.useRef(null);
  const overdueETagRef = React.useRef(null);
  const statsETagRef = React.useRef(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updated, setUpdated] = useState('—');
  const [toast, setToast] = useState(null);
  const [liveKy, setLiveKy] = useState(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [overdue, setOverdue] = useState(null);
  const [overdueLoading, setOverdueLoading] = useState(true);
  const [crawling, setCrawling] = useState(false);
  const [tripleSignal, setTripleSignal] = useState(null);
  const [modelContrib, setModelContrib] = useState(null);

  // Bingo18 operating hours: 06:00–21:54 Vietnam time (UTC+7)
  const isNowOperating = () => {
    const vnMin = (new Date().getUTCHours() + 7) % 24 * 60 + new Date().getUTCMinutes();
    return vnMin >= 360 && vnMin <= 1314;
  };
  const [bingoClosed, setBingoClosed] = React.useState(!isNowOperating());
  const loadOverdue = useCallback(async () => {
    setOverdueLoading(true);
    try {
      const headers = overdueETagRef.current ? {
        'If-None-Match': overdueETagRef.current
      } : {};
      const r = await fetch('/overdue', {
        cache: 'no-cache',
        headers
      });
      if (r.status !== 304) {
        const etag = r.headers.get('ETag');
        if (etag) overdueETagRef.current = etag;
        setOverdue(await r.json());
      }
      // 304 → data unchanged, skip re-render
    } catch (_) {}
    setOverdueLoading(false);
  }, []);
  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const headers = statsETagRef.current ? {
        'If-None-Match': statsETagRef.current
      } : {};
      const r = await fetch('/stats', {
        cache: 'no-cache',
        headers
      });
      if (r.status !== 304) {
        const etag = r.headers.get('ETag');
        if (etag) statsETagRef.current = etag;
        const s = await r.json();
        setStats(s);
        // Server is computing for the first time — auto-retry after 60s
        if (s?.computing) setTimeout(() => loadStatsRef.current(), 60_000);
      }
      // 304 → data unchanged, skip re-render
    } catch (_) {}
    setStatsLoading(false);
  }, []);
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const predH = predETagRef.current ? {
        'If-None-Match': predETagRef.current
      } : {};
      const histH = histETagRef.current ? {
        'If-None-Match': histETagRef.current
      } : {};
      const [pRaw, hRaw] = await Promise.all([fetch('/predict', {
        cache: 'no-cache',
        headers: predH
      }), fetch('/history?limit=1000', {
        headers: histH
      })]);

      // Both unchanged — nothing to do, skip all state updates
      if (pRaw.status === 304 && hRaw.status === 304) return;
      if (pRaw.status !== 304 && !pRaw.ok) throw new Error(`API ${pRaw.status}`);
      const pRes = pRaw.status !== 304 ? await pRaw.json() : null;
      const hRes = hRaw.status !== 304 ? await hRaw.json() : null;
      if (pRes) {
        const etag = pRaw.headers.get('ETag');
        if (etag) predETagRef.current = etag;
        const newPreds = pRes.next || [];
        const nextSig = predsSignature(newPreds);
        if (nextSig !== predsRef.current) {
          predsRef.current = nextSig;
          setPreds(newPreds);
          setMaxScore(pRes.maxScore || 1);
          setTripleSignal(pRes.tripleSignal || null);
          setModelContrib(pRes.modelContrib || null);
          setSumStats(pRes.sumStats || []);
        }
        setTotal(pRes.total || 0);
        setUpdated(new Date().toLocaleTimeString('vi-VN'));
      }
      if (hRes) {
        const etag = hRaw.headers.get('ETag');
        if (etag) histETagRef.current = etag;
        const newHistory = hRes.records || [];
        const nextSig = historySignature(newHistory);
        if (nextSig !== historyRef.current) {
          historyRef.current = nextSig;
          setHistory(newHistory);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []); // stable — ETag refs mutated in place, no closure deps needed

  // Use refs so SSE handler always calls latest version of load functions
  const loadRef = React.useRef(load);
  const loadStatsRef = React.useRef(loadStats);
  const loadOverdueRef = React.useRef(loadOverdue);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    loadStatsRef.current = loadStats;
  }, [loadStats]);
  useEffect(() => {
    loadOverdueRef.current = loadOverdue;
  }, [loadOverdue]);

  // ── SSE subscription ──────────────────────────────────────────────────
  useEffect(() => {
    let es;
    let reconnectTimer;
    let mounted = true;
    function connect() {
      if (!mounted) return;
      setSseConnected(false);
      es = new EventSource('/events');
      es.onopen = () => {
        if (mounted) setSseConnected(true);
      };
      es.addEventListener('new-draw', e => {
        if (!mounted) return;
        const info = JSON.parse(e.data);
        setLiveKy(info.latestKy);
        setToast(info);
        loadRef.current(true);
        loadStatsRef.current();
        loadOverdueRef.current();
      });
      es.onerror = () => {
        if (!mounted) return;
        setSseConnected(false);
        es.close();
        // Reconnect after 5s (prevent storm)
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 5_000);
      };
    }
    connect();
    return () => {
      mounted = false;
      clearTimeout(reconnectTimer);
      if (es) es.close();
    };
  }, []); // stable — callbacks accessed via refs

  // ── Periodic data refresh ──
  // - Skip all fetches when the browser tab is hidden (saves mobile battery + server CPU)
  // - predict+history: every 60s during operating hours (06:00–21:54 VN), else every 5min
  // - stats+overdue:   every 5 minutes (heavy O(N²) backtest, changes slowly)
  // SSE handles instant updates when a new draw appears; polling is just a safety net.
  useEffect(() => {
    function isOperatingHours() {
      const vnMin = (new Date().getUTCHours() + 7) % 24 * 60 + new Date().getUTCMinutes();
      return vnMin >= 360 && vnMin <= 1314; // 06:00–21:54 VN
    }
    load();
    loadStats();
    loadOverdue();
    const tFast = setInterval(() => {
      if (document.hidden) return; // tab not visible — skip
      if (!isOperatingHours()) return; // no new draws outside hours
      load(true);
    }, 60_000);
    const tSlow = setInterval(() => {
      if (document.hidden) return; // tab not visible — skip
      if (!isOperatingHours()) return; // no new draws outside hours
      loadStats();
      loadOverdue();
    }, 5 * 60_000);
    return () => {
      clearInterval(tFast);
      clearInterval(tSlow);
    };
  }, [load, loadStats, loadOverdue]);
  const maxPct = Math.max(...preds.map(p => p.pct || 0), 1);
  return /*#__PURE__*/React.createElement("div", {
    style: C.app
  }, /*#__PURE__*/React.createElement(NewDrawToast, {
    info: toast,
    onDismiss: () => setToast(null)
  }), /*#__PURE__*/React.createElement("div", {
    style: C.header
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: C.logo
  }, "\uD83C\uDFB0 Bingo18 AI"), /*#__PURE__*/React.createElement("div", {
    style: C.sub,
    className: "hide-mobile"
  }, "Th\u1ED1ng k\xEA \u0111a d\u1EA1ng h\xF3a combo \xB7 Realtime SSE \xB7 Walk-forward Backtest (p=0.51 \u2014 ch\u01B0a c\xF3 edge)")), /*#__PURE__*/React.createElement("div", {
    className: "header-actions"
  }, /*#__PURE__*/React.createElement("span", {
    style: C.pill
  }, total, " records"), /*#__PURE__*/React.createElement("span", {
    style: {
      ...C.pill,
      color: sseConnected ? '#34d399' : '#f87171',
      borderColor: sseConnected ? 'rgba(52,211,153,0.4)' : 'rgba(248,113,113,0.4)',
      background: sseConnected ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)'
    }
  }, sseConnected ? '🟢 Live' : '🔴 Connecting…', liveKy ? ` · #${liveKy}` : ''), bingoClosed && /*#__PURE__*/React.createElement("span", {
    style: {
      ...C.pill,
      color: '#fbbf24',
      borderColor: 'rgba(251,191,36,0.4)',
      background: 'rgba(251,191,36,0.08)'
    },
    title: "Bingo18 m\u1EDF 06:00\u201321:54 VN. Kh\xF4ng c\xF3 k\u1EF3 m\u1EDBi ngo\xE0i gi\u1EDD n\xE0y."
  }, "\uD83D\uDD15 Ngo\xE0i gi\u1EDD Bingo"), /*#__PURE__*/React.createElement("span", {
    style: {
      ...C.pill,
      color: '#94a3b8'
    }
  }, "\u27F3 ", updated), /*#__PURE__*/React.createElement("button", {
    style: {
      ...C.btn,
      opacity: crawling || loading ? 0.6 : 1,
      background: 'rgba(52,211,153,0.15)',
      borderColor: 'rgba(52,211,153,0.4)',
      color: '#34d399'
    },
    onClick: async () => {
      setCrawling(true);
      await fetch('/crawl', {
        method: 'POST'
      }).catch(() => {});
      setCrawling(false);
      load();
    },
    disabled: crawling || loading
  }, crawling ? 'Đang tải…' : loading ? 'Loading…' : '⬇ Cập nhật'))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'rgba(15,23,42,0.8)',
      borderBottom: '1px solid rgba(99,102,241,0.15)',
      padding: '7px 24px',
      textAlign: 'center',
      fontSize: 11,
      color: '#64748b'
    }
  }, "\u26A0\uFE0F C\xF4ng c\u1EE5 th\u1ED1ng k\xEA gi\u1EA3i tr\xED. Top-10 l\xE0 portfolio \u0111a d\u1EA1ng, kh\xF4ng ph\u1EA3i AI \"bi\u1EBFt tr\u01B0\u1EDBc\" k\u1EBFt qu\u1EA3. Ch\u01A1i c\xF3 tr\xE1ch nhi\u1EC7m."), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 1120,
      margin: '0 auto',
      padding: 'clamp(12px,3vw,28px) clamp(12px,3vw,20px)'
    }
  }, error && /*#__PURE__*/React.createElement("div", {
    style: {
      ...C.warn,
      color: '#fca5a5',
      background: 'rgba(239,68,68,0.1)',
      border: '1px solid rgba(239,68,68,0.3)'
    }
  }, "\u26A0 ", error, " \u2014 H\xE3y ch\u1EAFc ch\u1EAFn API \u0111ang ch\u1EA1y v\xE0 c\xF3 d\u1EEF li\u1EC7u (c\u1EA7n \xEDt nh\u1EA5t 100 k\u1EF3 \u0111\u1EC3 d\u1EF1 \u0111o\xE1n). Click \"C\u1EADp nh\u1EADt\" \u0111\u1EC3 th\u1EED l\u1EA1i."), !loading && !error && total === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      ...C.warn,
      color: '#fcd34d',
      background: 'rgba(251,191,36,0.1)',
      border: '1px solid rgba(251,191,36,0.3)'
    }
  }, "Ch\u01B0a c\xF3 d\u1EEF li\u1EC7u. Ch\u1EDD h\u1EC7 th\u1ED1ng thu th\u1EADp \u0111\u1EE7 k\u1EF3 m\u1EDF th\u01B0\u1EDFng \u0111\u1EC3 b\u1EAFt \u0111\u1EA7u d\u1EF1 \u0111o\xE1n (c\u1EA7n \xEDt nh\u1EA5t 100 k\u1EF3)."), /*#__PURE__*/React.createElement("div", {
    style: C.sec
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 14,
      flexWrap: 'wrap',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: C.label
  }, "Top 10 Combo d\u1EF1 \u0111o\xE1n"), updated !== '—' && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: '#475569'
    }
  }, "\u27F3 ", updated)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#475569'
    },
    className: "hide-mobile"
  }, "% = t\u1EF7 l\u1EC7 trong top-10 \xB7 X.Xx = s\u1ED1 l\u1EA7n qu\xE1 h\u1EA1n so v\u1EDBi k\u1EF3 v\u1ECDng (1x = b\xECnh th\u01B0\u1EDDng, >1x = l\xE2u ch\u01B0a v\u1EC1)")), /*#__PURE__*/React.createElement(TripleSignalCard, {
    signal: tripleSignal,
    anyTriple: overdue?.anyTriple
  }), modelContrib && /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: 10,
      padding: '10px 14px',
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#475569',
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      marginBottom: 6
    }
  }, "\u0110\xF3ng g\xF3p model th\u1EF1c t\u1EBF", modelContrib._uniform && /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 6,
      color: '#fbbf24',
      fontWeight: 400,
      textTransform: 'none'
    }
  }, "\xB7 no_pattern \u2192 uniform (portfolio diversity only)")), !modelContrib._uniform ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 2,
      height: 8,
      borderRadius: 4,
      overflow: 'hidden'
    }
  }, [{
    key: 'stat',
    label: 'stat',
    color: '#818cf8'
  }, {
    key: 'mk2',
    label: 'mk2',
    color: '#34d399'
  }, {
    key: 'sess',
    label: 'sess',
    color: '#fb923c'
  }, {
    key: 'knn',
    label: 'knn',
    color: '#a78bfa'
  }, {
    key: 'gbm',
    label: 'gbm',
    color: '#60a5fa'
  }].filter(m => (modelContrib[m.key] ?? 0) > 0).map(m => /*#__PURE__*/React.createElement("div", {
    key: m.key,
    title: `${m.label}: ${modelContrib[m.key]}%`,
    style: {
      width: `${modelContrib[m.key]}%`,
      background: m.color,
      minWidth: modelContrib[m.key] > 0 ? 2 : 0
    }
  }))) : /*#__PURE__*/React.createElement("div", {
    style: {
      height: 8,
      borderRadius: 4,
      background: 'repeating-linear-gradient(45deg,#334155,#334155 4px,#1e293b 4px,#1e293b 8px)'
    }
  }), !modelContrib._uniform && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      marginTop: 5,
      flexWrap: 'wrap'
    }
  }, [{
    key: 'stat',
    label: 'stat (z-score)',
    color: '#818cf8'
  }, {
    key: 'mk2',
    label: 'mk2 (Markov)',
    color: '#34d399'
  }, {
    key: 'sess',
    label: 'sess',
    color: '#fb923c'
  }, {
    key: 'knn',
    label: 'knn',
    color: '#a78bfa'
  }, {
    key: 'gbm',
    label: 'gbm',
    color: '#60a5fa'
  }].filter(m => (modelContrib[m.key] ?? 0) > 0).map(m => /*#__PURE__*/React.createElement("span", {
    key: m.key,
    style: {
      fontSize: 10,
      color: m.color
    }
  }, m.label, " ", modelContrib[m.key], "%")))), /*#__PURE__*/React.createElement("div", {
    className: "grid3"
  }, preds.length === 0 && !loading && /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#64748b',
      fontSize: 13
    }
  }, "Ch\u01B0a c\xF3 d\u1EF1 \u0111o\xE1n."), preds.map((p, i) => /*#__PURE__*/React.createElement(PredCard, {
    key: p.combo,
    combo: p.combo,
    pct: p.pct,
    rank: i,
    maxPct: maxPct,
    score: p.score,
    maxScore: maxScore,
    overdueRatio: p.overdueRatio,
    comboGap: p.comboGap ?? 0,
    pat: p.pat,
    stability: p.stability,
    zScore: p.zScore,
    statNorm: p.statNorm ?? p.coreNorm,
    mk2Norm: p.mk2Norm,
    sessNorm: p.sessNorm,
    confidence: p.confidence,
    calBuckets: stats?.calBuckets,
    isUniform: !!modelContrib?._uniform
  })))), overdue && /*#__PURE__*/React.createElement("div", {
    style: {
      ...C.card,
      marginBottom: 28
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: C.label
  }, "Th\u1ED1ng k\xEA qu\xE1 h\u1EA1n"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#475569'
    },
    className: "hide-mobile"
  }, "S\u1ED1 k\u1EF3 ch\u01B0a v\u1EC1 \xF7 TB m\u1ED7i k\u1EF3 \u2014 >1x l\xE0 qu\xE1 h\u1EA1n")), /*#__PURE__*/React.createElement("div", {
    className: "grid-overdue"
  }, /*#__PURE__*/React.createElement(OverdueTable, {
    items: overdue.anyTriple ? [overdue.anyTriple, ...overdue.triples] : overdue.triples,
    loading: overdueLoading,
    title: `Hoa — 111~666 (${overdue.triples?.length || 0})`
  }), /*#__PURE__*/React.createElement(OverdueTable, {
    items: overdue.pairs,
    loading: overdueLoading,
    title: `D - 11~66 (${overdue.pairs?.length || 0})`
  }), /*#__PURE__*/React.createElement(OverdueTable, {
    items: overdue.sums,
    loading: overdueLoading,
    title: `T — 3~18 (${overdue.sums?.length || 0})`
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      ...C.card,
      marginBottom: 28
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...C.label,
      marginBottom: 14
    }
  }, "L\u1ECBch s\u1EED theo gi\u1EDD (", total.toLocaleString(), " k\u1EF3)"), /*#__PURE__*/React.createElement(DrawPivotTable, {
    history: history,
    total: total
  })), sumStats.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      ...C.card,
      marginBottom: 28
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: C.label
  }, "Ph\xE2n ph\u1ED1i Sum"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#475569'
    }
  }, "% k\u1EF3 c\xF3 t\u1ED5ng n1+n2+n3 = X \xB7 L\xFD thuy\u1EBFt: Sum 10/11 = 12.5% cao nh\u1EA5t")), (() => {
    const maxSumPct = Math.max(...sumStats.map(x => x.pct), 1);
    return sumStats.slice(0, 16).map(s => /*#__PURE__*/React.createElement(SumBar, {
      key: s.sum,
      sum: s.sum,
      pct: s.pct,
      maxPct: maxSumPct
    }));
  })()), /*#__PURE__*/React.createElement("div", {
    style: {
      ...C.card,
      marginBottom: 28
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 16,
      flexWrap: 'wrap',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: C.label
  }, "\u0110\u1ED9 ch\xEDnh x\xE1c d\u1EF1 \u0111o\xE1n"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#475569'
    },
    className: "hide-mobile"
  }, "Walk-forward backtest \u2014 hu\u1EA5n luy\u1EC7n tr\xEAn data qu\xE1 kh\u1EE9, ki\u1EC3m tra tr\xEAn k\u1EF3 ti\u1EBFp theo")), /*#__PURE__*/React.createElement(AccuracyPanel, {
    stats: stats,
    loading: statsLoading
  })), /*#__PURE__*/React.createElement("div", {
    className: "hide-mobile",
    style: {
      ...C.card,
      marginBottom: 28
    }
  }, /*#__PURE__*/React.createElement(Heatmap, {
    history: history
  }))), /*#__PURE__*/React.createElement("footer", {
    style: {
      borderTop: '1px solid rgba(255,255,255,0.06)',
      padding: '28px 24px',
      textAlign: 'center',
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'center',
      gap: 24,
      flexWrap: 'wrap',
      marginBottom: 12
    }
  }, [{
    href: '/about',
    label: 'Về chúng tôi'
  }, {
    href: '/how-it-works',
    label: 'Cách hoạt động'
  }, {
    href: '/blog/what-is-bingo18',
    label: 'Bingo18 là gì?'
  }, {
    href: '/blog/best-strategy-2026',
    label: 'Chiến thuật 2026'
  }, {
    href: '/privacy-policy',
    label: 'Chính sách bảo mật'
  }].map(({
    href,
    label
  }) => /*#__PURE__*/React.createElement("a", {
    key: href,
    href: href,
    style: {
      fontSize: 13,
      color: '#475569',
      textDecoration: 'none'
    }
  }, label))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: '#334155'
    }
  }, "\xA9 2026 Bingo18 AI \xB7 Ch\u1EC9 d\xE0nh cho m\u1EE5c \u0111\xEDch tham kh\u1EA3o th\u1ED1ng k\xEA \xB7 Kh\xF4ng khuy\u1EBFn kh\xEDch c\u1EDD b\u1EA1c")));
}
ReactDOM.createRoot(document.getElementById('app')).render(/*#__PURE__*/React.createElement(App, null));