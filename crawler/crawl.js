'use strict'
/**
 * crawler/crawl.js
 * Fetches Bingo18 results from THREE independent sources simultaneously.
 *
 * Strategy:
 *   Source A: vietlott.vn (official)      — PRIORITY. Published instantly after each draw.
 *             HTML table, ~6 most-recent draws per page. Authoritative ky numbers.
 *   Source B: xoso.net.vn HTML page       — backup, ~15 draws, includes HH:MM drawTime.
 *   Source C: bingo18.top/data/data.json  — 45-day JSON feed with full timestamps.
 *             Patches missing drawTime on existing records; fills coverage gaps.
 *
 *   All three fire in parallel via a write-queue so each source merges to disk as soon as
 *   it resolves. No waiting for others — whichever arrives first writes first.
 *
 * CLI Modes:
 *   node crawler/crawl.js               – one-shot triple-source run
 *   node crawler/crawl.js --all         – paginate backward through full history (seed)
 *   node crawler/crawl.js --since=<ky>  – fill gaps from last known ky forward
 *   node crawler/crawl.js --pages=N     – override page limit for --all / --since
 *   node crawler/crawl.js --seed-c      – one-shot import of all bingo18.top history
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
// Source C: bingo18.top JSON feed — 45-day rolling window, full HH:MM timestamps, no ky.
const BINGO18TOP_URL = 'https://bingo18.top/data/data.json'

// ── Write serialization queue ──────────────────────────────────────────────
// Prevents concurrent merge() calls from racing on the same file.
// Both sources fire simultaneously; the queue ensures one write completes before
// the next begins, so no data is lost when both resolve within ms of each other.
let _writeQueue = Promise.resolve()

// ── In-process history cache — avoids re-reading 8 MB on every merge call ──
// Invalidated automatically when merge() writes a new file (mtime updates).
let _crawlHistoryCache = null
let _crawlHistoryCacheMtime = 0

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

/** Derive a stable id from ISO drawTime + balls — used for Source C records (no ky). */
function makeTimeId(drawTime, n1, n2, n3) {
  return crypto.createHash('sha1').update(`dt-${drawTime}-${n1}-${n2}-${n3}`).digest('hex').slice(0, 16)
}

/** Truncate ISO timestamp to "YYYY-MM-DDTHH:MM" for time-slot matching. */
function slotKey(drawTime) {
  if (!drawTime) return null
  return drawTime.slice(0, 16)  // "2026-04-17T06:05"
}

/**
 * Snap a drawTime to the nearest canonical 6-minute slot.
 * Bingo18 schedule: every 6 minutes from 06:00 to 21:54 VN time (160 slots/day).
 * @returns {{ slot: "HH:MM", date: "YYYY-MM-DD" } | null}
 */
