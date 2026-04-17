'use strict'
/**
 * crawler/crawl.js
 * Fetches Bingo18 results from TWO independent sources simultaneously.
 *
 * Strategy ("crawl 2 web cùng lúc — web nào tới trước thì ghi vào history"):
 *   Source A: vietlott.vn (official)   — PRIORITY. Published instantly after each draw.
 *             HTML table, ~6 most-recent draws per page load. Always authoritative.
 *   Source B: xoso.net.vn HTML page   — backup. Shows ~15 draws, published quickly.
 *
 *   Both fire in parallel via a write-queue so each source merges to disk as soon as it
 *   resolves — no waiting for the other. The slower source fills any gaps left by the faster.
 *   AJAX endpoint kept only for crawlAll() / crawlSince() historical bulk pagination.
 *
 * CLI Modes:
 *   node crawler/crawl.js               – one-shot dual-source run
 *   node crawler/crawl.js --all         – paginate backward through full history (seed)
 *   node crawler/crawl.js --since=<ky>  – fill gaps from last known ky forward
 *   node crawler/crawl.js --pages=N     – override page limit for --all / --since
 */
const axios = require('axios')
const cheerio = require('cheerio')
const fs = require('fs-extra')
const path = require('path')
const crypto = require('crypto')

const FILE = path.join(__dirname, '../dataset/history.json')
const BACKUP_FILE = `${FILE}.bak`

// ── Source URLs ────────────────────────────────────────────────────────────
// Source A (PRIORITY): official Vietlott results — published immediately after each draw.
//   HTML table with up to 6 most-recent draws. No drawTime (date only), but authoritative.
const VIETLOTT_URL = 'https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/winning-number-bingo18'
// Vietlott AjaxPro — same official source, used for multi-page historical recovery.
// PageIndex 0 = newest 6 draws, each subsequent page goes 6 draws further back.
const VIETLOTT_AJAXPRO_RENDER_URL = 'https://vietlott.vn/ajaxpro/Vietlott.Utility.WebEnvironments,Vietlott.Utility.ashx'
const VIETLOTT_AJAXPRO_DRAW_URL = 'https://vietlott.vn/ajaxpro/Vietlott.PlugIn.WebParts.GameBingoCompareWebPart,Vietlott.PlugIn.WebParts.ashx'
// Source B: xoso.net.vn HTML page — backup, ~15 draws, includes HH:MM drawTime.
const HTML_URL = 'https://xoso.net.vn/xs-bingo-18.html'
// xoso AJAX — fallback for crawlPage() when Vietlott AjaxPro is blocked (e.g. 403 from overseas IPs).
const XOSO_AJAX_URL = 'https://xoso.net.vn/XSDienToan/GetKetQuaBinGo18More'

// ── Write serialization queue ──────────────────────────────────────────────
// Prevents concurrent merge() calls from racing on the same file.
// Both sources fire simultaneously; the queue ensures one write completes before
// the next begins, so no data is lost when both resolve within ms of each other.
let _writeQueue = Promise.resolve()

function queuedMerge(records) {
  if (!records || records.length === 0) {
    return Promise.resolve({ total: 0, added: 0, newRecords: [], patched: 0, changed: false })
  }
  const p = _writeQueue.then(() => merge(records))
  // Keep chain alive even on error — prevents queue stall
  _writeQueue = p.catch(err => {
    console.error('[crawl] merge queue error:', err.message)
    return { total: 0, added: 0, newRecords: [], patched: 0, changed: false }
  })
  return p
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Referer': 'https://www.google.com.vn/',
}

// ── Vietlott AjaxPro helpers ───────────────────────────────────────────────
// Cache RenderInfo — it is site-scoped (no session), so one fetch per process lifetime is fine.
let _vietlottRenderInfo = null

