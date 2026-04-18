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
function predsSignature(preds, latestKy, newestDrawTime) {
  return `${latestKy || '0'}|${newestDrawTime || ''}::${preds.map(p => `${p.combo}:${p.score}:${p.rankStrength}`).join('|')}`;
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
function getRankingBadge(rank, zScore, sessNorm, isUniform) {
  // When no_pattern (uniform scores), show diversity-aware labels instead of misleading "HOT 80%"
  if (isUniform || rank >= 10) {
    // Overdue-based badge
    if (zScore != null && zScore > 2.0) return {
      label: '🔴 Quá hạn',
      color: '#FF6B3D',
      bg: 'rgba(255,107,61,0.18)',
      border: 'rgba(255,107,61,0.5)'
    };
    if (zScore != null && zScore > 1.0) return {
      label: '🟡 Khá hạn',
      color: '#FFC857',
      bg: 'rgba(255,200,87,0.15)',
      border: 'rgba(255,200,87,0.45)'
    };
    if (sessNorm != null && sessNorm < 0.1) return {
      label: '🟣 Hiếm',
      color: '#a78bfa',
      bg: 'rgba(167,139,250,0.15)',
      border: 'rgba(167,139,250,0.4)'
    };
    return {
      label: '⚪ Đa dạng',
      color: '#94a3b8',
      bg: 'rgba(148,163,184,0.12)',
      border: 'rgba(148,163,184,0.35)'
    };
  }
  // Pattern mode: rank-based
  if (rank < 3) return {
    label: '🔥 HOT',
    color: '#FF6B3D',
    bg: 'rgba(255,107,61,0.18)',
    border: 'rgba(255,107,61,0.5)'
  };
  if (rank < 5) return {
    label: '⭐ STRONG',
    color: '#FFC857',
    bg: 'rgba(255,200,87,0.15)',
    border: 'rgba(255,200,87,0.45)'
  };
  if (rank < 7) return {
    label: '👍 GOOD',
    color: '#4CC9F0',
    bg: 'rgba(76,201,240,0.13)',
    border: 'rgba(76,201,240,0.4)'
  };
  return {
    label: '⚠️ OK',
    color: '#9D8DF1',
    bg: 'rgba(157,141,241,0.13)',
    border: 'rgba(157,141,241,0.4)'
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
  rankStrength: confFromServer,
  calBuckets,
  isUniform
}) {
  const nums = combo.split('-');
  const badge = getRankingBadge(rank, zScore, sessNorm, isUniform);
  // Calibrated hit rate at this rank position from walk-forward backtest
  const calHitPct = calBuckets ? calBuckets.find(b => b.rank === rank + 1)?.hitPct : null;
  // Display calibrated hit rate when available, else server confidence
  const displayConf = calHitPct != null ? calHitPct : confFromServer;
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
  }, "ch\u01B0a v\u1EC1"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: comboGap > 500 ? '#FF6B3D' : comboGap > 250 ? '#FFC857' : '#94a3b8',
      textAlign: 'right',
      fontWeight: 700
    }
  }, comboGap != null ? `${comboGap}k` : '—'), /*#__PURE__*/React.createElement("span", {
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
  }, /*#__PURE__*/React.createElement("span", null, calHitPct != null ? 'lịch sử' : 'rank strength', calHitPct != null && /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#475569',
      fontWeight: 400
    }
  }, " (backtest)")), /*#__PURE__*/React.createElement("span", {
    style: {
      color: calHitPct != null ? '#34d399' : badge.color,
      fontWeight: 700
    }
  }, calHitPct != null ? `${calHitPct}%` : displayConf != null ? `${displayConf}%` : '—')), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 5,
      background: 'rgba(255,255,255,0.06)',
      borderRadius: 3,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${Math.min(100, (displayConf || 0) * (calHitPct != null ? 50 : 1))}%`,
      height: '100%',
      background: calHitPct != null ? 'linear-gradient(90deg,#34d39988,#34d399)' : `linear-gradient(90deg,${badge.color}88,${badge.color})`,
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
      background: 'rgba(139,92,246,0.14)',
      color: '#c4b5fd'
    },
    pair: {
      background: 'rgba(59,130,246,0.13)',
      color: '#7dd3fc'
    },
    normal: {
      background: 'rgba(255,255,255,0.05)',
      color: '#94a3b8'
    }
  }[pat] || {
    background: 'rgba(255,255,255,0.05)',
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
  }, tested), " windows", stats?.total ? /*#__PURE__*/React.createElement("span", null, " \xB7 ", /*#__PURE__*/React.createElement("strong", {
    style: {
      color: '#94a3b8'
    }
  }, stats.total.toLocaleString()), " k\u1EF3 d\u1EEF li\u1EC7u") : null, "\xA0\xB7\xA0Random baseline: top1=", baseline.top1, "% / top3=", baseline.top3, "% / top10=", baseline.top10, "%"), rows.map(r => /*#__PURE__*/React.createElement("div", {
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
  refreshKey = 0,
  onSelect
}) {
  const [days, setDays] = useState(5);
  const [filter, setFilter] = useState('all');
  const [hlCombo, setHlCombo] = useState(null);
  const [gridData, setGridData] = useState(null); // { slots, dates, cells, total, generated }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' ? window.innerWidth < 720 : false);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 720);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/history-grid?days=${days}&_t=${Date.now()}`).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))).then(d => {
      setGridData(d);
      setLoading(false);
    }).catch(e => {
      setError(e.message);
      setLoading(false);
    });
  }, [days, refreshKey]);
  const DAY_VN = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  function fmtDateHdr(ds) {
    const [y, mo, dd] = ds.split('-').map(Number);
    return DAY_VN[new Date(Date.UTC(y, mo - 1, dd)).getUTCDay()] + ' ' + dd + '/' + mo;
  }

  // Cell background based on sum/pattern
  function cellBg(cell) {
    const {
      sum,
      pattern
    } = cell;
    if (pattern === 'triple') return 'rgba(255,215,0,0.30)'; // gold override for HOA
    if (sum <= 9) return 'rgba(147,197,253,0.12)'; // low sum → subtle blue
    if (sum >= 12) return 'rgba(253,186,116,0.12)'; // high sum → subtle warm
    return ''; // 10/11 → neutral (no bg)
  }

  // Box-shadow for HOA/pair borders in the pivot table
  function cellBorder(cell) {
    if (!cell) return 'none';
    if (cell.pattern === 'triple') return 'inset 0 0 0 2px rgba(255,200,0,0.85)';
    if (cell.pattern === 'pair') return 'inset 0 0 0 2px rgba(59,130,246,0.72)';
    return 'none';
  }

  // Per-ball color — softer tones for readability
  function ballColor(n1, n2, n3, i) {
    if (n1 === n2 && n2 === n3) return 'rgba(167,139,250,0.55)'; // triple → muted purple
    const isPairBall = i === 0 && (n1 === n2 || n1 === n3) || i === 1 && (n2 === n1 || n2 === n3) || i === 2 && (n3 === n1 || n3 === n2);
    return isPairBall ? 'rgba(147,197,253,0.55)' : 'rgba(148,163,184,0.35)'; // pair → muted blue, normal → muted gray
  }

  // Sorted combo key for order-independent match
  function comboKey(n1, n2, n3) {
    return [n1, n2, n3].map(String).sort().join('');
  }

  // Current VN time for row highlight
  const nowVN = new Date(Date.now() + 7 * 3600_000);
  const nowTotalMin = nowVN.getUTCHours() * 60 + nowVN.getUTCMinutes();
  function isCurrentSlot(slot) {
    const [sh, sm] = slot.split(':').map(Number);
    return Math.abs(sh * 60 + sm - nowTotalMin) <= 6;
  }
  if (loading) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '24px 0',
      color: '#475569',
      fontSize: 13,
      textAlign: 'center'
    }
  }, "\u0110ang t\u1EA3i\u2026");
  if (error) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '16px 0',
      color: '#f87171',
      fontSize: 13
    }
  }, "L\u1ED7i: ", error);
  if (!gridData) return null;
  const {
    slots: allSlots,
    dates: allDates,
    cells,
    total
  } = gridData;

  // Show newest dates left → oldest right, cap at mobile
  const dates = [...allDates].sort((a, b) => b.localeCompare(a)).slice(0, isMobile ? 3 : 5);

  // Filter slots by time period
  let slots = allSlots;
  if (filter === 'morning') slots = slots.filter(s => +s.slice(0, 2) < 12);else if (filter === 'afternoon') slots = slots.filter(s => {
    const h = +s.slice(0, 2);
    return h >= 12 && h < 18;
  });else if (filter === 'evening') slots = slots.filter(s => +s.slice(0, 2) >= 18);

  // Footer stats per date column
  const colStats = dates.map(date => {
    let hoa = 0,
      x40 = 0,
      x12 = 0,
      x20 = 0;
    for (const slot of slots) {
      const c = cells[slot]?.[date];
      if (!c) continue;
      if (c.pattern === 'triple') hoa++;
      if (c.sum === 4 || c.sum === 17) x40++;
      if (c.sum === 6 || c.sum === 15) x12++;
      if (c.sum === 5 || c.sum === 16) x20++;
    }
    return {
      hoa,
      x40,
      x12,
      x20
    };
  });
  const TH = {
    padding: isMobile ? '6px 4px' : '7px 8px',
    textAlign: 'center',
    color: '#6366f1',
    fontSize: isMobile ? 9 : 10,
    fontWeight: 700,
    background: '#1e293b',
    position: 'sticky',
    top: 0,
    zIndex: 3
  };
  const BALL_SIZE = isMobile ? 19 : 22;
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginBottom: 10,
      flexWrap: 'wrap',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("select", {
    value: days,
    onChange: e => setDays(+e.target.value),
    style: {
      background: '#1e293b',
      border: '1px solid rgba(99,102,241,0.4)',
      color: '#e2e8f0',
      borderRadius: 6,
      padding: '4px 8px',
      fontSize: isMobile ? 10 : 11,
      cursor: 'pointer'
    }
  }, [3, 5, 7, 14].map(d => /*#__PURE__*/React.createElement("option", {
    key: d,
    value: d
  }, d, " ng\xE0y"))), [['all', 'Tất cả'], ['morning', 'Sáng 6–12h'], ['afternoon', 'Chiều 12–18h'], ['evening', 'Tối 18–22h']].map(([v, l]) => /*#__PURE__*/React.createElement("button", {
    key: v,
    onClick: () => setFilter(v),
    style: {
      background: filter === v ? 'rgba(99,102,241,0.22)' : 'rgba(255,255,255,0.04)',
      color: filter === v ? '#a5b4fc' : '#475569',
      border: filter === v ? '1px solid rgba(99,102,241,0.45)' : '1px solid rgba(255,255,255,0.08)',
      borderRadius: 6,
      padding: isMobile ? '4px 9px' : '4px 11px',
      cursor: 'pointer',
      fontSize: isMobile ? 10 : 11
    }
  }, l)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: isMobile ? 10 : 11,
      color: '#334155',
      marginLeft: 2
    }
  }, total.toLocaleString(), " k\u1EF3 \xB7 ", slots.length, " slot/ng\xE0y"), hlCombo && /*#__PURE__*/React.createElement("button", {
    onClick: () => setHlCombo(null),
    style: {
      background: 'rgba(99,102,241,0.15)',
      color: '#a5b4fc',
      border: '1px solid rgba(99,102,241,0.4)',
      borderRadius: 6,
      padding: '3px 10px',
      cursor: 'pointer',
      fontSize: 11
    }
  }, "\u2715 B\u1ECF ch\u1ECDn"), /*#__PURE__*/React.createElement("a", {
    href: "/history-table",
    target: "_blank",
    rel: "noopener",
    style: {
      marginLeft: 'auto',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
      color: '#fff',
      border: 'none',
      borderRadius: 7,
      padding: '5px 14px',
      fontSize: 11,
      fontWeight: 700,
      textDecoration: 'none',
      whiteSpace: 'nowrap'
    }
  }, "\u2197 Xem full")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      marginBottom: 10,
      fontSize: 10,
      color: '#64748b',
      flexWrap: 'wrap',
      alignItems: 'center'
    }
  }, [['rgba(167,139,250,0.55)', 'HOA'], ['rgba(147,197,253,0.55)', 'Đôi'], ['rgba(148,163,184,0.35)', 'Thường'], ['rgba(147,197,253,0.35)', 'Sum ≤9'], ['rgba(253,186,116,0.35)', 'Sum ≥12']].map(([c, l]) => /*#__PURE__*/React.createElement("span", {
    key: l,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 3
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-block',
      width: 9,
      height: 9,
      background: c,
      borderRadius: '50%'
    }
  }), l)), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#334155'
    }
  }, "\xB7 Click \xF4 \u0111\u1EC3 highlight")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 10,
      overflowX: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: `repeat(${Math.max(1, dates.length)}, minmax(${isMobile ? 120 : 150}px,1fr))`,
      gap: 8,
      minWidth: dates.length ? `${dates.length * (isMobile ? 120 : 150)}px` : 'auto'
    }
  }, dates.map((d, i) => /*#__PURE__*/React.createElement("div", {
    key: d,
    style: {
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 8,
      padding: isMobile ? '7px 8px' : '8px 10px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: isMobile ? 10 : 11,
      color: '#64748b',
      marginBottom: 4,
      fontWeight: 700
    }
  }, fmtDateHdr(d)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      fontSize: isMobile ? 11 : 12,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#fbbf24',
      fontWeight: 700
    }
  }, "HOA ", colStats[i].hoa), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#f97316',
      fontWeight: 700
    }
  }, "x40 ", colStats[i].x40), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#4ade80',
      fontWeight: 700
    }
  }, "x12 ", colStats[i].x12), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#c084fc',
      fontWeight: 700
    }
  }, "x20 ", colStats[i].x20)))))), /*#__PURE__*/React.createElement("div", {
    style: {
      overflowX: 'auto',
      overflowY: 'auto',
      maxHeight: isMobile ? 420 : 560,
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 8
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      borderCollapse: 'collapse',
      fontSize: 12,
      width: 'max-content',
      minWidth: '100%'
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      ...TH,
      textAlign: 'left',
      position: 'sticky',
      left: 0,
      zIndex: 4,
      minWidth: isMobile ? 44 : 52,
      padding: isMobile ? '6px 8px' : '7px 10px'
    }
  }, "Gi\u1EDD"), dates.map(d => /*#__PURE__*/React.createElement("th", {
    key: d,
    style: {
      ...TH,
      minWidth: isMobile ? 88 : 108
    }
  }, fmtDateHdr(d))))), /*#__PURE__*/React.createElement("tbody", null, slots.map(slot => {
    const isCurrent = isCurrentSlot(slot);
    return /*#__PURE__*/React.createElement("tr", {
      key: slot,
      style: isCurrent ? {
        background: 'rgba(99,102,241,0.10)'
      } : {}
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        padding: isMobile ? '4px 6px' : '3px 10px',
        color: isCurrent ? '#a5b4fc' : '#475569',
        fontSize: isMobile ? 10 : 11,
        fontWeight: 700,
        position: 'sticky',
        left: 0,
        background: '#1e293b',
        zIndex: 1,
        borderRight: '1px solid rgba(255,255,255,0.06)',
        borderBottom: '1px solid rgba(255,255,255,0.04)'
      }
    }, slot), dates.map(date => {
      const cell = cells[slot]?.[date];
      const bg = cell ? cellBg(cell) : '';
      const border = cell ? cellBorder(cell) : 'none';
      const ck = cell ? comboKey(cell.n1, cell.n2, cell.n3) : null;
      const isMatch = ck && ck === hlCombo;
      const isHl = hlCombo !== null;
      return /*#__PURE__*/React.createElement("td", {
        key: date,
        onClick: cell ? () => {
          const next = hlCombo === ck ? null : ck;
          setHlCombo(next);
          onSelect?.(next);
        } : undefined,
        style: {
          padding: isMobile ? '2px 3px' : '3px 5px',
          textAlign: 'center',
          background: bg || (isCurrent ? 'rgba(99,102,241,0.06)' : '#0f172a'),
          borderBottom: '1px solid rgba(255,255,255,0.04)',
          borderRight: '1px solid rgba(255,255,255,0.04)',
          cursor: cell ? 'pointer' : 'default',
          opacity: isHl && cell && !isMatch ? 0.25 : 1,
          outline: isMatch ? '2px solid #6366f1' : 'none',
          boxShadow: isMatch ? 'none' : border,
          position: 'relative',
          zIndex: isMatch ? 1 : 'auto',
          minWidth: isMobile ? 80 : 96,
          transition: 'opacity 0.1s'
        }
      }, cell ? /*#__PURE__*/React.createElement("div", {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2
        }
      }, [cell.n1, cell.n2, cell.n3].map((n, j) => /*#__PURE__*/React.createElement("span", {
        key: j,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: BALL_SIZE,
          height: BALL_SIZE,
          borderRadius: '50%',
          fontWeight: 700,
          color: '#fff',
          background: ballColor(cell.n1, cell.n2, cell.n3, j),
          fontSize: isMobile ? 10 : 11,
          flexShrink: 0
        }
      }, n)), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: isMobile ? 9 : 10,
          color: '#64748b',
          marginLeft: 2,
          minWidth: 14
        }
      }, cell.sum)) : /*#__PURE__*/React.createElement("span", {
        style: {
          color: '#1e293b',
          fontSize: 10
        }
      }, "\xB7"));
    }));
  }), [{
    key: 'hoa',
    label: 'HOA',
    bg: 'rgba(255,215,0,0.15)',
    tc: '#fbbf24'
  }, {
    key: 'x40',
    label: 'x40',
    bg: 'rgba(255,105,180,0.10)',
    tc: '#f472b6'
  }, {
    key: 'x12',
    label: 'x12',
    bg: 'rgba(152,251,152,0.08)',
    tc: '#4ade80'
  }, {
    key: 'x20',
    label: 'x20',
    bg: 'rgba(221,160,221,0.08)',
    tc: '#c084fc'
  }].map(({
    key,
    label,
    bg,
    tc
  }) => /*#__PURE__*/React.createElement("tr", {
    key: key,
    style: {
      background: bg
    }
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      padding: isMobile ? '4px 6px' : '4px 10px',
      fontWeight: 700,
      fontSize: 11,
      color: '#6366f1',
      position: 'sticky',
      left: 0,
      background: '#1e293b',
      borderRight: '1px solid rgba(255,255,255,0.06)',
      borderTop: '1px solid rgba(255,255,255,0.08)'
    }
  }, label), dates.map((date, i) => /*#__PURE__*/React.createElement("td", {
    key: date,
    style: {
      padding: isMobile ? '4px 3px' : '4px 5px',
      fontWeight: 700,
      fontSize: 11,
      color: tc,
      textAlign: 'center',
      borderTop: '1px solid rgba(255,255,255,0.08)'
    }
  }, colStats[i][key]))))))));
});

