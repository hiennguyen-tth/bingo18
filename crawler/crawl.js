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
const BASE_URL = 'https://xoso.net.vn'
const LIVE_URL = BASE_URL + '/xs-bingo-18.html'
const MORE_URL = BASE_URL + '/XSDienToan/GetKetQuaBinGo18More'
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; bingo-ai-bot/1.0)', 'Referer': LIVE_URL }

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

/** Fetch and parse the live page (latest ~15 draws). */
async function crawl() {
  const res = await axios.get(LIVE_URL, { timeout: 15_000, headers: HEADERS })
  return parseBlocks(cheerio.load(res.data))
}

/** Fetch one paginated page of history (pageIndex = 1, 2, 3…). */
async function crawlPage(pageIndex) {
  const res = await axios.get(MORE_URL, {
    params: { pageIndex },
    timeout: 15_000,
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
  const existingIds = new Set(old.map(o => o.id))
  const existingKys = new Set(old.map(o => o.ky))
  const newRecords = []

  for (const r of incoming) {
    if (!existingIds.has(r.id) && !existingKys.has(r.ky)) {
      old.push(r)
      existingIds.add(r.id)
      existingKys.add(r.ky)
      newRecords.push(r)
    }
  }

  old.sort((a, b) => Number(b.ky) - Number(a.ky))
  await fs.ensureFile(FILE)
  await fs.writeJSON(FILE, old, { spaces: 2 })
  return { total: old.length, added: newRecords.length, newRecords }
}

/** Crawl latest draws (used by the 60s server loop). */
async function run() {
  const latest = await crawl()
  const result = await merge(latest)
  console.log(`[crawl] records: ${result.total} (+${result.added} new)`)
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