async function getVietlottRenderInfo() {
  if (_vietlottRenderInfo) return _vietlottRenderInfo
  const r = await axios.post(
    VIETLOTT_AJAXPRO_RENDER_URL,
    '{"SiteId":"main.frontend.vi"}',
    {
      headers: {
        ...HEADERS,
        'X-AjaxPro-Method': 'ServerSideFrontEndCreateRenderInfo',
        'Content-Type': 'text/plain; charset=utf-8',
        'Referer': VIETLOTT_URL,
      },
      timeout: 10_000,
      responseType: 'json',
    },
  )
  _vietlottRenderInfo = r.data?.value || null
  return _vietlottRenderInfo
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

/** Parse draw records from the Vietlott results table.
 *  Rows: <td>dd/MM/yyyy #0162535</td> <td><span class="bong_tron_bingo small">N</span>…</td> <td>sum</td>
 */
function parseVietlott($) {
  const results = []
  $('table.table-hover tbody tr').each((_, row) => {
    const tds = $(row).find('td')
    if (tds.length < 3) return  // skip header / empty rows

    // Ky: "#0162535" → strip leading zeros → "162535"
    const kyMatch = $(tds[0]).text().match(/#(\d+)/)
    if (!kyMatch) return
    const ky = String(parseInt(kyMatch[1], 10))

    // Date: "17/04/2026" → ISO (no time from vietlott, use midnight VN)
    const dateText = $(tds[0]).find('a').first().text().trim()
    const dm = dateText.match(/(\d{2})\/(\d{2})\/(\d{4})/)
    const drawTime = dm ? `${dm[3]}-${dm[2]}-${dm[1]}T00:00:00+07:00` : null

    // Balls from <span class="bong_tron_bingo small">
    const balls = []
    $(tds[1]).find('.bong_tron_bingo').each((_, el) => {
      const v = parseInt($(el).text().trim(), 10)
      if (v >= 1 && v <= 6) balls.push(v)
    })
    if (balls.length < 3) return
    const [n1, n2, n3] = balls
    results.push({ id: makeId(ky, n1, n2, n3), ky, drawTime, n1, n2, n3, sum: n1 + n2 + n3, pattern: classify(n1, n2, n3) })
  })
  return results
}

/** Source A (priority): vietlott.vn official — fastest publication, authoritative.
 *  Returns [] silently on 403 (Vietlott blocks overseas IPs; xoso.net.vn covers this case).
 */
async function fetchVietlott() {
  try {
    const r = await axios.get(`${VIETLOTT_URL}?nocache=${Date.now()}`, { timeout: 12_000, headers: HEADERS })
    return parseVietlott(cheerio.load(r.data))
  } catch (err) {
    // 403 = Vietlott blocks this IP (common on overseas hosting). Silent — xoso covers it.
    if (err.response?.status !== 403) {
      console.warn(`[crawl] A(vietlott) failed: ${err.message}`)
    }
    return []
  }
}

/** Source B: xoso.net.vn HTML — backup, includes HH:MM drawTime for history quality. */
async function fetchHtml() {
  try {
    const r = await axios.get(`${HTML_URL}?_t=${Date.now()}`, { timeout: 12_000, headers: HEADERS })
    return parseBlocks(cheerio.load(r.data))
  } catch (err) {
    console.warn(`[crawl] B(html) failed: ${err.message}`)
    return []
  }
}

/** Fetch one paginated page of history for bulk / gap-recovery.
 *  Tries Vietlott AjaxPro first (6 draws/page, official source, no rate-limit).
 *  Falls back to xoso.net.vn AJAX (15 draws/page) if Vietlott is blocked (403).
 *  This ensures gap recovery works from overseas hosting (e.g. Fly.io Singapore).
 */
async function crawlPage(pageIndex) {
  // ── Try Vietlott AjaxPro (primary) ───────────────────────────────────────
  try {
    const renderInfo = await getVietlottRenderInfo()
    if (renderInfo) {
      const body = JSON.stringify({
        ORenderInfo: renderInfo,
        GameId: '8',
        GameDrawNo: '',
        number: '',
        DrawDate: '',
        PageIndex: pageIndex - 1,  // crawlPage is 1-based; AjaxPro uses 0-based
        TotalRow: 0,
      })
      const res = await axios.post(VIETLOTT_AJAXPRO_DRAW_URL, body, {
        headers: {
          ...HEADERS,
          'X-AjaxPro-Method': 'ServerSideDrawResult',
          'Content-Type': 'text/plain; charset=utf-8',
          'Origin': 'https://vietlott.vn',
          'Referer': VIETLOTT_URL,
        },
        timeout: 14_000,
        responseType: 'json',
      })
      const html = res.data?.value?.HtmlContent || ''
      if (html && html.trim().length > 50) return parseVietlott(cheerio.load(html))
    }
  } catch (err) {
    if (err.response?.status !== 403) {
      console.warn(`[crawl] crawlPage AjaxPro p${pageIndex} failed: ${err.message} — trying xoso fallback`)
    }
    // 403 = blocked by IP → fall through to xoso silently
    // Reset cached RenderInfo so next crawlPage re-attempts (in case IP changes)
    _vietlottRenderInfo = null
  }

  // ── Fallback: xoso.net.vn AJAX (15 draws/page) ──────────────────────────
  const res = await axios.get(XOSO_AJAX_URL, {
    params: { pageIndex },
    timeout: 14_000,
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

/**
 * Dual-source parallel crawl — main entry point called by the server loop every 60s.
 *
 * Both sources (HTML + AJAX) fire simultaneously. As each resolves, its records are
 * immediately merged via queuedMerge (serialized). This gives "web nào tới trước thì
 * ghi" semantics: whichever source arrives first writes first, the other fills gaps.
 *
 * @returns {{ total, added, newRecords, changed }}
 */
async function run() {
  const t0 = Date.now()
  let htmlResult = null
  let ajaxResult = null

  // Source A (priority): vietlott.vn — official source, fire first.
  const pA = fetchVietlott().then(async (recs) => {
    if (recs.length === 0) return
    htmlResult = await queuedMerge(recs)
    const maxKy = Math.max(...recs.map(r => Number(r.ky)))
    console.log(`[crawl] A(vietlott): ${recs.length} recs (ky≤${maxKy}) +${htmlResult.added} new`)
  }).catch(err => console.warn('[crawl] source A error:', err.message))

  // Source B: xoso.net.vn HTML — includes drawTime (HH:MM) to enrich existing records.
  const pB = fetchHtml().then(async (recs) => {
    if (recs.length === 0) return
    ajaxResult = await queuedMerge(recs)
    const maxKy = Math.max(...recs.map(r => Number(r.ky)))
    console.log(`[crawl] B(html): ${recs.length} recs (ky≤${maxKy}) +${ajaxResult.added} new`)
  }).catch(err => console.warn('[crawl] source B error:', err.message))

  // Wait for both to complete (each has already written independently).
  await Promise.allSettled([pA, pB])

  const elapsed = Date.now() - t0

  if (!htmlResult && !ajaxResult) {
    const current = await loadHistorySafe()
    console.log(`[crawl] both sources empty (${elapsed}ms)`)
    return { total: current.length, added: 0, newRecords: [], changed: false }
  }

  const totalAdded = (htmlResult?.added || 0) + (ajaxResult?.added || 0)
  const allNew = [
    ...(htmlResult?.newRecords || []),
    ...(ajaxResult?.newRecords || []),
  ].sort((a, b) => Number(b.ky) - Number(a.ky))

  const after = await loadHistorySafe()
  if (totalAdded > 0) {
    console.log(`[crawl] done ${elapsed}ms — total: ${after.length} (+${totalAdded} new, latest: ${allNew[0]?.ky})`)
  }

  return {
    total: after.length,
    added: totalAdded,
    newRecords: allNew,
    changed: totalAdded > 0 || (htmlResult?.patched || 0) > 0 || (ajaxResult?.patched || 0) > 0,
  }
}

/** Crawl full history via Vietlott AjaxPro pagination (run once to seed, or after long outage).
 * @param {number} maxPages – pages to fetch (default 200 ≈ 1200 draws ≈ 100 hours)
 */
async function crawlAll(maxPages = 200) {
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
      process.stdout.write(`  page ${String(page).padStart(3)}: +${result.added} new | total: ${result.total}\r`)
      await new Promise(r => setTimeout(r, 400))
    } catch (err) {
      console.error(`\n[crawlAll] page ${page} error: ${err.message}`)
    }
  }
  const final = await loadHistorySafe()
  console.log(`\n[crawlAll] Done. Added ${totalAdded} | total: ${final.length}`)
}

/**
 * Crawl pages covering draws >= fromKy, then sweep toward page 1 (newest).
 * Much faster than crawlAll() for filling recent gaps after outages.
 *
 * Page model: page 1 = newest ky. Higher page = older ky.
 * Estimates startPage from (liveKy - fromKy) / KY_PER_PAGE, then sweeps toward page 1.
 *
 * @param {number} fromKy   – include draws with ky >= fromKy
 * @param {number} maxPages – hard cap (default 50 ≈ 300 draws; use --pages=N for more)
 * @returns {{ totalAdded, total }}
 */
async function crawlSince(fromKy, maxPages = 50) {
  console.log(`[crawlSince] looking for draws >= ky ${fromKy}, max ${maxPages} pages...`)

  // KY_PER_PAGE: use 6 (Vietlott AjaxPro, primary) so estimates are conservative —
  // going slightly past the target is harmless; stopping short would miss draws.
  // xoso fallback returns 15/page so it finds the target in fewer pages, also fine.
  const KY_PER_PAGE = 6

  let liveKy = fromKy + 200  // fallback estimate
  try {
    const livePage = await crawlPage(1)
    if (livePage.length > 0) liveKy = Math.max(...livePage.map(r => Number(r.ky)))
  } catch (_) { }

  const estimatedStartPage = Math.max(1, Math.ceil((liveKy - fromKy) / KY_PER_PAGE) + 5)

  // Minimum pages needed to reach fromKy from liveKy (floor to never under-shoot).
  const minStartPage = Math.max(1, Math.ceil((liveKy - fromKy) / KY_PER_PAGE))

  let startPage = estimatedStartPage
  try {
    const sample = await crawlPage(estimatedStartPage)
    if (sample.length > 0) {
      const pageMinKy = Math.min(...sample.map(r => Number(r.ky)))
      if (pageMinKy > fromKy + 30) {
        startPage = estimatedStartPage + Math.ceil((pageMinKy - fromKy) / KY_PER_PAGE)
      } else if (pageMinKy < fromKy - 60) {
        startPage = Math.max(1, estimatedStartPage - Math.ceil((fromKy - pageMinKy) / KY_PER_PAGE))
      }
    }
  } catch (_) { }

  // Never let refinement reduce startPage below the minimum needed to reach fromKy.
  if (startPage < minStartPage) startPage = minStartPage + 2

  console.log(`[crawlSince] liveKy=${liveKy} fromKy=${fromKy} startPage=${startPage} (min=${minStartPage})`)

  let totalAdded = 0
  let consecutiveEmpty = 0

  for (let i = 0; i <= maxPages; i++) {
    const page = startPage - i
    if (page < 1) break

    try {
      const records = await crawlPage(page)
      if (records.length === 0) {
        if (++consecutiveEmpty >= 3) break
        continue
      }
      consecutiveEmpty = 0

      const maxKyOnPage = Math.max(...records.map(r => Number(r.ky)))
      if (maxKyOnPage < fromKy - 30) continue  // entirely too old, skip

      const result = await merge(records)
      totalAdded += result.added
      const minKyOnPage = Math.min(...records.map(r => Number(r.ky)))
      if (result.added > 0) {
        process.stdout.write(`  page ${String(page).padStart(4)}: +${result.added} new (ky ${minKyOnPage}–${maxKyOnPage}) | total: ${result.total}\r`)
      }
      await new Promise(r => setTimeout(r, 400))
    } catch (err) {
      console.error(`\n[crawlSince] page ${page} error: ${err.message}`)
    }
  }

  const final = await loadHistorySafe()
  console.log(`\n[crawlSince] Done. Added ${totalAdded} | total: ${final.length}`)
  return { totalAdded, total: final.length }
}

module.exports = { crawl: run, crawlPage, crawlAll, crawlSince, run, merge }

if (require.main === module) {
  const all = process.argv.includes('--all')
  const since = process.argv.find(a => a.startsWith('--since='))?.split('=')[1]
  const pages = parseInt(process.argv.find(a => a.startsWith('--pages='))?.split('=')[1]) || 100
  if (since) {
    crawlSince(Number(since), pages).catch(err => { console.error(err.message); process.exit(1) })
  } else if (all) {
    crawlAll(pages).catch(err => { console.error(err.message); process.exit(1) })
  } else {
    run().catch(err => { console.error('[crawl] ERROR:', err.message); process.exit(1) })
  }
}