/* ─────────────────────────── NewDrawToast ──────────────────────────────── */
function NewDrawToast({
  info,
  onDismiss,
  onRefresh
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 12_000);
    return () => clearTimeout(t);
  }, [info]);
  if (!info) return null;
  const handleRefresh = () => {
    onRefresh();
    onDismiss();
  };
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
      maxWidth: 340,
      width: 'min(340px, calc(100vw - 24px))',
      marginLeft: 'auto',
      animation: 'fadeIn 0.3s ease'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 800,
      fontSize: 14,
      marginBottom: 4
    }
  }, "\uD83C\uDFAF K\u1EF3 m\u1EDBi! #", info.latestKy), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      opacity: 0.85,
      marginBottom: 10
    }
  }, "+", info.added, " k\u1EF3 v\u1EEBa m\u1EDF th\u01B0\u1EDFng \u2014 nh\u1EA5n \u0111\u1EC3 xem k\u1EBFt qu\u1EA3 m\u1EDBi"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: handleRefresh,
    style: {
      flex: 1,
      background: 'rgba(52,211,153,0.25)',
      border: '1px solid rgba(52,211,153,0.5)',
      color: '#ecfdf5',
      borderRadius: 8,
      padding: '6px 0',
      cursor: 'pointer',
      fontSize: 12,
      fontWeight: 700
    }
  }, "\u21BB C\u1EADp nh\u1EADt ngay"), /*#__PURE__*/React.createElement("button", {
    onClick: onDismiss,
    style: {
      background: 'rgba(255,255,255,0.1)',
      border: '1px solid rgba(255,255,255,0.2)',
      color: '#ecfdf5',
      borderRadius: 8,
      padding: '6px 12px',
      cursor: 'pointer',
      fontSize: 12
    }
  }, "B\u1ECF qua")));
}

