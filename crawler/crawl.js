'use strict'
/**
 * crawler/crawl.js
 * Fetches Bingo18 results from xoso.net.vn.
 *
 * Two modes:
 *   run()       – crawl the live page (latest ~15 draws). Used by the server loop.
 *   crawlAll()  – paginate through all history (default: 60 pages × 15 = ~900 draws).
 *                 Usage: node crawler/crawl.js --all
 */
const axios = require('axios')
const cheerio = require('cheerio')
const fs = require('fs-extra')
const path = require('path')
const crypto = require('crypto')

const FILE = path.join(__dirname, '../dataset/history.json')
// Primary + inline backup sources (xomo.com as fallback)
const SOURCES = {
  primary: { name: 'xoso.net.vn', liveUrl: 'https://xoso.net.vn/xs-bingo-18.html', moreUrl: 'https://xoso.net.vn/XSDienToan/GetKetQuaBinGo18More' },
  backup: { name: 'xomo.com', liveUrl: 'https://xomo.com/ket-qua/xo-so-kien-thiet/bingo-18', moreUrl: null },
}
const BASE_URL = 'https://xoso.net.vn'
const LIVE_URL = SOURCES.primary.liveUrl
const MORE_URL = SOURCES.primary.moreUrl
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Referer': 'https://www.google.com.vn/',
}

/** Derive a stable id from ky + balls — idempotent across re-crawls. */
function makeId(ky, n1, n2, n3) {
  return crypto.createHash('sha1').update(`ky-${ky}-${n1}-${n2}-${n3}`).digest('hex').slice(0, 16)
}

/** Classify the draw pattern. */
function classify(n1, n2, n3) {
  if (n1 === n2 && n2 === n3) return 'triple'
  if (n1 === n2 || n2 === n3 || n1 === n3) return 'pair'
  return 'normal'
}

/** Parse draw records from a cheerio-loaded HTML fragment. */
function parseBlocks($) {
  const results = []
  $('.bingo_tructiep').each((_, block) => {
    const kyText = $(block).find('.bingo_ky').first().text().trim()
    const kyMatch = kyText.match(/#(\d+)/)
    if (!kyMatch) return
    const ky = kyMatch[1]

    // Extract "dd/mm/yyyy HH:MM" → ISO drawTime
    const dtMatch = kyText.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/)
    let drawTime = null
    if (dtMatch) {
      const [d, m, y] = dtMatch[1].split('/')
      drawTime = `${y}-${m}-${d}T${dtMatch[2]}:00+07:00`  // Bingo18 is Vietnam time
    }

    $(block).find('.rowKQbingo').each((j, row) => {
      const balls = []
      $(row).find('.bingo_ball').each((_, el) => {
        const v = parseInt($(el).text().trim(), 10)
        if (v >= 1 && v <= 6) balls.push(v)
      })
      if (balls.length < 3) return
      const [n1, n2, n3] = balls
      results.push({
        id: makeId(ky, n1, n2, n3),
        ky,
        drawTime,
        n1, n2, n3,
        sum: n1 + n2 + n3,
        pattern: classify(n1, n2, n3),
      })
    })
  })
  return results
}

/** Fetch and parse the live page — primary source, with fallback + rate limiting. */
async function crawl() {
  // Try primary source first (xoso.net.vn)
  try {
    const res = await axios.get(LIVE_URL, { timeout: 10_000, headers: HEADERS })
    const result = parseBlocks(cheerio.load(res.data))
    // Rate limit: 300ms delay after successful fetch to respect target site
    await new Promise(r => setTimeout(r, 300))
    return result
  } catch (err) {
    console.warn(`[crawl] Primary source failed (${err.message}), trying backup...`)
    // Fallback to xomo.com if primary fails (with shorter wait)
    try {
      const res = await axios.get(SOURCES.backup.liveUrl, { timeout: 8_000, headers: HEADERS })
      const result = parseBlocks(cheerio.load(res.data))
      await new Promise(r => setTimeout(r, 200))
      return result
    } catch (errBackup) {
      console.error(`[crawl] Backup source also failed: ${errBackup.message}`)
      return []
    }
  }
}

/** Fetch one paginated page of history (pageIndex = 1, 2, 3…). Used by crawlAll().
 * Only works for primary source (xoso.net.vn); xomo doesn't support pagination.
 */
async function crawlPage(pageIndex) {
  if (!MORE_URL) return []
  const res = await axios.get(MORE_URL, {
    params: { pageIndex },
    timeout: 12_000,
    headers: HEADERS,
  })
  if (!res.data || res.data.trim().length < 50) return []
  return parseBlocks(cheerio.load(res.data))
}



/** Merge records into the history file, sort newest first.
 * @returns {{ total, added, newRecords }}
 */
async function merge(incoming) {
  const old = await fs.readJSON(FILE).catch(() => [])
  // Index by id and ky for fast lookup
  const byId = new Map(old.map(o => [o.id, o]))
  const byKy = new Map(old.map(o => [o.ky, o]))
  const newRecords = []

  for (const r of incoming) {
    const existing = byId.get(r.id) || byKy.get(r.ky)
    if (!existing) {
      // Brand-new record
      old.push(r)
      byId.set(r.id, r)
      byKy.set(r.ky, r)
      newRecords.push(r)
    } else if (!existing.drawTime && r.drawTime) {
      // Back-fill draw time that was missing (e.g. xsmn got it first, xoso fills in time)
      existing.drawTime = r.drawTime
      delete existing.drawDate  // replace date-only field with full ISO timestamp
    }
  }

  old.sort((a, b) => Number(b.ky) - Number(a.ky))
  await fs.ensureFile(FILE)
  await fs.writeJSON(FILE, old, { spaces: 2 })
  return { total: old.length, added: newRecords.length, newRecords }
}

/** Crawl latest draws — tries primary first, falls back to backup if needed. */
async function run() {
  let records = []
  try {
    records = await crawl()
  } catch (e) {
    console.error('[crawl] Error:', e.message)
  }

  const result = await merge(records)
  console.log(`[crawl] total: ${result.total} records (+${result.added} new)`)
  return result
}

/** Crawl full history via pagination (run once to seed database).
 * @param {number} maxPages – how many pages to fetch (default 60 ≈ 6 days)
 */
async function crawlAll(maxPages = 60) {
  console.log(`[crawlAll] fetching up to ${maxPages} pages of history…`)
  let totalAdded = 0

  for (let page = 1; page <= maxPages; page++) {
    try {
      const records = await crawlPage(page)
      if (records.length === 0) {
        console.log(`[crawlAll] page ${page}: empty — stopping`)
        break
      }
      const result = await merge(records)
      totalAdded += result.added
      process.stdout.write(`  page ${String(page).padStart(3)}: ${result.added} new | total: ${result.total}\r`)
      // polite delay
      await new Promise(r => setTimeout(r, 400))
    } catch (err) {
      console.error(`\n[crawlAll] page ${page} error: ${err.message}`)
    }
  }
  const final = await fs.readJSON(FILE).catch(() => [])
  console.log(`\n[crawlAll] Done. Added ${totalAdded} | total on disk: ${final.length}`)
}

module.exports = { crawl, crawlPage, crawlAll, run, merge }

if (require.main === module) {
  const all = process.argv.includes('--all')
  const pages = parseInt(process.argv.find(a => a.startsWith('--pages='))?.split('=')[1]) || 60
  if (all) {
    crawlAll(pages).catch(err => { console.error(err.message); process.exit(1) })
  } else {
    run().catch(err => { console.error('[crawl] ERROR:', err.message); process.exit(1) })
  }
}

