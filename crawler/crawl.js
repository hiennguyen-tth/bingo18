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
// Source: xoso.net.vn — HTML + AJAX parallel, merge unique records.
// HTML page: ~700ms, 122KB — has NEWER kỳ (updated instantly by xoso).
// AJAX endpoint: ~200ms, 15KB — server-side cached, lags 5–15 kỳ behind HTML.
// Strategy: fetch both simultaneously, union by id/ky → always gets the freshest set.
const LIVE_URL = 'https://xoso.net.vn/xs-bingo-18.html'
const AJAX_URL = 'https://xoso.net.vn/XSDienToan/GetKetQuaBinGo18More'
const BASE_URL = 'https://xoso.net.vn'
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

/** Fetch and parse latest draws — HTML + AJAX in parallel, merge unique records.
 *
 *  Benchmark (xoso.net.vn):
 *    HTML page: ~700ms, 122KB — always contains the freshest kỳ (published instantly)
 *    AJAX endpoint: ~200ms, 15KB — server-side cached, typically lags 5–15 kỳ behind HTML
 *
 *  Conclusion: AJAX alone misses the latest kỳ. HTML alone is slow. Parallel merge gives
 *  the union: real-time freshness from HTML, AJAX as a fast backup if HTML is temporarily
 *  slow or returns stale data. Total per-tick cost: 2 requests (rate-friendly).
 */
async function crawl() {
  const ts = Date.now()

  const fetchHtml = async () => {
    try {
      const r = await axios.get(`${LIVE_URL}?_t=${ts}`, { timeout: 10_000, headers: HEADERS })
      const recs = parseBlocks(cheerio.load(r.data))
      return recs
    } catch (err) {
      console.warn(`[crawl] html failed: ${err.message}`)
      return []
    }
  }

  const fetchAjax = async () => {
    try {
      const r = await axios.get(AJAX_URL, {
        params: { pageIndex: 1, _t: ts },
        timeout: 8_000,
        headers: HEADERS,
      })
      return (r.data && r.data.trim().length > 50) ? parseBlocks(cheerio.load(r.data)) : []
    } catch (err) {
      console.warn(`[crawl] ajax failed: ${err.message}`)
      return []
    }
  }

  // Fetch both simultaneously — HTML for freshness, AJAX for speed/redundancy.
  const [htmlRecs, ajaxRecs] = await Promise.all([fetchHtml(), fetchAjax()])

  const seenIds = new Set(htmlRecs.map(r => r.id))
  const extra = ajaxRecs.filter(r => !seenIds.has(r.id))
  const merged = [...htmlRecs, ...extra]

  const maxKyOf = rs => rs.length ? Math.max(...rs.map(r => Number(r.ky))) : 0
  const htmlMax = maxKyOf(htmlRecs)
  const ajaxMax = maxKyOf(ajaxRecs)
  const mergedMax = maxKyOf(merged)

  if (merged.length === 0) {
    console.log('[crawl] both sources empty')
    return []
  }

  const fresher = htmlMax >= ajaxMax ? 'html' : 'ajax'
  console.log(`[crawl] html:${htmlRecs.length}(ky≤${htmlMax}) ajax:${ajaxRecs.length}(ky≤${ajaxMax}) merged:${merged.length}(ky≤${mergedMax}) fresher:${fresher}`)
  return merged
}

/** Fetch one paginated page of history (pageIndex = 1, 2, 3…). Used by crawlAll().
 * Only works for primary source (xoso.net.vn); xomo doesn't support pagination.
 */
async function crawlPage(pageIndex) {
  const res = await axios.get(AJAX_URL, {
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
      await new Promise(r => setTimeout(r, 400))
    } catch (err) {
      console.error(`\n[crawlAll] page ${page} error: ${err.message}`)
    }
  }
  const final = await fs.readJSON(FILE).catch(() => [])
  console.log(`\n[crawlAll] Done. Added ${totalAdded} | total on disk: ${final.length}`)
}

/**
 * Crawl pages covering draws >= fromKy, then sweep toward page 1 (newest).
 * Much faster than crawlAll() for filling recent gaps after outages.
 *
 * Page model: page 1 = newest ky. Higher page number = older ky.
 * Sweep direction: start at estimated "fromKy page", walk toward page 1.
 *
 * @param {number} fromKy  – include all draws with ky >= fromKy
 * @param {number} maxPages – hard cap on total pages crawled (default 200)
 * @returns {{ totalAdded, total }}
 */