/* ─────────────────────────── SumPredPanel ─────────────────────────────── */
const SumPredPanel = memo(function SumPredPanel({
  data
}) {
  if (!data || !data.sums || data.sums.length === 0) return null;
  const top5 = data.sums.slice(0, 5);
  const maxScore = top5[0]?.score || 1;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(99,102,241,0.2)',
      borderRadius: 10,
      padding: '12px 14px',
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#6366f1',
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      marginBottom: 8
    }
  }, "\uD83C\uDFAF D\u1EF1 \u0111o\xE1n Sum (16 outcomes \xB7 Markov + z-score)", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#475569',
      fontWeight: 400,
      textTransform: 'none',
      marginLeft: 8
    }
  }, "\xB7 sum tr\u01B0\u1EDBc: ", data.prevSum, " \xB7 ", data.session)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      flexWrap: 'wrap'
    }
  }, top5.map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: s.sum,
    style: {
      flex: '1 1 80px',
      minWidth: 75,
      background: i === 0 ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.04)',
      border: `1px solid ${i === 0 ? 'rgba(99,102,241,0.4)' : 'rgba(255,255,255,0.08)'}`,
      borderRadius: 8,
      padding: '8px 10px',
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 22,
      fontWeight: 900,
      color: i === 0 ? '#a5b4fc' : '#e2e8f0'
    }
  }, s.sum), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: '#64748b',
      marginTop: 4
    }
  }, "z=", s.z, " \xB7 Mk ", s.mkProb, "%"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: s.z > 1 ? '#FF6B3D' : '#475569'
    }
  }, "gap ", s.curGap, s.avgGap ? `/${s.avgGap}` : '')))));
});

