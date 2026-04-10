'use strict'
const fs = require('fs')
const data = JSON.parse(fs.readFileSync('dataset/history.json', 'utf8'))

const byKy = new Map()
for (const r of data) {
    if (!byKy.has(r.ky) || r.drawTime) {
        byKy.set(r.ky, r)
    }
}
const clean = [...byKy.values()].sort((a, b) => Number(b.ky) - Number(a.ky))
// Remove legacy crawledAt / dateStr fields
const final = clean.map(r => {
    const { crawledAt, dateStr, ...rest } = r
    return rest
})

fs.writeFileSync('dataset/history.json', JSON.stringify(final, null, 2))
console.log('Before:', data.length, '→ After:', final.length, '(removed', data.length - final.length, 'dupes)')
console.log('With drawTime:', final.filter(r => r.drawTime).length)
console.log('Without drawTime:', final.filter(r => !r.drawTime).length)
