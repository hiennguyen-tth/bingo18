'use strict'
const fs = require('fs-extra')
const data = fs.readJSONSync('./dataset/history.json')
const chron = [...data].sort((a, b) => Number(a.ky) - Number(b.ky))

function classify(n1, n2, n3) {
    if (n1 === n2 && n2 === n3) return 'triple'
    if (n1 === n2 || n2 === n3 || n1 === n3) return 'pair'
    return 'normal'
}

const records = chron.map((r, i) => ({
    ...r,
    i,
    pattern: r.pattern || classify(r.n1, r.n2, r.n3),
}))

const triples = records.filter(r => r.pattern === 'triple')

console.log('=== TOTAL TRIPLES:', triples.length, 'in', chron.length, 'draws ===')
console.log('Triple frequency: 1 per', (chron.length / triples.length).toFixed(1), 'draws')

// Gap between consecutive triples
const gaps = []
for (let i = 1; i < triples.length; i++) {
    gaps.push(triples[i].i - triples[i - 1].i)
}
const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length
const stdGap = Math.sqrt(gaps.map(g => (g - avgGap) ** 2).reduce((a, b) => a + b, 0) / gaps.length)
console.log('Triple INTER-GAP — avg:', avgGap.toFixed(1), '| std:', stdGap.toFixed(1), '| min:', Math.min(...gaps), '| max:', Math.max(...gaps))

// Time-of-day counts
const hourCounts = {}
triples.forEach(r => {
    if (!r.drawTime) return
    const h = new Date(r.drawTime).getHours()
    hourCounts[h] = (hourCounts[h] || 0) + 1
})
console.log('\nTriples by hour (VN time):')
Object.entries(hourCounts).sort((a, b) => +a[0] - +b[0]).forEach(([h, c]) => {
    const pct = (c / triples.length * 100).toFixed(1)
    console.log('  ' + String(h).padStart(2, '0') + ':xx   ' + c + ' times  (' + pct + '%)')
})

// Pattern of 3 draws BEFORE each triple
const beforeTriple = { triple: 0, pair: 0, normal: 0 }
const beforeTripleSeq = {}
triples.forEach(r => {
    if (r.i < 3) return
    const prev3 = [records[r.i - 1], records[r.i - 2], records[r.i - 3]]
    const key = prev3.map(x => x.pattern[0]).join('')  // e.g. "pnn"
    beforeTripleSeq[key] = (beforeTripleSeq[key] || 0) + 1
    prev3.forEach(x => { beforeTriple[x.pattern]++ })
})
console.log('\nPattern distribution in 3 draws before triple:')
const totalBefore = beforeTriple.pair + beforeTriple.normal + beforeTriple.triple
console.log('  pair:', beforeTriple.pair, '(' + (beforeTriple.pair / totalBefore * 100).toFixed(1) + '%) | normal:', beforeTriple.normal, '(' + (beforeTriple.normal / totalBefore * 100).toFixed(1) + '%) | triple:', beforeTriple.triple)
console.log('\nTop sequences before triple (t/p/n = triple/pair/normal, oldest→newest):')
Object.entries(beforeTripleSeq).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => {
    console.log('  [' + k[2] + '] [' + k[1] + '] [' + k[0] + '] → triple: ' + v + ' times  (' + (v / triples.length * 100).toFixed(1) + '%)')
})

// Compare: base rate pair/normal in overall data
const allPat = { triple: 0, pair: 0, normal: 0 }
records.forEach(r => { allPat[r.pattern]++ })
console.log('\nOverall distribution: triple=' + (allPat.triple / records.length * 100).toFixed(1) + '% | pair=' + (allPat.pair / records.length * 100).toFixed(1) + '% | normal=' + (allPat.normal / records.length * 100).toFixed(1) + '%')
console.log('Expected if random: triple=2.8% | pair=41.7% | normal=55.6%')

// Triple by digit
const tripleVal = {}
triples.forEach(r => { tripleVal[r.n1] = (tripleVal[r.n1] || 0) + 1 })
console.log('\nTriple by digit:')
Object.entries(tripleVal).sort((a, b) => +a[0] - +b[0]).forEach(([d, c]) => {
    console.log('  ' + d + d + d + ': ' + c + ' times  (' + (c / triples.length * 100).toFixed(1) + '%)')
})

// Gap sizes for each individual triple combo
console.log('\nPer-triple-combo overdue stats:')
const TRIPLES = ['1-1-1', '2-2-2', '3-3-3', '4-4-4', '5-5-5', '6-6-6']
TRIPLES.forEach(tp => {
    const idxs = records.filter(r => r.combo === tp || (r.n1 + '-' + r.n2 + '-' + r.n3) === tp).map(r => r.i)
    const lastSeen = idxs.length ? records.length - 1 - idxs[idxs.length - 1] : records.length
    const innerGaps = []
    for (let i = 1; i < idxs.length; i++) innerGaps.push(idxs[i] - idxs[i - 1])
    const avg = innerGaps.length ? (innerGaps.reduce((a, b) => a + b, 0) / innerGaps.length).toFixed(1) : 'N/A'
    const std = innerGaps.length > 1
        ? Math.sqrt(innerGaps.map(g => (g - parseFloat(avg)) ** 2).reduce((a, b) => a + b, 0) / innerGaps.length).toFixed(1)
        : 'N/A'
    const stability = (innerGaps.length > 1 && std !== 'N/A') ? (parseFloat(avg) / parseFloat(std)).toFixed(2) : 'N/A'
    console.log('  ' + tp + ' | appeared:', idxs.length, '| lastSeen:', lastSeen, 'draws ago | avgGap:', avg, '| std:', std, '| stability:', stability)
})