/* ─────────────────────────── App ──────────────────────────────────────── */
function App() {
  const [preds, setPreds] = useState([]);
  const [sumStats, setSumStats] = useState([]);
  const [maxScore, setMaxScore] = useState(1);
  const [history, setHistory] = useState([]);
  const [pivotRefreshCount, setPivotRefreshCount] = useState(0);
  // Refs store cheap signatures instead of whole payloads.
  const predsRef = React.useRef('');
  const historyRef = React.useRef('');
  // ETag refs — store server ETag per endpoint and send If-None-Match on polls
  // so the server returns 304 when nothing changed → skip all state updates
  const predETagRef = React.useRef(null);
  const histETagRef = React.useRef(null);
  const overdueETagRef = React.useRef(null);
  const statsETagRef = React.useRef(null);
  const predictBasisRef = React.useRef(null);
  const basisFlashTimerRef = React.useRef(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updated, setUpdated] = useState('—');
  const [toast, setToast] = useState(null);
  const [liveKy, setLiveKy] = useState(null);
  const [predictBasisKy, setPredictBasisKy] = useState(null);
  const [newestDrawTime, setNewestDrawTime] = useState(null);
  const [basisJustChanged, setBasisJustChanged] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [overdue, setOverdue] = useState(null);
  const [overdueLoading, setOverdueLoading] = useState(true);
  const [crawling, setCrawling] = useState(false);
  const [tripleSignal, setTripleSignal] = useState(null);
  const [modelContrib, setModelContrib] = useState(null);
  const [verdict, setVerdict] = useState(null);
  const [sumPreds, setSumPreds] = useState(null);
  const [hlHistoryCombo, setHlHistoryCombo] = useState(null);

  // Bingo18 operating hours: 06:00–22:00 Vietnam time (UTC+7)
  const isNowOperating = () => {
    const vnMin = (new Date().getUTCHours() + 7) % 24 * 60 + new Date().getUTCMinutes();
    return vnMin >= 360 && vnMin <= 1320;
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
        // Server is computing for the first time — auto-retry after 30s
        if (s?.computing) setTimeout(() => {
          statsETagRef.current = null;
          loadStatsRef.current();
        }, 30_000);
        // Server is recomputing in background (has stale cache) — retry after 8s to get fresh data
        if (r.headers.get('X-Stats-Computing') === '1') {
          setTimeout(() => {
            statsETagRef.current = null;
            loadStatsRef.current();
          }, 8_000);
        }
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
      const [pRaw, hRaw, sumRaw] = await Promise.all([fetch('/predict', {
        cache: 'no-cache',
        headers: predH
      }), fetch('/history?limit=800', {
        headers: histH
      }), fetch('/predict-sum', {
        cache: 'no-cache'
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
        const nextBasisKy = pRes.latestKy || null;
        const nextNewestTime = pRes.newestDrawTime || null;
        const nextSig = predsSignature(newPreds, nextBasisKy || pRes.total, nextNewestTime);
        if (nextSig !== predsRef.current) {
          predsRef.current = nextSig;
          setPreds(newPreds);
        }
        if (nextBasisKy && predictBasisRef.current && nextBasisKy !== predictBasisRef.current) {
          setBasisJustChanged(true);
          clearTimeout(basisFlashTimerRef.current);
          basisFlashTimerRef.current = setTimeout(() => setBasisJustChanged(false), 20_000);
        }
        predictBasisRef.current = nextBasisKy;
        setMaxScore(pRes.maxScore || 1);
        setPredictBasisKy(nextBasisKy);
        setNewestDrawTime(pRes.newestDrawTime || null);
        setTripleSignal(pRes.tripleSignal || null);
        setModelContrib(pRes.modelContrib || null);
        setVerdict(pRes.verdict || null);
        setSumStats(pRes.sumStats || []);
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
      // Sum prediction response
      if (sumRaw.ok) {
        try {
          setSumPreds(await sumRaw.json());
        } catch (_) {}
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
  useEffect(() => () => clearTimeout(basisFlashTimerRef.current), []);

  // ── SSE subscription ──────────────────────────────────────────────────
  useEffect(() => {
    let es;
    let reconnectTimer;
    let mounted = true;
    let everConnected = false;
    function connect() {
      if (!mounted) return;
      setSseConnected(false);
      es = new EventSource('/events');
      es.onopen = () => {
        if (!mounted) return;
        setSseConnected(true);
        if (everConnected) {
          // Reconnected after drop — might have missed a draw while offline.
          // Re-fetch without clearing ETags; server returns 304 if nothing changed, 200 if a new draw came in.
          loadRef.current(true);
        }
        everConnected = true;
      };
      es.addEventListener('new-draw', e => {
        if (!mounted) return;
        const info = JSON.parse(e.data);
        setLiveKy(info.latestKy);
        setToast(info);
        // Auto-refresh all data ~1.5s after new draw (server prewarm takes ~500ms).
        // Clear ETags to bypass 304 and force fresh data.
        setTimeout(() => {
          if (!mounted) return;
          predETagRef.current = null;
          histETagRef.current = null;
          overdueETagRef.current = null;
          statsETagRef.current = null;
          loadRef.current(true);
          loadStatsRef.current();
          loadOverdueRef.current();
          setPivotRefreshCount(c => c + 1);
        }, 1_500);
        // Stats recompute takes ~3-8s — retry once more to get fresh stats
        setTimeout(() => {
          if (!mounted) return;
          statsETagRef.current = null;
          loadStatsRef.current();
        }, 10_000);
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
  // - predict+history: every 60s during operating hours (06:00–22:00 VN), else every 5min
  // - stats+overdue:   every 5 minutes (heavy O(N²) backtest, changes slowly)
  // SSE handles instant updates when a new draw appears; polling is just a safety net.
  useEffect(() => {
    function isOperatingHours() {
      const vnMin = (new Date().getUTCHours() + 7) % 24 * 60 + new Date().getUTCMinutes();
      return vnMin >= 360 && vnMin <= 1320; // 06:00–22:00 VN
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
    onDismiss: () => setToast(null),
    onRefresh: () => {
      predETagRef.current = null;
      histETagRef.current = null;
      overdueETagRef.current = null;
      statsETagRef.current = null;
      loadRef.current(true);
      loadStatsRef.current();
      loadOverdueRef.current();
      setPivotRefreshCount(c => c + 1);
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: C.header
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: C.logo
  }, "\uD83D\uDCCA Bingo18 Analyzer"), /*#__PURE__*/React.createElement("div", {
    style: C.sub,
    className: "hide-mobile"
  }, "Ph\xE2n t\xEDch th\u1ED1ng k\xEA combo \xB7 Realtime SSE \xB7 Walk-forward Backtest")), /*#__PURE__*/React.createElement("div", {
    className: "header-actions"
  }, /*#__PURE__*/React.createElement("a", {
    href: "/history-table",
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 13,
      fontWeight: 700,
      color: '#fff',
      textDecoration: 'none',
      padding: '7px 16px',
      borderRadius: 8,
      background: 'linear-gradient(135deg,#6366f1,#818cf8)',
      border: '1px solid rgba(129,140,248,0.5)',
      boxShadow: '0 2px 8px rgba(99,102,241,0.3)'
    }
  }, "\uD83D\uDCC5 L\u1ECBch s\u1EED"), /*#__PURE__*/React.createElement("a", {
    href: "https://lotto535.fly.dev",
    target: "_blank",
    rel: "noopener",
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 13,
      fontWeight: 700,
      color: '#fff',
      textDecoration: 'none',
      padding: '7px 16px',
      borderRadius: 8,
      background: 'linear-gradient(135deg,#059669,#10b981)',
      border: '1px solid rgba(16,185,129,0.5)',
      boxShadow: '0 2px 8px rgba(16,185,129,0.25)'
    }
  }, " \uD83C\uDFB0 Loto 5/35"), /*#__PURE__*/React.createElement("span", {
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
    title: "Bingo18 m\u1EDF 06:00\u201322:00 VN. Kh\xF4ng c\xF3 k\u1EF3 m\u1EDBi ngo\xE0i gi\u1EDD n\xE0y."
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
      try {
        const r = await fetch('/crawl', {
          method: 'POST',
          cache: 'no-store'
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j?.ok === false) throw new Error(j?.message || `API ${r.status}`);

        // Always force-refresh all views after manual crawl trigger.
        predETagRef.current = null;
        histETagRef.current = null;
        overdueETagRef.current = null;
        statsETagRef.current = null;
        await Promise.all([loadRef.current(true), loadStatsRef.current(), loadOverdueRef.current()]);
        setPivotRefreshCount(c => c + 1);
      } catch (e) {
        setError(e.message || 'Không thể cập nhật dữ liệu');
      } finally {
        setCrawling(false);
      }
    },
    disabled: crawling || loading
  }, crawling ? 'Đang tải…' : loading ? 'Loading…' : '⬇ Cập nhật'))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'rgba(251,191,36,0.08)',
      borderBottom: '1px solid rgba(251,191,36,0.25)',
      padding: '8px 24px',
      textAlign: 'center',
      fontSize: 12,
      color: '#fbbf24',
      fontWeight: 600,
      position: 'sticky',
      top: 0,
      zIndex: 100,
      backdropFilter: 'blur(8px)'
    }
  }, "\u26A0\uFE0F H\u1EC7 th\u1ED1ng n\xE0y ch\u1ECDn combo \u0111a d\u1EA1ng \u2014 kh\xF4ng d\u1EF1 \u0111o\xE1n k\u1EBFt qu\u1EA3. Bingo18 l\xE0 tr\xF2 ch\u01A1i ng\u1EABu nhi\xEAn (autocorr p=0.41)."), /*#__PURE__*/React.createElement("div", {
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
      gap: 12,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: C.label
  }, "Top 10 Combo d\u1EF1 \u0111o\xE1n"), updated !== '—' && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: '#475569'
    }
  }, "\u27F3 ", updated), predictBasisKy && (() => {
    // If newestDrawTime is significantly newer than latestKyRecord, show latest draw time
    // (happens when Source A/B fails to promote Source C records with ky)
    const latestTime = newestDrawTime ? new Date(newestDrawTime) : null;
    const hhmm = latestTime ? latestTime.toLocaleTimeString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Ho_Chi_Minh'
    }) : null;
    return /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        color: '#94a3b8'
      }
    }, "D\u1EF1a tr\xEAn k\u1EF3 #", predictBasisKy, hhmm ? ` · lần vẽ lúc ${hhmm}` : '');
  })(), basisJustChanged && predictBasisKy && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: '#34d399',
      border: '1px solid rgba(52,211,153,0.35)',
      background: 'rgba(52,211,153,0.08)',
      borderRadius: 999,
      padding: '3px 8px',
      fontWeight: 700
    }
  }, "\u0110\xE3 nh\u1EADn k\u1EF3 m\u1EDBi #", predictBasisKy)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#475569'
    },
    className: "hide-mobile"
  }, "% = t\u1EF7 l\u1EC7 trong top-10 \xB7 X.Xx = s\u1ED1 l\u1EA7n qu\xE1 h\u1EA1n so v\u1EDBi k\u1EF3 v\u1ECDng (1x = b\xECnh th\u01B0\u1EDDng, >1x = l\xE2u ch\u01B0a v\u1EC1)")), /*#__PURE__*/React.createElement(TripleSignalCard, {
    signal: tripleSignal,
    anyTriple: overdue?.anyTriple
  }), /*#__PURE__*/React.createElement(SumPredPanel, {
    data: sumPreds
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
  }, modelContrib._uniform ? '⚪ Chế độ: Diversity Selection' : 'Đóng góp model thực tế', modelContrib._uniform && /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 6,
      color: '#94a3b8',
      fontWeight: 400,
      textTransform: 'none'
    }
  }, "\xB7 kh\xF4ng ph\xE1t hi\u1EC7n pattern \u2192 ch\u1ECDn combo \u0111a d\u1EA1ng, ph\xE2n b\u1ED5 \u0111\u1EC1u")), !modelContrib._uniform ? /*#__PURE__*/React.createElement("div", {
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
  }, m.label, " ", modelContrib[m.key], "%")))), hlHistoryCombo && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 10,
      padding: '6px 12px',
      background: 'rgba(99,102,241,0.12)',
      border: '1px solid rgba(99,102,241,0.35)',
      borderRadius: 8,
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#a5b4fc',
      fontWeight: 700
    }
  }, "\uD83D\uDD0D L\u1ECDc combo t\u1EEB l\u1ECBch s\u1EED: ", hlHistoryCombo.split('').join('-')), /*#__PURE__*/React.createElement("button", {
    onClick: () => setHlHistoryCombo(null),
    style: {
      marginLeft: 'auto',
      background: 'none',
      border: 'none',
      color: '#6366f1',
      cursor: 'pointer',
      fontSize: 14,
      fontWeight: 700,
      padding: '0 4px'
    }
  }, "\u2715")), /*#__PURE__*/React.createElement("div", {
    className: "grid3"
  }, preds.length === 0 && !loading && /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#64748b',
      fontSize: 13
    }
  }, "Ch\u01B0a c\xF3 d\u1EF1 \u0111o\xE1n."), preds.map((p, i) => {
    const pKey = p.combo.split('-').sort().join('');
    const isDimmed = hlHistoryCombo && pKey !== hlHistoryCombo;
    const isMatch = hlHistoryCombo && pKey === hlHistoryCombo;
    return /*#__PURE__*/React.createElement("div", {
      key: `${predictBasisKy || 'base'}:${p.combo}`,
      style: {
        opacity: isDimmed ? 0.28 : 1,
        transition: 'opacity 0.15s',
        outline: isMatch ? '2px solid #6366f1' : 'none',
        borderRadius: 12
      }
    }, /*#__PURE__*/React.createElement(PredCard, {
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
      rankStrength: p.rankStrength,
      calBuckets: stats?.calBuckets,
      isUniform: !!modelContrib?._uniform
    }));
  }))), overdue && /*#__PURE__*/React.createElement("div", {
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
      marginBottom: 28,
      padding: 0,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      borderBottom: '1px solid rgba(99,102,241,0.25)',
      background: 'rgba(255,255,255,0.02)',
      padding: '0 20px',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      color: '#a5b4fc',
      padding: '10px 12px 10px 0',
      borderBottom: '2px solid #6366f1',
      marginBottom: -1
    }
  }, "\uD83D\uDCCA L\u1ECBch s\u1EED theo gi\u1EDD"), /*#__PURE__*/React.createElement("a", {
    href: "/history-table",
    target: "_blank",
    rel: "noopener",
    style: {
      fontSize: 13,
      color: '#64748b',
      padding: '10px 12px',
      textDecoration: 'none',
      borderRadius: 6,
      transition: 'color 0.15s'
    },
    onMouseEnter: e => e.currentTarget.style.color = '#a5b4fc',
    onMouseLeave: e => e.currentTarget.style.color = '#64748b'
  }, "\u2197 B\u1EA3ng \u0111\u1EA7y \u0111\u1EE7")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '18px 20px'
    }
  }, /*#__PURE__*/React.createElement(DrawPivotTable, {
    refreshKey: pivotRefreshCount,
    onSelect: setHlHistoryCombo
  }))), sumStats.length > 0 && /*#__PURE__*/React.createElement("div", {
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
    href: '/history-table',
    label: 'Lịch sử kết quả'
  }, {
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