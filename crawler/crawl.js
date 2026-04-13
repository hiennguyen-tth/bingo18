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
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://www.google.com.vn/',
}

// Second source — xsmn.net (sometimes publishes results sooner; date only, no draw time)
const XSMN_URL = 'https://xsmn.net/xsbingo18-xo-so-bingo18'
const XSMN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
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

/** Fetch and parse xsmn.net (second source, faster publishing, date only — no draw time). */
async function crawlXsmn() {
  const res = await axios.get(XSMN_URL, { timeout: 15_000, headers: XSMN_HEADERS })
  const $ = cheerio.load(res.data)
  const results = []

  $('article.xsbingo18').each((_, article) => {
    // Ky: href="/kqxsbingo18/ky-quay-0161654" → strip leading zeros
    const kyHref = $(article).find('a[href*="ky-quay-"]').first().attr('href') || ''
    const kyMatch = kyHref.match(/ky-quay-0*?(\d+)$/)
    if (!kyMatch) return
    const ky = String(parseInt(kyMatch[1], 10))  // strip leading zeros to match xoso format

    // Date: "11/04/2026" — no time on this source
    const dateText = $(article).find('.ngay').text().trim()
    const dateMatch = dateText.match(/(\d{2})\/(\d{2})\/(\d{4})/)
    // drawTime will be null; server.js merge will back-fill from xoso.net.vn
    const drawDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null

    // Balls: <span class="kq lq_1"> 6 </span> (absent if draw hasn't happened yet)
    const balls = []
    $(article).find('span[class*="lq_"]').each((_, el) => {
      const cls = $(el).attr('class') || ''
      if (!cls.includes('kq')) return  // skip non-result spans
      const v = parseInt($(el).text().trim(), 10)
      if (v >= 1 && v <= 6) balls.push(v)
    })
    if (balls.length < 3) return  // incomplete/upcoming draw — skip

    const [n1, n2, n3] = balls
    results.push({
      id: makeId(ky, n1, n2, n3),
      ky,
      drawTime: null,          // xsmn.net doesn't publish draw time
      drawDate,                // "2026-04-11" — used for display if drawTime stays null
      n1, n2, n3,
      sum: n1 + n2 + n3,
      pattern: classify(n1, n2, n3),
    })
  })
  return results
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

// ── Staleness tracking ───────────────────────────────────────────────────
// When the primary source (xoso main page) returns the same latest ky as the
// previous run it is likely still caching an old page. We then also hit the
// paginated API endpoint (different backend path on the same host) which tends
// to publish results sooner, avoiding missed draws while sources lag.
let _prevPrimaryKy = null
let _staleRuns = 0

/** Crawl latest draws from multiple sources with staleness-aware fallback. */
async function run() {
  // Fire primary and secondary simultaneously; tolerate individual failures
  const [r1, r2] = await Promise.allSettled([
    crawl(),      // xoso.net.vn main page — has exact draw times
    crawlXsmn(),  // xsmn.net — sometimes publishes faster
  ])

  const from1 = r1.status === 'fulfilled' ? r1.value : (console.error('[crawl] xoso.main error:', r1.reason?.message), [])
  const from2 = r2.status === 'fulfilled' ? r2.value : (console.error('[crawl] xsmn error:', r2.reason?.message), [])

  // Staleness check: if the primary source's latest ky hasn't changed since the
  // last successful run, also query the paginated API endpoint as a 3rd data point.
  let fromPage = []
  const primaryLatest = from1[0]?.ky ?? null
  if (from1.length > 0) {
    if (primaryLatest === _prevPrimaryKy) {
      _staleRuns++
      console.log(`[crawl] primary stuck at ky #${primaryLatest} — trying paginated fallback (stale ×${_staleRuns})`)
      try {
        fromPage = await crawlPage(1)
      } catch (e) {
        console.error('[crawl] paginated fallback error:', e.message)
      }
    } else {
      _staleRuns = 0
      _prevPrimaryKy = primaryLatest
    }
  }

  // Merge all sources — xoso (drawTime) takes priority over xsmn (date-only)
  const combined = [...from1, ...fromPage, ...from2]
  const result = await merge(combined)
  const srcs = [from1.length && 'xoso', fromPage.length && 'page1', from2.length && 'xsmn'].filter(Boolean).join('+')
  const staleTag = _staleRuns > 0 ? ` [stale×${_staleRuns}]` : ''
  console.log(`[crawl] (${srcs || 'none'}) total: ${result.total} (+${result.added} new)${staleTag}`)
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

module.exports = { crawl, crawlXsmn, crawlPage, crawlAll, run, merge }

if (require.main === module) {
  const all = process.argv.includes('--all')
  const pages = parseInt(process.argv.find(a => a.startsWith('--pages='))?.split('=')[1]) || 60
  if (all) {
    crawlAll(pages).catch(err => { console.error(err.message); process.exit(1) })
  } else {
    run().catch(err => { console.error('[crawl] ERROR:', err.message); process.exit(1) })
  }
}

