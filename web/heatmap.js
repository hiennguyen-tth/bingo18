/**
 * web/heatmap.jsx
 * Frequency heatmap for Bingo18 numbers (positions N1/N2/N3, values 1-6).
 * Loaded by index.html BEFORE app.jsx; assigned to window.Heatmap so
 * app.jsx can reference it across Babel-compiled script boundaries.
 */
window.Heatmap = function Heatmap({
  history
}) {
  const {
    useMemo
  } = React;
  const data = useMemo(() => {
    const counts = {};
    for (const pos of ['n1', 'n2', 'n3']) {
      for (let n = 1; n <= 6; n++) {
        counts[`${pos}-${n}`] = 0;
      }
    }
    for (const r of history) {
      if (r.n1) counts[`n1-${r.n1}`]++;
      if (r.n2) counts[`n2-${r.n2}`]++;
      if (r.n3) counts[`n3-${r.n3}`]++;
    }
    const maxV = Math.max(...Object.values(counts), 1);
    return {
      counts,
      maxV
    };
  }, [history]);
  const cellBg = v => {
    const alpha = 0.08 + v / data.maxV * 0.85;
    return `rgba(99,102,241,${alpha.toFixed(2)})`;
  };
  const S = {
    title: {
      fontSize: 11,
      fontWeight: 700,
      color: '#6366f1',
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      marginBottom: 12
    },
    grid: {
      display: 'grid',
      gridTemplateColumns: '44px repeat(6, 1fr)',
      gap: 4
    },
    colHead: {
      textAlign: 'center',
      fontSize: 12,
      color: '#64748b',
      padding: '4px 0'
    },
    rowLabel: {
      fontSize: 11,
      color: '#94a3b8',
      display: 'flex',
      alignItems: 'center',
      fontWeight: 600
    },
    cell: {
      borderRadius: 6,
      padding: '9px 0',
      textAlign: 'center',
      fontSize: 11,
      color: '#e2e8f0',
      border: '1px solid rgba(255,255,255,0.04)',
      transition: 'filter 0.15s',
      cursor: 'default'
    }
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: S.title
  }, "Number Position Heatmap"), /*#__PURE__*/React.createElement("div", {
    style: S.grid
  }, /*#__PURE__*/React.createElement("div", null), [1, 2, 3, 4, 5, 6].map(n => /*#__PURE__*/React.createElement("div", {
    key: n,
    style: S.colHead
  }, n)), ['n1', 'n2', 'n3'].map(pos => /*#__PURE__*/React.createElement(React.Fragment, {
    key: pos
  }, /*#__PURE__*/React.createElement("div", {
    style: S.rowLabel
  }, pos.toUpperCase()), [1, 2, 3, 4, 5, 6].map(n => {
    const v = data.counts[`${pos}-${n}`] || 0;
    return /*#__PURE__*/React.createElement("div", {
      key: n,
      style: {
        ...S.cell,
        background: cellBg(v)
      },
      title: `${pos.toUpperCase()}=${n}: ${v} lần`
    }, v);
  })))));
};