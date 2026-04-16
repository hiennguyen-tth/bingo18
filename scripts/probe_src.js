'use strict'
const axios = require('axios')
const cheerio = require('cheerio')

const AJAX_URL = 'https://xoso.net.vn/XSDienToan/GetKetQuaBinGo18More'
const LIVE_URL = 'https://xoso.net.vn/xs-bingo-18.html'
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Referer': 'https://www.google.com.vn/'
}

function extractKys(html) {
    const $ = cheerio.load(html)
    const kys = []
    $('.bingo_ky').each((_, el) => {
        const m = $(el).text().match(/#(\d+)/)
        if (m) kys.push(Number(m[1]))
    })
    return kys
}

async function probe() {
    // HTML page
    try {
        const r = await axios.get(LIVE_URL + '?_t=' + Date.now(), { timeout: 12000, headers })
        const kys = extractKys(r.data)
        console.log('HTML page: ky', Math.min(...kys), '-', Math.max(...kys), '(', kys.length, 'kys), size:', r.data.length)
    } catch (e) { console.log('HTML page error:', e.message) }

    // AJAX pages
    for (const page of [1, 10, 50, 100, 500, 1000, 2000, 4000]) {
        try {
            const r = await axios.get(AJAX_URL, { params: { pageIndex: page }, timeout: 10000, headers })
            if (!r.data || r.data.trim().length < 50) { console.log('AJAX page', page, ': empty'); continue }
            const kys = extractKys(r.data)
            if (kys.length) console.log('AJAX page', page, ': ky', Math.min(...kys), '-', Math.max(...kys), '(', kys.length, 'kys)')
            else console.log('AJAX page', page, ': no kys, len=', r.data.length)
        } catch (e) { console.log('AJAX page', page, 'error:', e.message) }
    }
}

probe().catch(console.error)