function canonicalSlotInfo(drawTime) {
  if (!drawTime) return null
  const d = new Date(drawTime)
  if (isNaN(d.getTime())) return null
  const vnMs = d.getTime() + 7 * 3600_000
  const vn = new Date(vnMs)
  const totalMin = vn.getUTCHours() * 60 + vn.getUTCMinutes()
  const slotIndex = Math.round((totalMin - 360) / 6)
  if (slotIndex < 0 || slotIndex > 159) return null
  const canonMin = 360 + slotIndex * 6
  const h = Math.floor(canonMin / 60)
  const m = canonMin % 60
  const slot = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
  const date = vn.getUTCFullYear() + '-' +
    String(vn.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(vn.getUTCDate()).padStart(2, '0')
  return { slot, date }
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

  // Mtime-based cache: avoids re-reading 8 MB JSON on every merge() call within the same tick.
  // merge() updates _crawlHistoryCache after each write so the next source sees fresh data.
  try {
    const stat = await fs.stat(FILE)
    if (_crawlHistoryCache && stat.mtimeMs === _crawlHistoryCacheMtime) return _crawlHistoryCache
  } catch (_) { /* stat failed — fall through to read */ }

  const parsed = await fs.readJSON(FILE).catch(() => null)
  if (Array.isArray(parsed)) {
    _crawlHistoryCache = parsed
    try { _crawlHistoryCacheMtime = (await fs.stat(FILE)).mtimeMs } catch (_) { }
    return parsed
  }

  // If the primary file is corrupted, attempt recovery from backup.
  const backup = await fs.readJSON(BACKUP_FILE).catch(() => null)
  if (Array.isArray(backup) && backup.length > 0) {
    console.error(`[crawl] WARNING: history.json corrupted, recovering from backup (${backup.length} records)`)
    await atomicWriteJSON(FILE, backup)
    _crawlHistoryCache = backup
    try { _crawlHistoryCacheMtime = (await fs.stat(FILE)).mtimeMs } catch (_) { }
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

/**
 * Parse Source C: bingo18.top/data/data.json
 * Format: { gbingoDraws: [ { drawAt: "2026-04-17T06:05:00+07:00", winningResult: "236" }, ... ] }
 * Records have full timestamps but no ky. Marked with _srcC=true for merge logic.
 */
function parseBingo18Top(raw) {
  const draws = raw?.gbingoDraws
  if (!Array.isArray(draws)) return []
  const results = []
  for (const item of draws) {
    const drawAt = item.drawAt
    const wr = item.winningResult
    if (!drawAt || typeof wr !== 'string' || wr.length !== 3) continue
    const n1 = parseInt(wr[0], 10)
    const n2 = parseInt(wr[1], 10)
    const n3 = parseInt(wr[2], 10)
    if (!Number.isInteger(n1) || !Number.isInteger(n2) || !Number.isInteger(n3)) continue
    if (n1 < 1 || n1 > 6 || n2 < 1 || n2 > 6 || n3 < 1 || n3 > 6) continue
    results.push({
      id: makeTimeId(drawAt, n1, n2, n3),
      drawTime: drawAt,
      n1, n2, n3,
      sum: n1 + n2 + n3,
      pattern: classify(n1, n2, n3),
      _srcC: true,  // flag: no ky — merge uses drawTime matching
    })
  }
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

/**
 * Source C: bingo18.top/data/data.json — 45-day rolling JSON feed with full timestamps.
 * Free of bot-protection, updated every ~1 minute. Provides HH:MM accuracy for all draws.
 */
async function fetchBingo18Top() {
  try {
    const https = require('https')
    const agent = new https.Agent({ rejectUnauthorized: false })
    const r = await axios.get(BINGO18TOP_URL, {
      timeout: 15_000,
      headers: { ...HEADERS, Accept: 'application/json', Referer: 'https://bingo18.top/', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
      responseType: 'json',
      httpsAgent: agent,
    })
    return parseBingo18Top(r.data)
  } catch (err) {
    console.warn(`[crawl] C(bingo18top) failed: ${err.message}`)
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
 * Handles three record types:
 *   - Source A/B: have ky + possibly drawTime
 *   - Source C (bingo18.top): have drawTime + balls but NO ky (_srcC=true)
 *     → matched to existing records by time-slot + balls to patch missing drawTimes
 *     → unmatched records added as new entries (no ky, until Vietlott confirms)
 * @returns {{ total, added, newRecords, patched, changed }}
 */
async function merge(incoming) {
  const old = await loadHistorySafe()
  // Index by id and ky for fast lookup
  const byId = new Map(old.map(o => [o.id, o]))
  const byKy = new Map(old.map(o => [o.ky, o]))
  // Index by canonical 6-min slot+day for Source C matching
  // Key: "YYYY-MM-DD|HH:MM" (canonical slot)
  // Prefer the NEWEST (first in sorted array) record per slot — don't overwrite.
  const byCanonDay = new Map()
  for (const o of old) {
    const ci = canonicalSlotInfo(o.drawTime)
    if (ci) {
      const key = `${ci.date}|${ci.slot}`
      if (!byCanonDay.has(key)) byCanonDay.set(key, o)
    }
  }

  const newRecords = []
  let patched = 0

  for (const r of incoming) {
    if (r._srcC) {
      // ── Source C: match by canonical 6-min slot + day ──────────────────
      const ci = canonicalSlotInfo(r.drawTime)
      const canonKey = ci ? `${ci.date}|${ci.slot}` : null
      const canonMatch = canonKey ? byCanonDay.get(canonKey) : null

      if (canonMatch) {
        // Verify balls match — if balls differ, this is a NEW draw that happens to land in
        // the same canonical 6-min slot as an existing draw (e.g. ky drawn 3 min early rounds
        // UP to the next slot, then the next draw's actual time also hits that same slot).
        const ballsMatch = canonMatch.n1 === r.n1 && canonMatch.n2 === r.n2 && canonMatch.n3 === r.n3
        if (ballsMatch) {
          // Same draw at same canonical slot → patch drawTime if currently date-only
          const needsPatch = !canonMatch.drawTime || canonMatch.drawTime.endsWith('T00:00:00+07:00')
          if (needsPatch) {
            canonMatch.drawTime = r.drawTime
            patched++
          }
          continue
        }
        // Different balls at same canonical slot → this is a genuinely new draw; fall through
        // to add as a new record (do NOT skip it just because the slot is "occupied").
      }

      // Not matched by canonical slot. Try matching by id (re-imported Source C record).
      if (byId.has(r.id)) continue

      // Fallback: match by n1+n2+n3 against existing KY records.
      // Only use 10-minute real-time window — never match against date-only (T00:00:00) ky records
      // because those can collide with a genuinely different draw that has the same balls.
      const rTime = new Date(r.drawTime).getTime()
      if (!isNaN(rTime)) {
        const ballMatch = old.find(x => x.ky && x.n1 === r.n1 && x.n2 === r.n2 && x.n3 === r.n3
          && x.drawTime && !x.drawTime.endsWith('T00:00:00+07:00')
          && Math.abs(new Date(x.drawTime).getTime() - rTime) < 10 * 60 * 1000)
        if (ballMatch) continue
      }

      // Truly new record from Source C — insert without ky
      const rec = { id: r.id, drawTime: r.drawTime, n1: r.n1, n2: r.n2, n3: r.n3, sum: r.sum, pattern: r.pattern }
      old.push(rec)
      byId.set(rec.id, rec)
      if (canonKey) byCanonDay.set(canonKey, rec)
      newRecords.push(rec)
      continue
    }

    // ── Source A/B: normal ky-based merge ────────────────────────────────
    const existing = byId.get(r.id) || (r.ky ? byKy.get(r.ky) : null)
    if (!existing) {
      // Try to promote an existing Source C no-ky record with same balls within 10 min.
      // This handles the race where Source C inserts a record before Source A confirms it with ky.
      if (r.ky) {
        const rTime = new Date(r.drawTime).getTime()
        const rIsDateOnly = r.drawTime && r.drawTime.endsWith('T00:00:00+07:00')
        const rDate = r.drawTime ? r.drawTime.slice(0, 10) : null
        if (rDate) {
          let noKyMatch = null
          if (rIsDateOnly) {
            // Source A gives date-only T00:00:00 — we don't know the exact time.
            // Use findLast (oldest no-ky with matching balls on same day) to avoid
            // accidentally promoting the NEWEST draw when multiple same-ball draws exist.
            // Array is sorted newest-first, so findLast = chronologically oldest match.
            noKyMatch = old.findLast(x => !x.ky && x.n1 === r.n1 && x.n2 === r.n2 && x.n3 === r.n3
              && x.drawTime && x.drawTime.startsWith(rDate))
          } else {
            // Source B has real HH:MM time — safe 10-min window
            noKyMatch = old.find(x => !x.ky && x.n1 === r.n1 && x.n2 === r.n2 && x.n3 === r.n3
              && x.drawTime && Math.abs(new Date(x.drawTime).getTime() - rTime) < 10 * 60 * 1000)
          }
          if (noKyMatch) {
            // Promote: gắn ky chính thức vào record Source C, dùng drawTime chính xác hơn
            noKyMatch.ky = r.ky
            byKy.set(r.ky, noKyMatch)
            if (r.drawTime && !r.drawTime.endsWith('T00:00:00+07:00')) {
              noKyMatch.drawTime = r.drawTime
            }
            patched++
            continue
          }
        }
      }
      old.push(r)
      byId.set(r.id, r)
      if (r.ky) byKy.set(r.ky, r)
      const ci = canonicalSlotInfo(r.drawTime)
      if (ci) byCanonDay.set(`${ci.date}|${ci.slot}`, r)
      newRecords.push(r)
    } else {
      // Patch drawTime if this source has a better one (HH:MM vs date-only)
      const hasTime = r.drawTime && !r.drawTime.endsWith('T00:00:00+07:00')
      const existingHasTime = existing.drawTime && !existing.drawTime.endsWith('T00:00:00+07:00')
      if (hasTime && !existingHasTime) {
        existing.drawTime = r.drawTime
        delete existing.drawDate
        const ci = canonicalSlotInfo(r.drawTime)
        if (ci) byCanonDay.set(`${ci.date}|${ci.slot}`, existing)
        patched++
      }
    }
  }

  // Nothing changed: keep file as-is to avoid unnecessary watcher invalidation.
  if (newRecords.length === 0 && patched === 0) {
    return { total: old.length, added: 0, newRecords, patched: 0, changed: false }
  }

  // Sort: unified sort by effective draw position.
  // Real-timed records (not T00:00:00) use their actual timestamp.
  // Date-only ky records (T00:00:00) use midnight of their date + ky as tiny offset,
  //   so they sort AFTER any real-timed record from the SAME day but BEFORE records from earlier dates.
  //   This correctly positions Source A's date-only records relative to Source C's real-timed records.
  old.sort((a, b) => {
    function sortKey(r) {
      if (r.drawTime && !r.drawTime.endsWith('T00:00:00+07:00')) {
        return new Date(r.drawTime).getTime()          // real timestamp (largest within a day)
      }
      if (r.drawTime && r.ky) {
        // Date-only ky: midnight of that date + ky ms offset (unique within day, stays below real timestamps)
        return new Date(r.drawTime).getTime() + Number(r.ky)
      }
      if (r.drawTime) return new Date(r.drawTime).getTime()  // date-only, no ky
      return r.ky ? Number(r.ky) : 0                         // no drawTime at all
    }
    return sortKey(b) - sortKey(a)  // descending
  })
  await fs.ensureFile(FILE)
  await atomicWriteJSON(FILE, old)
  // Update in-process cache so the next merge() call (e.g. Source A after Source C)
  // skips the 8 MB re-read and sees the data we just wrote.
  try { _crawlHistoryCacheMtime = (await fs.stat(FILE)).mtimeMs } catch (_) { }
  _crawlHistoryCache = old
  // Keep a last-known-good snapshot for corruption recovery.
  await atomicWriteJSON(BACKUP_FILE, old)
  return { total: old.length, added: newRecords.length, newRecords, patched, changed: true }
}

/**
 * Primary-source crawl — main entry point called by the server loop every 60s.
 *
 * Strategy: bingo18.top (Source C) is the PRIMARY source — fast, full timestamps, no captcha.
 *   Sources A (vietlott.vn) and B (xoso.net.vn) are FALLBACK — only called when C fails.
 *   This avoids hitting rate-limited sites unnecessarily. A/B provide ky numbers to
 *   promote no-ky Source C records.
 *
 * @returns {{ total, added, newRecords, changed }}
 */
async function run() {
  const t0 = Date.now()
  let resultC = null
  let resultA = null
  let resultB = null
  let cFailed = false

  // ── Primary: Source C (bingo18.top) — fast JSON, full timestamps ──────
  // Source C returns a 45-day rolling window (~7200 records). For regular crawl ticks
  // we only need recent records — merging all 7200 every 60s was the main crawl bottleneck.
  // 24-hour window covers any reasonable restart gap; deep recovery fills longer outages.
  const SOURCE_C_WINDOW_MS = 24 * 60 * 60 * 1000  // 24h ≈ 240 draws
  try {
    const recs = await fetchBingo18Top()
    if (recs.length > 0) {
      const cutoffMs = Date.now() - SOURCE_C_WINDOW_MS
      const recentRecs = recs.filter(r => {
        const t = r.drawTime ? new Date(r.drawTime).getTime() : NaN
        return !isNaN(t) && t >= cutoffMs
      })
      const mergeRecs = recentRecs.length > 0 ? recentRecs : recs.slice(0, 30)
      resultC = await queuedMerge(mergeRecs)
      console.log(`[crawl] C(bingo18top): ${recs.length} total, ${mergeRecs.length} recent → +${resultC.added} new patched=${resultC.patched}`)
    } else {
      cFailed = true
    }
  } catch (err) {
    console.warn('[crawl] C(bingo18top) failed:', err.message)
    cFailed = true
  }

  // ── Always: Source A (vietlott) — provides authoritative ky numbers to promote C records ──
  const pA = fetchVietlott().then(async (recs) => {
    if (recs.length === 0) return
    resultA = await queuedMerge(recs)
    const maxKy = Math.max(...recs.map(r => Number(r.ky)))
    console.log(`[crawl] A(vietlott): ${recs.length} recs (ky≤${maxKy}) +${resultA.added} new`)
  }).catch(err => console.warn('[crawl] source A error:', err.message))

  // ── Fallback: Source B (xoso) — only when C failed ────────────────────
  let pB = Promise.resolve()
  if (cFailed) {
    pB = fetchHtml().then(async (recs) => {
      if (recs.length === 0) return
      resultB = await queuedMerge(recs)
      const maxKy = Math.max(...recs.map(r => Number(r.ky)))
      console.log(`[crawl] B(xoso): ${recs.length} recs (ky≤${maxKy}) +${resultB.added} new`)
    }).catch(err => console.warn('[crawl] source B error:', err.message))
  }

  await Promise.allSettled([pA, pB])

  const elapsed = Date.now() - t0

  if (!resultA && !resultB && !resultC) {
    const current = await loadHistorySafe()
    console.log(`[crawl] all sources empty (${elapsed}ms)`)
    return { total: current.length, added: 0, newRecords: [], changed: false }
  }

  const totalAdded = (resultC?.added || 0) + (resultA?.added || 0) + (resultB?.added || 0)
  const allNew = [
    ...(resultC?.newRecords || []),
    ...(resultA?.newRecords || []),
    ...(resultB?.newRecords || []),
  ].sort((a, b) => {
    const ka = a.ky ? Number(a.ky) : 0
    const kb = b.ky ? Number(b.ky) : 0
    if (ka && kb) return kb - ka
    return (b.drawTime || '').localeCompare(a.drawTime || '')
  })

  const after = await loadHistorySafe()
  if (totalAdded > 0) {
    const latestKy = allNew.find(r => r.ky)?.ky
    console.log(`[crawl] done ${elapsed}ms — total: ${after.length} (+${totalAdded} new${latestKy ? ', latest ky:' + latestKy : ''})`)
  }

  const latestKy = after.find(r => r.ky)?.ky || null

  return {
    total: after.length,
    added: totalAdded,
    newRecords: allNew,
    latestKy,
    changed: totalAdded > 0 || (resultC?.patched || 0) + (resultA?.patched || 0) + (resultB?.patched || 0) > 0,
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

module.exports = { crawl: run, crawlPage, crawlAll, crawlSince, run, merge, fetchBingo18Top, parseBingo18Top, canonicalSlotInfo }

if (require.main === module) {
  const all = process.argv.includes('--all')
  const seedC = process.argv.includes('--seed-c')
  const since = process.argv.find(a => a.startsWith('--since='))?.split('=')[1]
  const pages = parseInt(process.argv.find(a => a.startsWith('--pages='))?.split('=')[1]) || 100

  if (since) {
    crawlSince(Number(since), pages).catch(err => { console.error(err.message); process.exit(1) })
  } else if (all) {
    crawlAll(pages).catch(err => { console.error(err.message); process.exit(1) })
  } else if (seedC) {
    // One-shot import of all bingo18.top history (45-day window)
    console.log('[seed-c] importing bingo18.top data.json…')
    fetchBingo18Top().then(async (recs) => {
      console.log(`[seed-c] fetched ${recs.length} records from bingo18.top`)
      const result = await merge(recs)
      console.log(`[seed-c] done — added ${result.added} | patched ${result.patched} | total ${result.total}`)
    }).catch(err => { console.error('[seed-c] ERROR:', err.message); process.exit(1) })
  } else {
    run().catch(err => { console.error('[crawl] ERROR:', err.message); process.exit(1) })
  }
}
