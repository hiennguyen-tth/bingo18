'use strict'
/**
 * scripts/dedup.js
 * Removes duplicate Source C (no-ky) records from history.json using canonical 6-min slots.
 *
 * Logic:
 *   1. Snap every record's drawTime to the canonical 6-minute Bingo18 slot
 *      (06:00, 06:06, …, 21:54 VN time — 160 slots/day).
 *   2. For each canonical-slot+day, if BOTH a ky-record AND a no-ky record exist,
 *      remove the no-ky record (it's a duplicate from bingo18.top with a time offset).
 *
 * Usage:  node scripts/dedup.js            — dry run (shows what would be removed)
 *         node scripts/dedup.js --write    — actually write cleaned history.json
 */
const fs = require('fs-extra')
const path = require('path')
const { canonicalSlotInfo } = require('../crawler/crawl')

const FILE = path.join(__dirname, '../dataset/history.json')

async function dedup() {
    const data = await fs.readJSON(FILE)
    console.log(`Loaded ${data.length} records`)

    // Group by canonical slot + day
    const groups = {}  // "YYYY-MM-DD|HH:MM" → { withKy: [...], noKy: [...] }
    const noSlot = []  // records without parseable drawTime

    for (const r of data) {
        const ci = canonicalSlotInfo(r.drawTime)
        if (!ci) {
            noSlot.push(r)
            continue
        }
        const key = `${ci.date}|${ci.slot}`
        if (!groups[key]) groups[key] = { withKy: [], noKy: [] }
        if (r.ky) groups[key].withKy.push(r)
        else groups[key].noKy.push(r)
    }

    let removedCount = 0
    const removeIds = new Set()

    for (const [key, g] of Object.entries(groups)) {
        if (g.withKy.length > 0 && g.noKy.length > 0) {
            for (const r of g.noKy) {
                removeIds.add(r.id)
                removedCount++
            }
        }
        // Also dedup multiple ky-records at same slot (keep highest ky)
        if (g.withKy.length > 1) {
            g.withKy.sort((a, b) => Number(b.ky) - Number(a.ky))
            for (let i = 1; i < g.withKy.length; i++) {
                removeIds.add(g.withKy[i].id)
                removedCount++
            }
        }
    }

    console.log(`Records to remove: ${removedCount}`)
    console.log(`Records without slot (kept): ${noSlot.length}`)

    const cleaned = data.filter(r => !removeIds.has(r.id))
    // Remove legacy fields
    const final = cleaned.map(r => {
        const { crawledAt, dateStr, ...rest } = r
        return rest
    })
    // Sort: ky desc, then drawTime desc
    final.sort((a, b) => {
        const ka = a.ky ? Number(a.ky) : 0
        const kb = b.ky ? Number(b.ky) : 0
        if (ka && kb) return kb - ka
        if (ka) return -1
        if (kb) return 1
        return (b.drawTime || '').localeCompare(a.drawTime || '')
    })

    console.log(`Result: ${final.length} records (removed ${data.length - final.length})`)
    console.log(`  With ky: ${final.filter(r => r.ky).length}`)
    console.log(`  Without ky: ${final.filter(r => !r.ky).length}`)
    console.log(`  With full drawTime: ${final.filter(r => r.drawTime && !r.drawTime.includes('T00:00:00')).length}`)

    if (process.argv.includes('--write')) {
        const bak = `${FILE}.pre-dedup.bak`
        await fs.copy(FILE, bak)
        console.log(`Backup: ${bak}`)
        await fs.writeJSON(FILE, final, { spaces: 2 })
        console.log(`Written: ${FILE}`)
    } else {
        console.log('\nDry run. Use --write to apply changes.')
    }
}

dedup().catch(err => { console.error(err); process.exit(1) })
