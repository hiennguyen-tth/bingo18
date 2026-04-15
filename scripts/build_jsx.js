#!/usr/bin/env node
/**
 * scripts/build_jsx.js
 * Pre-compiles web/heatmap.jsx and web/app.jsx → .js files.
 * Run via: npm run build
 *
 * Eliminates Babel Standalone (~6MB) from the browser's critical path:
 * - Before: browser downloads Babel + compiles JSX → 2-5s blank screen
 * - After:  browser loads plain pre-compiled JS → instant mount
 */
'use strict'

const babel = require('@babel/core')
const fs = require('fs')
const path = require('path')

const WEB = path.join(__dirname, '../web')
const FILES = ['heatmap.jsx', 'app.jsx']

const opts = {
    presets: [['@babel/preset-react', { runtime: 'classic' }]],
    sourceMaps: false,
    compact: false,       // readable output (not critical; gzip handles size)
}

let ok = true
for (const src of FILES) {
    const srcPath = path.join(WEB, src)
    const destPath = path.join(WEB, src.replace('.jsx', '.js'))
    try {
        const code = fs.readFileSync(srcPath, 'utf8')
        const result = babel.transformSync(code, { ...opts, filename: src })
        fs.writeFileSync(destPath, result.code, 'utf8')
        const kb = (Buffer.byteLength(result.code, 'utf8') / 1024).toFixed(1)
        console.log(`✓  ${src}  →  ${path.basename(destPath)}  (${kb} KB)`)
    } catch (err) {
        console.error(`✗  ${src}: ${err.message}`)
        ok = false
    }
}

if (!ok) process.exit(1)
console.log('Build complete.')
