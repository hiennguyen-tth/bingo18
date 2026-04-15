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
const BACKUP_FILE = `${FILE}.bak`
// Source config: old xoso web is primary (currently fastest/freshest).
const SOURCES = {
  primary: { name: 'xoso.net.vn', liveUrl: 'https://xoso.net.vn/xs-bingo-18.html', moreUrl: 'https://xoso.net.vn/XSDienToan/GetKetQuaBinGo18More' },
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

async function atomicWriteJSON(file, data) {
  const tmp = `${file}.tmp`
  await fs.writeJSON(tmp, data, { spaces: 2 })
  await fs.move(tmp, file, { overwrite: true })
}

async function loadHistorySafe() {
  const exists = await fs.pathExists(FILE)
  if (!exists) return []

  const parsed = await fs.readJSON(FILE).catch(() => null)
  if (Array.isArray(parsed)) return parsed

  // If the primary file is corrupted, attempt recovery from backup.
  const backup = await fs.readJSON(BACKUP_FILE).catch(() => null)
  if (Array.isArray(backup) && backup.length > 0) {
    console.error(`[crawl] WARNING: history.json corrupted, recovering from backup (${backup.length} records)`)
    await atomicWriteJSON(FILE, backup)
    return backup
  }

  throw new Error('history.json corrupted and no valid backup found; refusing to overwrite to prevent data loss')
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

/** Fetch and parse latest draws.
 *  Strategy:
 *    1) xoso HTML live page (old web) as primary source.
 *    2) xoso AJAX endpoint only as fallback when HTML fails/empty.
 *
 *  Cache-busting: appending _t=<timestamp> forces a fresh fetch past CDN edge caches
 *  that may ignore Cache-Control headers.
 */
async function crawl() {
  const ts = Date.now()
  const bust = `_t=${ts}`   // CDN cache-buster

  const fetchHtml = async () => {
    try {
      const r = await axios.get(`${LIVE_URL}?${bust}`, { timeout: 10_000, headers: HEADERS })
      return parseBlocks(cheerio.load(r.data))
    } catch (err) {
      console.warn(`[crawl] ${SOURCES.primary.name} HTML failed: ${err.message}`)
      return []
    }
  }

  const fetchAjax = async () => {
    try {
      const r = await axios.get(MORE_URL, {
        params: { pageIndex: 1, _t: ts },
        timeout: 8_000,
        headers: HEADERS,
      })
      return (r.data && r.data.trim().length > 50) ? parseBlocks(cheerio.load(r.data)) : []
    } catch (err) {
      console.warn(`[crawl] AJAX fallback failed: ${err.message}`)
      return []
    }
  }

  const htmlRecs = await fetchHtml()
  if (htmlRecs.length > 0) {
    const maxKy = Math.max(...htmlRecs.map(r => Number(r.ky)))
    console.log(`[crawl] source:html count:${htmlRecs.length} maxKy:${maxKy}`)
    await new Promise(r => setTimeout(r, 120))
    return htmlRecs
  }

  const ajaxRecs = await fetchAjax()
  const maxKy = ajaxRecs.length ? Math.max(...ajaxRecs.map(r => Number(r.ky))) : '—'
  console.log(`[crawl] source:ajax-fallback count:${ajaxRecs.length} maxKy:${maxKy}`)

  // Polite delay after fetch
  await new Promise(r => setTimeout(r, 150))
  return ajaxRecs
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
  const old = await loadHistorySafe()
  // Index by id and ky for fast lookup
  const byId = new Map(old.map(o => [o.id, o]))
  const byKy = new Map(old.map(o => [o.ky, o]))
  const newRecords = []
  let patched = 0

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
      patched++
    }
  }

  // Nothing changed: keep file as-is to avoid unnecessary watcher invalidation.
  if (newRecords.length === 0 && patched === 0) {
    return { total: old.length, added: 0, newRecords, patched: 0, changed: false }
  }

  old.sort((a, b) => Number(b.ky) - Number(a.ky))
  await fs.ensureFile(FILE)
  await atomicWriteJSON(FILE, old)
  // Keep a last-known-good snapshot for corruption recovery.
  await atomicWriteJSON(BACKUP_FILE, old)
  return { total: old.length, added: newRecords.length, newRecords, patched, changed: true }
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