async function crawlSince(fromKy, maxPages = 200) {
  console.log(`[crawlSince] looking for draws >= ky ${fromKy}, max ${maxPages} pages...`)

  // Approximate live ky by fetching page 1 to calibrate the linear model.
  // Page model: page ≈ (liveKy - targetKy) / kyPerPage
  // Each AJAX page returns 15 consecutive ky draws.
  const KY_PER_PAGE = 15

  let liveKy = fromKy + 60  // fallback estimate if page-1 fetch fails
  try {
    const livePage = await crawlPage(1)
    if (livePage.length > 0) liveKy = Math.max(...livePage.map(r => Number(r.ky)))
  } catch (_) {}

  // Estimate the page that contains fromKy (add 10-page buffer to catch nearby gaps).
  const estimatedStartPage = Math.max(1, Math.ceil((liveKy - fromKy) / KY_PER_PAGE) + 10)

  // Refine: sample one page near the estimate and adjust.
  let startPage = estimatedStartPage
  try {
    const sample = await crawlPage(estimatedStartPage)
    if (sample.length > 0) {
      const pageMinKy = Math.min(...sample.map(r => Number(r.ky)))
      if (pageMinKy > fromKy + 60) {
        // Landed too recent (newer than fromKy) — go to a higher page (deeper/older).
        startPage = estimatedStartPage + Math.ceil((pageMinKy - fromKy) / KY_PER_PAGE)
      } else if (pageMinKy < fromKy - 100) {
        // Landed too old — back up toward page 1.
        startPage = Math.max(1, estimatedStartPage - Math.ceil((fromKy - pageMinKy) / KY_PER_PAGE))
      }
    }
  } catch (_) {}

  console.log(`[crawlSince] liveKy=${liveKy} fromKy=${fromKy} startPage=${startPage}`)

  // Sweep from startPage → page 1 (oldest → newest), fetching everything >= fromKy.
  let totalAdded = 0
  let consecutiveEmpty = 0

  for (let i = 0; i < maxPages; i++) {
    const page = startPage - i  // sweep toward page 1 (newest)
    if (page < 1) break

    try {
      const records = await crawlPage(page)
      if (records.length === 0) {
        if (++consecutiveEmpty >= 3) break
        continue
      }
      consecutiveEmpty = 0

      // Once we're fetching pages where all records are already well past fromKy
      // and we're at page 1 or 2, we're done.
      const maxKyOnPage = Math.max(...records.map(r => Number(r.ky)))
      const minKyOnPage = Math.min(...records.map(r => Number(r.ky)))

      // If this page is entirely older than fromKy - 60 buffer, skip but continue
      // (we may have overshot; next pages toward 1 will be newer).
      if (maxKyOnPage < fromKy - 60) {
        continue
      }

      const result = await merge(records)
      totalAdded += result.added
      if (result.added > 0) {
        process.stdout.write(`  page ${String(page).padStart(4)}: +${result.added} new (ky ${minKyOnPage}-${maxKyOnPage}) | total: ${result.total}\r`)
      }
      await new Promise(r => setTimeout(r, 350))
    } catch (err) {
      console.error(`\n[crawlSince] page ${page} error: ${err.message}`)
    }
  }

  const final = await fs.readJSON(FILE).catch(() => [])
  console.log(`\n[crawlSince] Done. Added ${totalAdded} | total on disk: ${final.length}`)
  return { totalAdded, total: final.length }
}

module.exports = { crawl, crawlPage, crawlAll, crawlSince, run, merge }

if (require.main === module) {
  const all = process.argv.includes('--all')
  const since = process.argv.find(a => a.startsWith('--since='))?.split('=')[1]
  const pages = parseInt(process.argv.find(a => a.startsWith('--pages='))?.split('=')[1]) || 60
  if (since) {
    crawlSince(Number(since), pages || 200).catch(err => { console.error(err.message); process.exit(1) })
  } else if (all) {
    crawlAll(pages).catch(err => { console.error(err.message); process.exit(1) })
  } else {
    run().catch(err => { console.error('[crawl] ERROR:', err.message); process.exit(1) })
  }
}

