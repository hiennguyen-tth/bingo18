# Bingo18 Analyzer

Hệ thống **phân tích thống kê** Bingo18 dùng **5-model Ensemble** — normalize từng model về `[0, 1]`, kết hợp qua **sigmoid với trọng số đã học**. Crawler dùng **triple-source parallel** (vietlott.vn + xoso.net.vn + bingo18.top song song), phục vụ qua REST API + Dashboard React + Bảng lịch sử theo khung giờ, deploy trên Fly.io.

> **Production:** https://xs-bingo18.fly.dev

---

## v18 Changes (current — 2026-04-18)

### UI — Tab Navigation + Cache Busting
- **Tab nav bar** trên section "Lịch sử theo giờ": Tab active "📊 Lịch sử theo giờ" + link "↗ Bảng đầy đủ" → `/history-table` + link "🏆 Loto 5/35" → `https://lotto535.fly.dev` (ở phải).
- **Header buttons**: `📅 Lịch sử` → `/history-table` (indigo) + `🏆 Loto 5/35` → `https://lotto535.fly.dev` (green gradient, `target="_blank"`).
- **Cache busting**: Script tags trong `index.html` có `?v=20260418` để force browser refresh sau deploy.
- **DrawPivotTable**: Fetch từ `/api/history-grid` (canonical 160 slots 06:00–21:54), không dùng raw history records. Ball colors match `history.html` (purple=HOA, blue=Pair, orange=Normal). Cell colors theo sum/pattern.

### Crawler — Source C (bingo18.top) already running in parallel
- Source C `https://bingo18.top/data/data.json` đã chạy song song với Source A/B từ v16.
- Cung cấp `drawAt` full timestamp (HH:MM), faster update ~1 min, không cần auth.
- Khi deploy: 3 sources (A+B+C) fire parallel; C thường về sớm nhất vì không bị 403.

---

## v17 Changes (2026-04-17)

### Canonical 6-minute Slot System
- **`canonicalSlotInfo(drawTime)`**: Hàm chuẩn hóa mọi timestamp về khung giờ canonical 6 phút — từ 06:00 đến 21:54 VN (UTC+7). 160 slots/ngày. Formula: `slotIndex = Math.round((totalMin - 360) / 6)`, `canonMin = 360 + slotIndex * 6`. Trả `{ slot: "HH:MM", date: "YYYY-MM-DD" }` hoặc `null` nếu ngoài giờ.
- **Crawler merge() rewritten**: Thay vì match bằng exact minute + ball comparison (dễ miss khi Source C offset 1-5 phút), giờ match bằng canonical slot + ngày. Source C records (không có kỳ) được merge chính xác với Source A/B records.
- **History-grid API**: Dùng `canonicalSlotInfo()` — trả đúng 160 slots canonical (06:00, 06:06, ..., 21:54), không còn 474 slots rải rác.
- **DrawPivotTable (frontend)**: Snap về canonical slot thay vì dùng raw HH:MM.

### Data Deduplication
- **`scripts/dedup.js` rewritten**: Group records theo canonical slot+ngày. Loại bỏ no-ky records trùng slot với ky-records. Kết quả: **50,108 → 45,881 records** (loại 4,227 duplicates từ Source C).
- **Dry-run mode**: `node scripts/dedup.js` (preview) / `node scripts/dedup.js --write` (apply). Auto-backup `.pre-dedup.bak`.

### History Page Improvements
- **Default 5 ngày** (thay vì 14) — tập trung dữ liệu gần nhất.
- **Empty cells**: Near-invisible styling (`border-color: rgba(255,255,255,0.03)`, dot `·` cùng màu background) — nhìn chuyên nghiệp hơn, không bị khoảng trống.

### UI — History Navigation Button
- **Gradient button** trong header-actions: `📅 Lịch sử` với `background: linear-gradient(135deg, #6366f1, #818cf8)`, white text, box-shadow. Dễ thấy, dễ navigate.

### Backtest Coverage Increase
- **Stats `_computeStatsBackground()`**: Target 500 test windows (thay vì 150), start từ 20% data (thay vì 30%). Kết quả: ~350+ tests thay vì ~106.

---

## v16 Changes (2026-04-17)

### Crawl — Triple Source (thêm bingo18.top)
- **Source C: bingo18.top** (`/data/data.json`) — public JSON ~627KB, 7000+ records, cập nhật ~1 phút/lần. Cung cấp `drawAt` (ISO HH:MM), `winningResult` (3-digit string). Không có số kỳ (ky).
- **`parseBingo18Top(raw)`:** Parse `raw.gbingoDraws[]`, validate từng ball 1–6 (dùng `Number.isInteger`), tính sum/pattern, gán SHA1 id `dt-${drawTime}-${balls}`.
- **`fetchBingo18Top()`:** GET `https://bingo18.top/data/data.json` với 15s timeout.
- **`merge()` nâng cấp:** Xử lý `_srcC=true` records — match bằng `bySlot` map (YYYY-MM-DDTHH:MM + balls), patch `drawTime` trên records hiện tại nếu có T00:00:00 (date-only từ Vietlott).
- **`--seed-c` CLI flag:** One-shot import toàn bộ history từ bingo18.top (`node crawler/crawl.js --seed-c`). Dùng sau deploy để patch timestamps cũ.
- **`run()` → triple Promise.allSettled:** pA (Vietlott), pB (xoso), pC (bingo18top) fire song song. Sort kết hợp: ky-desc > ky first > drawTime-desc.

### Frontend — Bảng lịch sử theo khung giờ
- **`/history-table`** — trang lịch sử mới (file `web/history.html`), hiển thị bảng slot×ngày giống bingo18.top.
  - Hàng = khung giờ (HH:MM), cột = ngày (YYYY-MM-DD), cell = 3 bi với màu.
  - Click cell để highlight tất cả cell có cùng combo (order-independent).
  - Footer rows: HOA (triple), x40, x12, x20.
  - Auto-refresh 60s trong 06:00–22:00. Scroll đến slot hiện tại khi load.
- **Nav link** trong header React app: `📅 Lịch sử` → `/history-table`.

### API — `/api/history-grid`
- **`GET /api/history-grid?days=N`** (N: 3–60, default 15): Trả `{ slots, dates, cells, days, total, generated }`.
  - Bỏ qua records có `drawTime` chứa `T00:00:00` (date-only từ Vietlott, chưa có HH:MM).
  - Timezone fix: `d.getTime() + 7 * 3600_000` (không dùng `getTimezoneOffset()` — sai khi server ở VN).
  - Cache 60s in-memory với ETag support.

---

## v15 Changes (2026-04-17)

### Crawl — Vietlott AjaxPro + xoso fallback

**Phát hiện gốc rễ:** Vietlott trả **403 Forbidden** từ IP Fly.io (Singapore). Source A (HTML) im lặng. Vietlott AjaxPro cũng bị 403. Chỉ xoso.net.vn là hoạt động từ overseas hosting.

- **`crawlPage()` — Vietlott AjaxPro (primary) + xoso AJAX (fallback):**
  - Thử **Vietlott AjaxPro** trước (`POST /ajaxpro/...GameBingoCompareWebPart.ashx`, 6 draws/page, nguồn chính thức, không rate-limit). Hoạt động từ VN/local.
  - Nếu 403 (overseas IP bị chặn) → tự động fall back sang **xoso AJAX** (15 draws/page).
  - Đảm bảo gap recovery (`crawlSince`, `crawlAll`) hoạt động trên cả môi trường local và Fly.io.
- **`fetchVietlott()` 403 im lặng:** 403 không còn log warning (biết chắc là IP block, không phải lỗi), giữ log sạch trên production.
- **Deep recovery cải tiến:** Chạy ngay khi startup (không cần chờ `!changed`), kiểm tra 60 ky gần nhất (thay vì 30), dùng 20 pages (≈120 draws ≈ 10h buffer).

### Crawl — kiến trúc tổng quan

```
Mỗi 60 giây:
  Source A [PRIORITY]: vietlott.vn HTML — 6 kỳ mới nhất, chính thức.
                       403 từ Fly.io → im lặng, xoso lo phần này.
  Source B [BACKUP]:   xoso.net.vn HTML — 15 kỳ + HH:MM drawTime.

  crawlPage() cho gap recovery (crawlSince / crawlAll):
    └─ Try: Vietlott AjaxPro (6/page, nhanh, chính xác, hoạt động từ VN)
    └─ 403? → Fallback: xoso AJAX (15/page, hoạt động từ mọi IP)
```

---

## v19 Changes (2026-04-18)

### 🌸 HOA Forecast — Dự báo Hoa theo block giờ
- **Endpoint `/api/hoa-forecast`**: Phân tích 30 ngày lịch sử, nhóm theo block giờ (06–21h).
- **Block scoring**: Mỗi block giờ × kỳ được chấm điểm dự báo từ: base-rate, recency, Markov transition, hourly bias, streak bonus/penalty. Softmax → xác suất 6 pattern HOA (111–666).
- **Hourly summary**: Hiển thị **tổng kỳ, số lần HOA thực tế, tỷ lệ %** cho mỗi khung giờ — thay thế "10/10 kỳ" cũ (bug hiển thị predicted count thay vì actual). Top 3 giờ nóng nhất được highlight 🔥.
- **Chuỗi HOA (streak view)**: Phân tích chuỗi ngày liên tiếp có HOA cho mỗi pattern. Hiển thị trạng thái: 🔥 ĐANG NỔ MẠNH (≥4 ngày), ⚡ ĐANG NỔ (≥2 ngày), ❄️ ĐANG NGHỈ (0 ngày).
- **Hotness bar**: Bar chart trực quan tỷ lệ HOA theo giờ, highlight giờ hiện tại (tím) và giờ nóng (vàng).
- **3 tab view**: Theo giờ | Chuỗi HOA | Chi tiết (top-3 pattern/kỳ).

### UI — Cải thiện màu sắc & trải nghiệm
- **Sum color contrast**: `cellBg()` tăng opacity từ 0.12 → 0.22 cho cả low-sum (blue) và high-sum (orange). Dùng `rgb(96,165,250)` (blue) và `rgb(251,146,60)` (orange) — dễ phân biệt hơn trên dark theme.
- **Cache-busting**: Bump `?v=20260418c` cho immutable JS files.

---

## v18 Changes (2026-04-18)

### 🌸 HOA Forecast — Backend foundation
- **`/api/hoa-forecast` endpoint**: 30-day analysis, block-level scoring, daily cache.
- **Auto-reload**: DrawPivotTable (lịch sử) tự reload mỗi 60s (silent, không flash).
- **Sum prediction fix**: `load()` xử lý `sumRaw` trước khi check 304 → sum không còn bị stuck.

---

## v14 Changes (2026-04-17)

### Crawl — thêm vietlott.vn (nguồn chính thức ưu tiên)
- **Source A (priority): vietlott.vn** — nguồn chính thức của Vietlott, cập nhật ngay sau mỗi kỳ. Parse bảng HTML `.bong_tron_bingo` với ky dạng `#0162535` (strip leading zeros).
- **Source B: xoso.net.vn HTML** — backup, cung cấp `drawTime` (HH:MM) để enrich record chất lượng.
- Cả 2 source vẫn fire song song; write-queue đảm bảo không race condition.

### UI — toast thông báo thay vì auto-rerender
- **SSE `new-draw`:** khi có kỳ mới, chỉ hiện toast thông báo, **không tự rerender**.
- **Nhấn "↻ Cập nhật ngay"** trên toast → force-refresh toàn bộ dữ liệu (predict, history, overdue, stats).
- **Nhấn "Bỏ qua"** → tắt toast, giữ nguyên view hiện tại.
- Toast tự tắt sau 12s (tăng từ 6s để có thêm thời gian đọc).

### History display — tách hiển thị vs. training
- `/history?limit=800` thay vì 1000 — hiển thị ~5 ngày gần nhất (5 × 159 kỳ/ngày = 795).
- Label "**hiển thị 800 / 47k kỳ**" — rõ ràng phân biệt data đang xem vs. tổng data training.
- Training model vẫn dùng toàn bộ history.json (47k+ records) qua `/predict`.

---

## v13 Changes (2026-04-16)

### Crawl — Pure Dual-Source Race
- **Rewrite crawl.js:** Bỏ logic phức tạp (retry 8s/12s/15s khi gap), về lại **crawl thuần 2 source song song**.
- **Write queue serialization:** `_writeQueue + queuedMerge()` — serialize concurrent merge calls, no concurrent file writes.
- **Data safety:** `merge()` chỉ thêm/patch, không bao giờ xóa. Atomic write (write tmp → move). Backup file cập nhật sau mỗi write thành công.

### Server — Stability Fixes
- **Crawl interval 12s → 60s:** 12s gây rate-limiting xoso.net.vn → 2h data gap. 60s đủ nhanh (5–6× margin), giảm request 5×.
- **Bỏ startup `crawlSince(lastKy, 50)`:** Thay bằng 1 crawl đơn giản tại startup.
- **Consecutive fail counter + Health fields:** `lastSuccessfulCrawlAt`, `crawlLagMs`, `consecutiveCrawlFails`.
- **Graceful shutdown:** SIGTERM/SIGINT đóng SSE clients sạch.
- **Stats TRAIN_CAP:** 10k → 5k records/slice (OOM prevention).
- **Security headers:** `X-Content-Type-Options`, `X-Frame-Options`.

---

## Kiến trúc Crawl

```
Mỗi 60 giây (06:00–22:00 VN):
  ┌─ Source A [PRIORITY]: vietlott.vn/...winning-number-bingo18
  │   Thời gian: ~800ms | Dữ liệu: 6 kỳ mới nhất | Nguồn chính thức
  │   ⚠ 403 từ Fly.io Singapore → im lặng, xoso + bingo18top cover
  ├─ Source B [BACKUP]:   xoso.net.vn/xs-bingo-18.html
  │   Thời gian: ~700ms | Dữ liệu: 15 kỳ + HH:MM drawTime
  └─ Source C [TIMESTAMP]: bingo18.top/data/data.json
      Thời gian: ~300ms | Dữ liệu: 7000+ records, ISO HH:MM timestamps

  → Cả ba fire đồng thời (Promise.allSettled)
  → merge() xử lý _srcC records: match theo canonical 6-min slot+ngày (v17)
  → Seed-C: node crawler/crawl.js --seed-c (import bulk từ bingo18.top)
  → Dedup: node scripts/dedup.js --write (loại duplicate cross-source)

  Historical (crawlAll / crawlSince — gap recovery tự động mỗi 10 phút):
    crawlPage(n) → Try: Vietlott AjaxPro (POST /ajaxpro/..., 6/page, từ VN)
                → 403? → Fallback: xoso AJAX (GET /pageIndex=N, 15/page, từ mọi IP)
```

---

**v11 Changes:**
- **Digit-position recency cooldown:** Top-10 giờ xoay tích cực hơn — combo chia sẻ ≥2 digit-position với 3 kỳ gần nhất bị penalty exponential (ví dụ: kỳ vừa ra 1-1-2 → combo 1-1-x bị giảm ~45% score)
- **GBM retrained on 41k+ records:** Model E (GBM) giờ train trên toàn bộ 41698 records × 72 features (thêm day_of_week, ky_in_day, sum_lags). `GBM_MAX_STALENESS` tăng từ 200→2000
- **Ensemble weights v7:** wA=0.38, wB=0.15, wC=0.05, wD=0, wE=0.15. ModelD disabled (wD=0) — k-NN trên 41k records mất ~1-2s/call, block event loop khi backtest × 300 steps → Fly health check timeout → 503
- **Crawl interval 60s:** Poll đủ chậm để không gây tải, đủ nhanh so với 6 phút/kỳ

**v12.5 Changes (current):**
- **`crawlSince(fromKy, maxPages)`:** Thay thế startup gap recovery 5-trang cứng bằng `crawlSince()` thông minh — tự tính liveKy từ page 1, ước tính trang bắt đầu theo linear model (15 ky/trang), sweep từ trang đó về page 1 (mới nhất). Kết quả: chỉ crawl số trang thực sự cần thiết (thay vì 5 trang cố định có thể thiếu hoặc thừa).
- **Deep recovery dùng `crawlSince`:** `runDeepRecovery()` (max 1 lần/10 phút) cũng dùng `crawlSince(lastKy, 30)` thay vì 3-page brute-force.
- **`--since=KY` CLI flag:** `node crawler/crawl.js --since=162000 --pages=50` — fill gap từ ky cụ thể.
- **Data:** 41,900+ kỳ lịch sử, gaps từ thời kỳ downtime server đã được fill tự động.

**v12.4 Changes:**
- **Parallel HTML + AJAX (restored, enhanced):** Test thực tế cho thấy AJAX endpoint bị server-side cache phía Vietlott — trả về chậm hơn HTML 5–15 kỳ. Ví dụ: HTML đã có ky=162458 (18:04 VN) trong khi AJAX vẫn chỉ trả ky=162443 (15:34 VN). Không thể bỏ HTML. Giữ lại parallel `Promise.all(HTML, AJAX)` + merge unique theo `id` — mỗi tick 2 request, merge 30 kỳ (15 HTML + 15 AJAX) — luôn có ky mới nhất từ HTML, AJAX làm backup nếu HTML chậm.
- **Crawl interval 30s → 12s:** HTML + AJAX parallel mất ~470ms/tick. 12s interval – 30× margin so với chu kỳ 6 phút/kỳ — max lag 12s thay vì 30s.

**v12.3 Changes:**
- **Pivot table: dynamic slots từ crawl data:** Trước đây pivot dùng grid cứng 159 khung giờ (06:05+n×6 phút), rồi snap từng kỳ vào khung gần nhất bằng `Math.round`. Bug: xoso.net.vn publish kết quả với lag 0–6 phút thay đổi → 2 kỳ khác nhau có thể round vào cùng khung → 1 kỳ bị drop silently (hệ thống "keep first seen", newest-first). **Fix v12.3:** Dùng HH:MM thực tế từ `drawTime` của mỗi kỳ làm slot label — không snap, không drop. Mỗi kỳ luôn xuất hiện đúng giờ nó được crawl.
- **Markov Reality Check — 7 experiments:** `scripts/markov_reality.js` + endpoint `GET /experiments/markov-reality`. Kết quả trên 41746 kỳ xác nhận Markov-1 là illusion (xem bảng bên dưới).

**v12.2 Changes:**
- **Parallel crawl (HTML + AJAX):** Trước đây `crawl()` chỉ gọi AJAX khi HTML fail hoặc trả về rỗng. HTML page `xs-bingo-18.html` có server-side cache của xoso.net.vn → `?_t=timestamp` cache-buster chỉ bypass CDN, không bypass origin cache → hệ thống luôn nhận HTML cũ, AJAX (real-time hơn) không bao giờ được thử → chậm 2-3 kỳ. **Fix:** Fetch HTML và AJAX *đồng thời* (`Promise.all`), merge unique records theo `id`, log `fresher:html|ajax`. Mỗi tick vẫn chỉ gửi 2 request đến nguồn — rate cực kỳ lịch sự.
- **Crawl interval 60s → 30s:** Halved để giảm lag tối đa (max wait 30s thay vì 60s). Draws mỗi 6 phút → vẫn còn 12× margin.

**v12 Changes:**
- **loadHistory mtime cache:** Không còn đọc lại 8 MB JSON từ disk mỗi request. Cache được giữ trong RAM và invalidate tự động khi file thay đổi (kiểm tra `mtimeMs`). Toàn bộ request đọc history đều từ RAM sau lần đầu tiên.
- **Startup gap recovery:** Khi server khởi động, tự động crawl **5 trang phân trang** (75 kỳ gần nhất) trong background để fill các gap do restart/outage. Runs once per container start.
- **Periodic deep recovery:** Sau mỗi crawl tick không có kỳ mới, kiểm tra 30 ky gần nhất có gap hay không. Nếu có gap → crawl thêm 3 trang để tự sửa. Rate-limited max 1 lần/10 phút.
- **SSE `reload: true` flag:** Broadcast `new-draw` giờ thêm `{ reload: true }` để client biết phải reload toàn bộ (predict, history, sum, overdue).
- **Operating hours 22:00 nhất quán:** Sửa bug ở `app.jsx` polling dùng 21:54 (1314) thay vì 22:00 (1320). Cả server và client giờ dùng 06:00–22:00 VN.
- **Sum prediction sửa theoretical weight (P0):** Score của mỗi sum giờ được nhân với `sqrt(P(sum) / P_max)` sau khi tính z-score / Markov / session. Sum=3 (1/216) nhận penalty 0.19×, sum=10/11 (27/216) giữ nguyên 1.0×. Ngăn sum hiếm (sum=3 đang hạn) outrank sum phổ biến (sum=10 vừa ra) dù xác suất tuyệt đối của sum=10 cao hơn 27×.
- **P0 Ablation experiments:** `node backtest/run_backtest_sum.js --model zscore-only|markov-only|session-only`. Kết quả trên 41k records (352 test windows):
  - `zscore-only`: top-1 **9.38%** (p=0.015 significant) — has some signal, partly artifact of non-uniform sum distribution
  - `markov-only`: top-1 **12.50%** (p≈0, top-5 55.11%!) — **strongest signal**; BUT cần note: theoWeight có thể là self-fulfilling (sum=10/11 được predict cao, chúng cũng xuất hiện nhiều nhất = 27/216 = 12.5% mỗi cái). Cần baseline "always predict 10/11" để xác nhận real Markov transition.
  - `session-only`: top-1 8.24% (p=0.12 ns) — **no significant signal**
  - `full`: top-1 **13.07%** (p≈0, top-5 53.69%) — full model tốt nhất
- **P1 Hierarchical endpoint `/predict-hierarchical`:** Predict sum → top-N buckets → portfolio select chỉ trong buckets đó. `GET /predict-hierarchical?top=5` (mặc định top-5 sums). Falls back to full 216 nếu < 15 combos survive.
- **P2 Training objective fix:** `train_weights.js` giờ tính `runStatTests()` cho từng training window và apply production-equivalent Bayesian shrink (wA×shrink, wB×shrink, wD×shrink). Weights học ra giờ phản ánh đúng điều kiện production (no_pattern → A/B/D=0). Trước đây weights được học với assumption A/B/D luôn active → overfit, miscalibrated.

**Sum Prediction (v10):** Thêm endpoint `/predict-sum` — dự đoán 16 outcomes (sum=3..18) thay vì 216 combo. Sử dụng Markov-1 transition + z-score overdue + session frequency. Với 43k draws, mỗi sum state có ~168 samples — đủ tin cậy hơn combo-level prediction.

**Model D Gower Distance (v10):** Thay Euclidean bằng **Gower distance** — xử lý mixed features: Hamming cho categorical (pattern), Manhattan cho numerical (sum/digits). Phù hợp hơn cho feature space bao gồm cả ordinal và nominal dimensions.

Kể từ logic mới nhất, `/stats` bổ sung **Reality Check** (chi-square, autocorr, runs), chia 3 segment (train/valid/forward), và trả thêm **calibrated hit rate theo từng rank**. Triple signal chỉ còn là lớp thông tin hỗ trợ; top-10 không còn ép combo hoa lên đầu bằng bypass. **Cooldown penalty** ngăn combo vừa xuất hiện tiếp tục được suggest (fix h6 re-suggest bug).

UI lịch sử đã chuyển từ bảng phẳng 500 kỳ sang **pivot theo ngày × khung giờ chuẩn 159 kỳ/ngày** (06:05 → 21:53, mỗi 6 phút; lấy tối đa 1000 kỳ gần nhất): highlight khác màu cho `same sum`, `đôi`, `hoa`, và `same pair/triple` giữa các ngày sát nhau ở cùng time slot.

**Dataset (Apr 2025 update):** 43,000+ kỳ lịch sử từ 2025-07-06 import từ Excel (`scripts/import_excel.py`). Tổng dữ liệu huấn luyện tăng 28× giúp model có sample size lớn hơn đáng kể.

> **Production:** https://xs-bingo18.fly.dev

---

## ⚠️ Giới hạn thống kê — Đọc trước khi dùng

Đây là những sự thật cần nhìn thẳng trước khi diễn giải bất kỳ kết quả nào:

| Thực tế | Chi tiết |
|---------|----------|
| **p-value = 0.51** | Top-10 đạt 5.07% vs random 4.63% (+9.5% relative) — nhưng **chưa có ý nghĩa thống kê**. Khả năng cao đây là variance, không phải edge. Cần thêm nhiều kỳ để kết luận. |
| **Reality check = no_pattern** | Chi-square p=0.18, autocorr p=0.41, runs p=0.62 → cả 3 test đều không reject H0. P1 experiments confirm: autocorr ns ở mọi lag, chi-by-hour chỉ marginal (1/16 hour p=0.04 — Bonferroni ns), Markov-1 sum pooled p=0.60 (ns). Data IID random. |
| **Effective pipeline = 2 models** | `wA=0.38, wB=0.15, wC=0.05, wD=0, wE=0.15` → khi `no_pattern`, shrink=0 khiến wA=wB=wD=0. **Model C (5%) + Model E GBM (15%) active** → effective: sess=25%, gbm=75%. GBM trained on 41698 records × 72 features → phân phối phi-uniform hợp lý. Top-10 xoay nhờ digit-position recency penalty. (**P2**: train_weights.js giờ học weights có production-equivalent shrink → weights chính xác hơn.) |
| **Bản chất IID** | Bingo18 / 36D có 216 outcomes. Không có bộ nhớ giữa các kỳ (4 experiments xác nhận). Về lý thuyết, không có edge dài hạn có thể khai thác. |

> **Tóm lại:** Hệ thống này là **công cụ thống kê giải trí**. Thuật toán giúp chọn combo đa dạng thay vì chọn ngẫu nhiên — không hơn, không kém. Đừng diễn giải top-10 là "AI dự đoán được kết quả".

---

## Cấu trúc thư mục

```
bingo/
├── api/
│   └── server.js              # Express API + SSE live stream + in-memory cache
├── crawler/
│   ├── crawl.js               # Primary crawler (xoso) + fallback (xomo) + rate limiting
│   └── realtime.js            # Standalone crawler loop (dùng local dev)
├── dataset/
│   └── history.json           # Dữ liệu đã crawl (persistent Fly volume)
├── predictor/
│   ├── ensemble.js            # 5-model ensemble v9 (sigmoid, learned weights, rankNorm)
│   ├── stats_tests.js         # Statistical reality check (chi-square, autocorr, runs)
│   ├── model_d.js              # k-NN Temporal Similarity (pure-JS)
│   ├── frequency.js           # Tần suất combo
│   └── features.js            # Feature engineering (dùng bởi /features endpoint)
├── dataset/
│   ├── history.json           # Dữ liệu đã crawl (persistent Fly volume)
│   ├── model.json             # Learned weights (auto-reload via watchFile)
│   ├── weights_history.json   # Time-series weight evolution log
│   └── backtest_history.json  # Time-series accuracy log
├── web/
│   ├── index.html             # Dashboard entry + AdSense injection
│   ├── app.jsx                # React 18 dashboard (Babel Standalone)
│   ├── heatmap.jsx            # Digit frequency heatmap
│   ├── about.html             # /about — SEO content page
│   ├── how-it-works.html      # /how-it-works — SEO content page
│   ├── privacy-policy.html    # /privacy-policy — SEO + AdSense requirement
│   ├── blog/
│   │   ├── what-is-bingo18.html    # /blog/what-is-bingo18
│   │   └── best-strategy-2026.html # /blog/best-strategy-2026
│   ├── ads.txt                # Google AdSense publisher declaration
│   ├── robots.txt             # Crawl rules + sitemap pointer
│   └── sitemap.xml            # XML sitemap (6 URLs)
├── scripts/
│   ├── build_jsx.js           # Pre-compile heatmap.jsx + app.jsx → .js (npm run build)
│   ├── train_weights.js       # Walk-forward weight optimisation
│   ├── experiments.js         # P1 micro-experiments (autocorr, chi-hour, runs, Markov-1)
│   ├── markov_reality.js      # 7-experiment Markov Reality Check (E1–E7) — feeds /experiments/markov-reality
│   └── dedup.js               # Dataset deduplication
├── backtest/
│   ├── run_backtest.js        # Walk-forward combo backtest
│   ├── run_backtest_sum.js    # Walk-forward sum prediction backtest (P0)
│   └── report.json            # Latest backtest results
├── fly.toml                   # Fly.io config
├── Dockerfile                 # node:20-alpine, JSX build step, port 8080
├── start.sh                   # Diagnostic wrapper → node api/server.js
└── README.md
```

---

## Performance Notes

| Concern | Before | After |
|---------|--------|-------|
| Page load (Babel Standalone) | 2–5s blank screen (6 MB download + JSX compile) | Instant — JSX pre-compiled at Docker build time via `npm run build` |
| `/predict` cold start | 370ms (blocks event loop on every cache-miss) | <5ms — pre-warmed on startup + disk-persisted (survives Fly restarts) |
| `/overdue` cold start | 200ms | <5ms — same pre-warm + disk-persisted |
| `/stats` | Disk-persisted, stale-while-revalidate | Unchanged — rate-limited to 1 recompute/10 min |
| `/history?limit=1000` | Re-reads 43K file on every request (`no-cache`) | 60s in-memory ETag cache, giữ nguyên khi không có kỳ mới |
| `/health` | Reads full 43K history.json on every check | Instant — reads from in-memory predict cache, no I/O |
| Stats blocking event loop | setImmediate every 10 iterations → 1s CPU blocks → health check fails | setImmediate **every 1 iteration** (~160ms max block) |
| 503 "load balancing" errors | Stats compute (52-100s) blocked event loop → health checks timeout → Fly 503 | Fixed by per-iteration yield + 10min rate limit on stats |
| Watcher cascade | Multiple history.json writes trigger multiple invalidations in seconds | 10s cooldown on file watcher + invalidateCache sets timestamp |
| Double-invalidation (crawl + watcher) | Stats computed twice per draw | Debounced 3.5s — computed once |
| Crawler no-new draws | Vẫn rewrite `history.json` → watcher invalidation liên tục | Không rewrite nếu không có thay đổi (`added=0 && patched=0`) |
| Crawler scheduler | `setInterval(30s)` có thể chồng tick khi source chậm | Vòng lặp tuần tự `60s` sau mỗi lần crawl xong, giảm skip chồng lệnh và ổn định hơn cho health check |
| **Crawl lag 2-3 kỳ** | HTML page `xs-bingo-18.html` có server-side origin cache. `?_t=timestamp` chỉ bypass CDN, không bypass origin → HTML luôn stale; AJAX (real-time) chỉ được gọi khi HTML *fail hoàn toàn* | **Parallel fetch:** HTML + AJAX đồng thời (`Promise.all`) → merge unique records → luôn lấy ky mới nhất từ cả hai nguồn. **Lưu ý (v12.4):** Test thực tế cho thấy HTML thường *fresher* hơn AJAX (AJAX có server cache riêng tự trả chậm 5–15 kỳ so với HTML). Merge đảm bảo luôn có kỳ mới nhất. Interval 60s → **12s** để giảm max wait. |
| History corruption risk | `readJSON().catch(()=>[])` có thể ghi đè mất dữ liệu | `loadHistorySafe()` + backup `.bak` + atomic write `.tmp→move` |
| **loadHistory cache** | Đọc 8 MB JSON từ disk mỗi lần gọi (mỗi request, mỗi tick crawl) | **mtime-based RAM cache**: chỉ đọc lại khi file thực sự thay đổi. Toàn bộ request chạy từ RAM sau lần đọc đầu tiên. `invalidateCache()` reset cache khi có kỳ mới. |
| **Kỳ bị miss (delayed publish)** | Nguồn đôi khi publish kỳ sau ~3–8s delay → crawl 60s vừa kịp bỏ lỡ → gap vĩnh viễn | **Startup `crawlSince(lastKy, 50)`**: tính liveKy từ page 1, ước tính trang bắt đầu tự động, sweep về page 1. **Periodic deep recovery** dùng `crawlSince(lastKy, 30)` thay brute-force 3 trang. CLI: `node crawler/crawl.js --since=KY`. |
| **Top 10 không đổi giữa các kỳ** | Model C dùng toàn bộ lịch sử session (~15k records) → 1 kỳ mới chỉ thay đổi 0.006% → rank không xoay | **Rolling window SESS_WINDOW=300** + **digit-position recency penalty** (v11): combo chia sẻ ≥2 digit-position với 3 kỳ gần nhất bị phạt exponential. |
| **model.json từ volume cũ** | `start.sh` chỉ copy vào volume ở lần boot đầu tiên → nếu volume có `wC=0` từ training cũ, tất cả score = `sigmoid(bias) = 0.378` → Top 10 hoàn toàn random | `start.sh` luôn overwrite `model.json` từ image (git source of truth) mỗi lần khởi động |

**Pre-warm mechanism:** `invalidateCache()` clears the in-memory cache and immediately calls `_prewarmCaches()` (takes ~50ms) so the next HTTP request always hits a warm cache. The stats backtest is debounced 3.5s to collapse the crawl-write and the file-watcher detection into a single compute.

---

## Cài đặt local

```bash
cd bingo
npm install

# Crawl dữ liệu ban đầu
node crawler/crawl.js                    # crawl ~30 kỳ mới nhất từ xoso.net.vn (HTML + AJAX parallel)
node crawler/crawl.js --all              # crawl toàn bộ lịch sử (60 trang × 15 ≈ 900 kỳ)
node crawler/crawl.js --all --pages=200  # crawl sâu hơn (200 trang ≈ 3000 kỳ)
node crawler/crawl.js --since=162000    # fill gap từ ky 162000 đến hiện tại (tự động tính số trang)
node crawler/crawl.js --since=162000 --pages=100  # giới hạn tối đa 100 trang

# Pre-compile JSX → JS (chạy 1 lần hoặc sau khi sửa web/app.jsx / web/heatmap.jsx)
npm run build

# Chạy server
node api/server.js             # dashboard → http://localhost:8080

# Hoặc dùng npm run dev (tự build trước rồi chạy server)
npm run dev
```

---

## API Endpoints

| Method | Route | Mô tả |
|--------|-------|--------|
| GET | `/` | Dashboard React |
| GET | `/predict` | Top 10 combo + breakdown model + `tripleSignal` + `verdict` + `latestKy/latestDrawTime` — **cached 5 phút** |
| GET | `/predict-sum` | Dự đoán sum (16 outcomes, Markov-1 + z-score + session + **theoretical probability weight**) — **cached 5 phút** |
| GET | `/predict-hierarchical` | P1 hierarchical: dự đoán sum → filter top-N buckets → portfolio select. `?top=N` (default 5). Không cached. |
| GET | `/history?limit=1000` | Feed lịch sử cho pivot table ngày × giờ |
| GET | `/overdue` | Thống kê quá hạn: bộ ba / `anyTriple` / cặp đôi / tổng — **cached** |
| GET | `/stats` | Walk-forward backtest + Reality Check + Train/Valid/Forward + calibrated rank buckets — **disk-persisted, stale-while-revalidate** |
| GET | `/frequency` | Tần suất combo — **cached** |
| GET | `/events` | SSE stream — phát `new-draw` khi có kỳ mới |
| POST | `/crawl` | Crawl thủ công ngay lập tức (trả về `added/total/latestKy/changed`) |
| POST | `/admin/recover-history` | Emergency restore dữ liệu lịch sử (token-gated, disabled nếu thiếu `RECOVERY_TOKEN`) |
| GET | `/experiments/markov-reality` | 7 experiments xác nhận Markov-1 là illusion — **cached 30 phút** |
| GET | `/health` | Liveness probe (historySize, freshness, crawlerStatus, cacheKeys) |
| GET | `/ads.txt` | Google AdSense publisher declaration |
| GET | `/robots.txt` | Crawl rules + sitemap pointer |
| GET | `/sitemap.xml` | XML sitemap 6 URLs |

## SEO Content Routes

| Route | File | Mô tả |
|-------|------|--------|
| `/about` | `web/about.html` | Giới thiệu hệ thống, 7 tín hiệu, sứ mệnh |
| `/how-it-works` | `web/how-it-works.html` | Giải thích kỹ thuật chi tiết, walk-forward backtest |
| `/blog/what-is-bingo18` | `web/blog/what-is-bingo18.html` | Guide Bingo18 / Xổ số 36D |
| `/blog/best-strategy-2026` | `web/blog/best-strategy-2026.html` | Chiến thuật phân tích thống kê |
| `/privacy-policy` | `web/privacy-policy.html` | Bắt buộc cho AdSense review |

## Bảng Lịch Sử Theo Ngày/Giờ

Dashboard dùng `DrawPivotTable` để thay thế danh sách 500 kỳ:

- Cột: các ngày gần nhất (mới → cũ)
- Hàng: **các khung giờ thực tế từ crawl data** — không dùng grid cứng 159 khung chuẩn nữa. Khung giờ là HH:MM từ `drawTime` trả về bởi API, phản ánh thời điểm xoso.net.vn công bố kết quả. Do lag publish 0–6 phút ngẫu nhiên, grid thực tế có thể có nhiều hơn hoặc ít hơn 159 row/ngày.
- Mỗi ô hiển thị `n1 n2 n3` + `sum`
- Highlight theo rule:
  - `same sum` với ngày kề bên: nền đỏ nhạt
  - `đôi`: nền xanh/cyan
  - `hoa (triple)`: nền vàng
  - `same pair` hoặc `same triple` với ngày kề bên: highlight đậm hơn

Tổng kết theo ngày (`HOA`, `Đôi`, `Thường`) được đưa **lên trên bảng chi tiết** để user xem nhanh trước.
Trên mobile: pivot tự giảm số cột ngày hiển thị và giữ scroll ngang để đọc dễ hơn.

---

## Markov Reality Check — 7 Experiments (v12.3)

**Endpoint:** `GET /experiments/markov-reality` — chạy trên 41,834 kỳ, cache 30 phút.

**Mục đích:** Xác định liệu Markov-1 sum predictor có thực sự khai thác temporal signal hay chỉ riding marginal distribution (base-rate illusion). 7 experiments độc lập từ các góc độ khác nhau.

| Experiment | Mô tả | Kết quả (v12.3 live) | Kết luận |
|------------|-------|------|----------|
| **E1 — Baseline** | So sánh top-1 accuracy: Uniform (random) vs Marginal (frequency) vs Markov-1 (transition) | Uniform **6.25%**, Marginal **12.72%**, **Markov 12.55%** | Markov **thua 0.17%** so với marginal → không có temporal gain |
| **E2 — Shuffle Test** | Train trên dữ liệu xáo trộn ngẫu nhiên → nếu accuracy không đổi → thứ tự không quan trọng | Ordered **12.24%**, Shuffled **12.53%** → delta **−0.29%** | Thứ tự **không quan trọng**; data = IID |
| **E3 — Conditional vs Marginal** | Mean \|P(next=s \| prev) − P(next=s)\| across 216 transitions | Mean delta = **0.0046** (max=0.045) | Conditional ≈ marginal; mỗi state transition gần như độc lập |
| **E4 — Mutual Information** | I(X_{t−1}; X_t) in nats — informational dependency between consecutive states | **0.0026 nats** (max possible ≈2.77 nats) = **0.09% of max** | Gần như **hoàn toàn độc lập**; << 1 nat threshold |
| **E5 — KL Divergence** | KL(P(·\|prev) ‖ P(·)) per previous state — how much predictive dist diverges from marginal | Mean **0.0081** (max observed=0.049) | Distributions gần như **đồng nhất**; no divergence = no signal |
| **E6 — Adversarial** | Synthetic data: IID (should fail) vs Biased (should succeed if real) | IID test: **12.91%** (failed); Biased test: **34.77%** (succeeded) | **Test methodology valid** — can detect signal; real data is IID |
| **E7 — Normalized** | Score(combo \| prev) / P(combo) — remove base-rate advantage → isolate pure order effect | Top-1 **1.27%** (down from 12.55%) | Entire Markov score = **pure marginal frequency riding**; order contributes **0% gain** |

**Summary Metrics:**
- `markovGainVsUniform` = **5.55%** (from 6.25% to 12.55%) — but also because Marginal gains 6.47%
- `markovGainVsMarginal` = **−0.17%** (Markov thua) — **no temporal advantage**
- `shuffleDelta` = **−0.29%** (ordered worse) — order irrelevant
- `mutualInformation` = **0.0026 nats** — micro-scale, below detection threshold
- `meanKL` = **0.0081** — no divergence from marginal

**Verdict: `MARKOV_IS_ILLUSION`** ✓

> **Physical interpretation:** Sum=10 và sum=11 chiếm ~27/216 mỗi cái (12.5% each). Markov learns distribution ≈ [0, ..., 0, **0.125**, **0.125**, 0, ...] across 216 sums. Bất kỳ kỳ nào predict sum=10/11 cũng có ~12.5% hit rate. Markov không có "bộ nhớ"; nó chỉ học lại phân phối cơ bản. E7 proves: khi removal base-rate advantage, accuracy drops từ 12.55% → 1.27%. **Bingo18 là pure IID**, không có temporal memorystructure để khai thác.


## Logic dự đoán — Ensemble v9

### Tổng quan pipeline

```
Lịch sử N kỳ
    │
    ├─ Model A: Statistical z-score + S3–S6  ──► normalize [0,1] ─┐
    ├─ Model B: Markov order-2                ──► normalize [0,1] ─┼──► sigmoid(wA·sA + wB·sB + wC·sC + wD·sD + wE·sE + bias)
    ├─ Model C: Session (giờ ngày)            ──► normalize [0,1] ─┤         ↑ learned weights + L2 reg (dataset/model.json)
    ├─ Model D: k-NN Temporal ML             ──► normalize [0,1] ─┤         auto-disable D if wD < 0
    └─ Model E: Python GBM prior             ──► normalize [0,1] ─┘         (from python/ml_output.json)
                                                                    │
                                                      S2 Triple boost (chỉ khi hạn)
                                                                    │
                                                    Cooldown penalty (z < 0 → suppressed)
                                                                    │
                                              Portfolio selection (maximize coverage)
```

### Sigmoid ensemble (v9)

```
score = sigmoid(wA·sA + wB·sB + wC·sC + wD·sD + wE·sE + bias)
```

 Thực tế hiện tại (no_pattern):** shrink=0 → wA=wB=wD=0; **wC=0.05 + wE=0.15 active**.
> Session (25%) + GBM (75%) tạo phân phối có cấu trúc. GBM trained on 41698 records × 72 features.
> **Digit-position recency** (v11) penalty bổ sung giúp top-10 xoay mạnh mẽ hơn giữa các kỳ.
> Chỉ khi `pattern_detected` (≥2 test có p<0.05) thì A, B, D mới có trọng số thực sự.

- Trọng số học qua **walk-forward optimisation với L2 regularisation** (node scripts/train_weights.js)
- `objective = (top10_acc - baseline_random) - λ·(wA²+wB²+wC²+wD²+wE²)`, λ=0.01 để tránh học noise không beat nổi random
- Weights có thể **âm** → phạt model nhiễu; **Model D tự động bị disable khi wD < 0**
- Model E (GBM): dùng khi `python/ml_output.json` tồn tại và còn fresh (< 200 kỳ staleness)
- Fallback về fixed linear nếu `dataset/model.json` không tồn tại hoặc `improvesValid=false`
- **Direction 3+4 — Bayesian p-value shrink:**
  - `no_pattern` (0 test significant) → `shrink=0` → wA=wB=wD=**0** (kill hoàn toàn, không còn shrink nhẹ)
  - `weak/strong pattern` → `shrink ∝ min(p-values)`: ramp liên tục từ 0.5 (pMin→0.5) đến 1.0 (pMin→0.05)
  - `signal_confidence = max(0.5, (0.5 − pMin) / 0.45)` — không dùng discrete SHRINK_MAP nữa

**Kết quả học gần nhất** (`dataset/model.json`):

| | Fixed weights | Learned weights | Baseline random |
|---|---|---|---|
| Top-10 valid | 4.72% | **5.91%** | 4.63% |

> Metric chính là Top-10. Rank 1–3 được hiển thị kèm calibrated historical hit rate trong UI để tránh ảo giác tự tin.

**Learned weights** (`dataset/model.json`):
```json
{ "version": "v7", "wA": 0.38, "wB": 0.15, "wC": 0.05, "wD": 0.12, "wE": 0.15, "bias": -0.20, "lambda": 0.01 }
```
> wA=0.38 — z-score overdue, nhưng bị zeroed khi no_pattern (shrink=0).  
> wB=0.15 — Markov-2, cũng bị zeroed khi no_pattern.  
> wC=0.05 → session model, active dưới no_pattern (sess=25% effective).  
> wD=0.12 → k-NN, bị zeroed khi no_pattern.  
> wE=0.15 → **GBM active** (gbm=75% effective) — trained on 41698 records × 72 features.  
> **Dưới no_pattern: score = sigmoid(0.05·sC + 0.15·sE − 0.20)** → sess+GBM tạo phân phối có cấu trúc, không còn uniform.

### Re-train

```bash
# Re-run GBM trước (refresh ml_output.json)
source .venv/bin/activate && python python/ml_predictor.py

# Tối ưu ensemble weights (tự append vào dataset/weights_history.json)
node scripts/train_weights.js

# Đo accuracy thực (tự append vào dataset/backtest_history.json)
node backtest/run_backtest.js
```

Nên chạy lại sau mỗi ~200 kỳ mới. Server tự hot-reload `model.json` trong vòng 5 giây (fs.watchFile) — không cần restart. Nếu script tìm `improvesValid=false` → ensemble tự dùng fixed weights.

---

### MODEL D — k-NN Temporal Similarity (Gower Distance)

**Ý nghĩa:** Tìm k kỳ lịch sử có "bối cảnh" gần nhất, dự đoán combo dựa trên tần suất kết quả thực tế sau các bối cảnh đó.

```
Feature vector per context (dim = 5×WINDOW + 6):
  [sum/18, n1/6, n2/6, n3/6, pattern] × WINDOW(8)  ← lag features (5×8=40 dims)
  digit_frequency[1..6] / max_count                  ← global context (6 dims)

k = adaptive: max(15, 5% records), capped at 60

Distance metric: Gower distance (mixed-type aware)
  - Numerical features: normalised Manhattan |a−b| (sum/18, n1/6, n2/6, n3/6, digit freq)
  - Categorical features: Hamming 0/1 (pattern encoding — every 5th dim)
  - Final distance = mean across all dimensions

Score(combo) = Σ 1/(gowerDist+ε) for each neighbor that resulted in combo
```

**v10 Gower upgrade:** Euclidean distance xử lý pattern encoding (0/1) như continuous → sai lầm. Gower distance tách biệt categorical vs numerical → chính xác hơn cho mixed feature space.

**Khi nào active:** ≥ 24 kỳ lịch sử + wD ≥ 0 (auto-disable khi wD < 0 để giảm noise).  
**Feature cải thiện (v6):** Thêm digit frequency + pattern encoding vs v5 (chỉ có sum/n1/n2/n3).  
**Pure JavaScript:** Không cần Python, chạy trong production Docker.

---

### MODEL E — Python GBM Prior (offline → production)

Train 3 GBM classifier riêng biệt cho P(n1), P(n2), P(n3), rồi ghép thành P(combo):

```bash
# Setup lần đầu
python3 -m venv .venv && source .venv/bin/activate
pip install -r python/requirements.txt

# Chạy GBM predictor (xuất python/ml_output.json)
source .venv/bin/activate && python python/ml_predictor.py
```

Output `python/ml_output.json` được `ensemble.js` load tự động:
- **Active khi:** file tồn tại AND `|currentRecords - trainRecords| ≤ 2000`
- **Stale check:** nếu dataset tăng > 2000 kỳ → sE=0 (tự động vô hiệu)
- **Feature engineering (72 dims):** last-10 sum/n1/n2/n3/pattern lags + sin/cos giờ + sin/cos ngày trong tuần + vị trí kỳ trong ngày + sum lags (5) + digit counts + digit gaps
- **v11:** Retrained on 41698 records, +8 features (day_of_week cyclic, ky_in_day, explicit sum_lags)

---

### MODEL A — Statistical z-score

**Ý nghĩa:** Combo đang chờ lâu hơn trung bình lịch sử → tăng điểm.

```
gapList[combo] = danh sách các khoảng cách giữa các lần xuất hiện
curGap        = số kỳ kể từ lần xuất hiện cuối
z             = (curGap – avgGap) / stdGap    [≥2 gaps]
              = (curGap – avgGap) / avgGap    [1 gap, cap ±2]
              = 2.0                            [chưa từng xuất hiện]
baseScore     = max(0, min(4, z))              [chỉ boost khi quá hạn]
```

Augmented bởi 4 tín hiệu phụ — nhân AFTER baseScore:

| Signal | Mô tả | Tác động |
|--------|-------|----------|
| **S3** Sum deviation | Sum bucket thiếu so với kỳ vọng (window 200 kỳ) | +0–30% |
| **S4** Digit momentum | Digit đang "hot" trong 30 kỳ gần nhất | +0–15% |
| **S5** Sum overdue | Sum bucket quá hạn (kySinceLast/avgInterval > 1) | **+0–5%** |
| **S6** Pair-digit overdue | Cặp đôi VV quá hạn, áp cho combo pair/triple | **+0–5%** |

```
score_A = baseScore × (1 + s3_contrib + s4_contrib + max(s5, s6))
           ┓ ADDITIVE (v9 — was multiplicative, cầp max 1.50×)

# s3_contrib = sumDev × 0.30  (max 0.30)
# s4_contrib = avgHot × 0.15  (max 0.15)
# max(s5,s6)               (max 0.05, chỉ cái cao hơn)
```

> **v8 → v9:** S5+S6 trước nhân cộng đồng thời (combined ≤1.57×). Nay additive, tối đa 1.50×. Ngăn inflation phi tuyến khi nhiều tín hiệu cùng mạnh.

> **z=0 cho unseen combo (v9):** Combo chưa xuất hiện từ nay nhận z=0 thay vì z=2.0 cũ. z=2.0 là Gambler’s Fallacy. IID game không có bộ nhớ — unseen ≠ sap ra.

Ngoài ra Model A bị nhân thêm `sampleDecay = min(1, log(N)/log(5000))` để tránh quá tự tin khi dữ liệu còn ít.

---

### MODEL B — Markov order-2

**Ý nghĩa:** Dựa trên 2 kỳ liền trước, combo nào có xác suất transition cao nhất?

**Fallback chain + smoothing:**
```
1. key(kỳ[-2], kỳ[-1]) → Laplace smoothing
2. key(kỳ[-1]) → order-1
3. Fallback: uniform 1/216
```

Xác suất được tính bằng `(count + α) / (total + α×216)` với `α = 0.5` để tránh zero-probability ở context hiếm.

---

### MODEL C — Session theo giờ (15%)

```
Ca sáng:   6h–12h
Ca chiều: 12h–18h
Ca tối:   18h–6h

score[k] = count_in_session / (session_draws / 216)
```

**Tự động disable:** N < 5000 kỳ → hard-disable hoàn toàn (không phụ thuộc vào session size). Lý do: ~339 kỳ/ca → TB 1.57 lần/combo/ca → variance quá cao để có signal thực. wC=-0.10 (âm, nhiễu) là expected. Không còn để weight âm hoạt động ngầm khi dữ liệu chưa đủ.

---

### Triple signal (xxx)

Mỗi lần `/predict` trả về thêm `tripleSignal` — thống kê khả năng ra hoa bất kỳ:

```json
{
  "sinceLastTriple": 14,
  "expectedGap": 36,
  "avgGap": 33.1,
  "overdueRatio": 0.39,
  "boostMult": 1.0,
  "appeared": 31,
  "hotTriples": ["3-3-3", "5-5-5", "6-6-6"]
}
```

- `overdueRatio < 1` → LOW (chưa đến lúc)
- `1–2×` → MED — bắt đầu chú ý
- `> 2×` → HIGH — chỉ là điều kiện cần, không tự động được lên top
- Combo hoa chỉ hiện trong `hotTriples` khi **đã vào top-10 cuối cùng** và điểm cuối đủ mạnh

### Sum Prediction (`/predict-sum`)

Dự đoán giá trị tổng (3–18) thay vì combo — chỉ 16 outcomes thay vì 216. Với 43k draws, mỗi sum state có ~168 samples (vs ~200 cho mỗi combo) → Markov-1 transition matrix hội tụ tốt hơn.

**Pipeline:**
```
Lịch sử N kỳ
    │
    ├─ Z-score overdue: (curGap - avgGap) / stdGap  ──► 40% weight
    ├─ Markov-1: P(sum_next | sum_prev) × 16         ──► 40% weight  
    └─ Session frequency deficit                      ──► 20% weight
                                                        │
                                              rawScore = 0.4·zClamp + 0.4·mkNorm + 0.2·sessDeficit
                                                        │
                                              score = rawScore × sqrt(P(sum) / P_max)   ← v12 fix
```

**v12 Theoretical probability weight:** Sau khi tính rawScore, nhân với `sqrt(SUM_THEORETICAL[s] / MAX_THEO)`:
- sum=10/11 (27 ways, P=12.5%): weight = 1.0 (unchanged)
- sum=7/14  (15 ways, P=6.9%):  weight ≈ 0.75
- sum=3/18  (1 way,  P=0.46%): weight ≈ 0.19

Không có correction này, sum=3 đang quá hạn (z=2) sẽ outscore sum=10 vừa ra dù xác suất tuyệt đối của sum=10 cao hơn 27×.

**P0 Ablation results (N=41736, 352 test windows):**

| Model | Top-1 | Baseline | p-value | Verdict |
|-------|-------|----------|---------|---------|
| zscore-only   | 9.38%  | 6.25% | 0.015  | Significant (borderline) |
| markov-only   | 12.50% | 6.25% | ≈0     | **Highly significant** |
| session-only  | 8.24%  | 6.25% | 0.123  | Not significant |
| **full**      | **13.07%** | 6.25% | ≈0 | **Best overall** |
| Full top-5    | 53.69% | 31.25% | ≈0 | Markov dominates |

**Interpretation:** Markov-only top-1=12.5% = exactly P(sum=10) = P(sum=11) = 27/216. Cần kiểm tra xem Markov có real transition signal hay chỉ là artifact của base rate + theoWeight (predict sum=10/11 luôn đúng 12.5% thời gian). Session-only không significant → thời điểm trong ngày không ảnh hưởng đến sum pattern.

**P1 Hierarchical endpoint `/predict-hierarchical`:** Filter portfolio selection chỉ trong top-N sum buckets (default top-5). Khi sum prediction top-5 coverage đạt 53.69%, combo trong top-5 buckets gần 2× likely để chứa actual draw. GET `/predict-hierarchical?top=5`.

**Response format:**
```json
{
  "sums": [
    { "sum": 12, "score": 1.79, "z": 2.67, "curGap": 30, "avgGap": 8.6, "mkProb": 11.24, "theoretical": 11.57, "sessRatio": 0.92 },
    ...
  ],
  "prevSum": 8,
  "session": "evening",
  "mode": "active"
}
```

UI hiển thị top 5 sum predictions trong `SumPredPanel` — mỗi ô cho thấy z-score (overdue), Markov probability, và gap hiện tại vs trung bình.

### Confidence + calibration

Confidence server-side vẫn tính dựa trên khoảng cách score trong top-10:
```
confidence = 35 + ((score – minScore) / (maxScore – minScore)) × 45
```

**UI v10:** Không còn hiển thị confidence như % chính. Thay bằng **calibrated hit rate** từ `/stats.calBuckets`:
- Rank 1: `calBuckets[0].hitPct` — tỷ lệ trúng thực nghiệm qua walk-forward backtest
- Hiển thị dưới dạng `Lịch sử: x.xxx%` với thanh xanh lá
- Nếu chưa có backtest data → fall back về confidence từ server

Ý nghĩa: calibrated hit rate cho user biết **thực sự rank này đã trúng bao nhiêu lần** trong lịch sử — thay vì con số "80%" misleading từ score spread.

### Phân phối Sum

Tính đơn giản: đếm tần suất mỗi giá trị tổng (3–18) trên toàn bộ lịch sử:

```js
cnt[sum]++  // cho mỗi draw
pct[sum] = cnt[sum] / totalDraws × 100
```

Bingo18 có cấu trúc xác suất lý thuyết: Sum=10 và Sum=11 phổ biến nhất (27/216 = 12.5% mỗi loại). Dashboard hiển thị phân phối thực tế và so sánh với lý thuyết.

---

### Portfolio top-10 selection (Direction 1+2)

**Objective:** maximize P(hit ≥ 1) thay vì P(combo_i đúng).

Greedy slot-by-slot:
```
argmax_k [ score_k − λ × avgDigitOverlap(k, already_selected) ]
  λ = 0.10
  avgDigitOverlap = Jaccard similarity trên tập digit unique
```

Ví dụ: nếu đã chọn `1-2-3`, thì `1-2-4` bị phạt `λ × 0.67` (2 trong 3 digit giống).
Các combo không share digit nào (e.g. `4-5-6`) không bị phạt.

| Chế độ | Hành vi |
|--------|---------|
| `no_pattern` (shrink=0) | Scores gần như đồng đều → lựa chọn **pure diversity** → tối đa digit coverage |
| `pattern_detected` | Score spread lớn → high-score combos vẫn dẫn đầu, diversity penalty chỉ phân biệt ngang điểm |

Pattern cap giữ nguyên: max 2 triple, 4 pair, 4 normal. Pass 2 không giới hạn cap (fallback).

### Cooldown penalty (bug fix)

Sau khi tính ensemble score, nếu combo vừa xuất hiện gần đây hơn trung bình lịch sử:
```
z < 0 → score × exp(max(-3, z))

Ví dụ 6-6-6 vừa ra 3 kỳ trước, z = -1.53:
  penalty = exp(-1.53) ≈ 0.22 → score giảm 78%
```

Ngăn Markov/session override tín hiệu z-score = "combo không quá hạn".
Không còn trường hợp combo vừa ra tiếp tục được suggest ở top-10.

Không còn bypass ép combo quá hạn vào top-10. Ranking giờ thuần theo final score sau ensemble.

### Cache invalidation

Triple mechanism:
1. **Crawler push**: khi crawl phát hiện kỳ mới → `invalidateCache()` + SSE broadcast
2. **File watcher**: `fs.watchFile(history.json, interval=3s)` — tự clear cache khi file thay đổi từ bên ngoài (dedup, chỉnh tay…)
3. **TTL 5 phút**: safety net nếu cả 2 cơ chế trên miss

Semantics:
- **Không có kỳ mới**: giữ cache + ETag ổn định (client nhận 304, không re-render thừa)
- **Có kỳ mới**: clear toàn bộ cache in-memory, prewarm lại `/predict` + `/overdue`, client SSE reload `/predict` + `/history` + `/stats` + `/overdue`

### Badge ranking

**Diversity mode** (khi `verdict = no_pattern` → `_uniform = true`):

| Badge | Điều kiện | Màu |
|-------|-----------|-----|
| 🔴 Quá hạn | z-score > 2 | Đỏ |
| 🟡 Khá hạn | z-score > 1 | Vàng |
| 🟣 Hiếm | sessNorm < 0.1 (ít xuất hiện trong session) | Tím |
| ⚪ Đa dạng | Các trường hợp còn lại | Xám |

**Pattern mode** (khi `verdict = pattern_detected`):

| Badge | Rank | Màu |
|-------|------|-----|
| 🔥 HOT | Rank 1–3 | Cam đỏ |
| ⭐ STRONG | Rank 4–6 | Vàng |
| 👍 GOOD | Rank 7–8 | Cyan |
| OK | Rank 9–10 | Xám |

UI hiển thị **calibrated hit rate** từ `/stats.calBuckets` thay vì confidence score — cho phép user thấy tỷ lệ trúng thực nghiệm theo từng rank position.

---

## Crawler

### Crawler

```js
crawl()   // xoso.net.vn primary, xomo.com fallback nếu primary lỗi
```

Crawler tự chạy mỗi **12 giây** trong giờ mở thưởng (06:00–22:00 VN). Mỗi tick fetch **HTML và AJAX song song** (`Promise.all`) rồi merge unique records — đảm bảo luôn lấy ky mới nhất: HTML có kỳ mới ngay lập tức, AJAX là backup nếu HTML tạm thời stale. **StartupN/A recovery** crawl 5 trang khi boot. **Periodic deep recovery** phát hiện gap trong 30 ky gần nhất và crawl thêm 3 trang (max 1 lần/10 phút).

Data safety trong crawler:
- Chỉ ghi `history.json` khi có thay đổi thực sự (`added > 0` hoặc có bản ghi được back-fill `drawTime`)
- Ghi kiểu atomic (`history.json.tmp` → move)
- Luôn lưu snapshot `history.json.bak` để recovery nếu file chính bị corrupt
- Nếu file chính corrupt và backup cũng hỏng: crawler từ chối ghi đè để tránh wipe data

### Ghi chú: Bingo18 có lịch nghỉ

Bingo18 / Xổ số 36D **không quay số 24/7**. Có các khung giờ nghỉ (thường ~11:00–12:00 trưa và ban đêm). Trong thời gian nghỉ, source website (xoso.net.vn) cũng không publish kỳ mới — đây là hành vi bình thường, **không phải lỗi crawler**. Kiểm tra nhanh:

```bash
# Xem kỳ mới nhất trên source:
curl https://xs-bingo18.fly.dev/health | node -e "process.stdin|>JSON.parse" | grep lastDrawAt

# Trigger crawl thủ công:
curl -X POST https://xs-bingo18.fly.dev/crawl
```

### Trigger thủ công

```bash
curl -X POST https://xs-bingo18.fly.dev/crawl
# hoặc nhấn "⬇ Cập nhật" trên dashboard
```

---

## Walk-forward Backtest

Train trên `i-1` kỳ, dự đoán kỳ `i`, lấy mẫu 1/3 kỳ (SAMPLE_EVERY=3) để tránh block event loop:
- **Top-1**: combo #1 khớp kỳ thực tế
- **Top-3**: combo trong top 3
- **Top-10**: combo trong top 10
- **Random baseline**: 0.46% / 1.39% / 4.63%

**Performance (v10):** Backtest chạy background bất đồng bộ (setImmediate yielding) → health check và /predict không bị block. Kết quả lưu vào `dataset/stats_cache.json` (disk-persisted), load ngay khi restart — phản hồi `/stats` trong <1ms thay vì ~19s trước đây.

### Segmented accuracy (train / valid / forward)

Backtest chia 3 đoạn để phát hiện overfitting:

| Đoạn | Kỳ | Mục đích |
|------|-----|--------|
| **Train** | first 60% | Accuracy trên dữ liệu training |
| **Valid** | next 20% | Accuracy ngoài training (offline validation) |
| **Forward** | last 20% | Accuracy trên dữ liệu mới nhất (most realistic) |

Nếu **train >> forward**: model có thể overfit. Nếu cả 3 gần nhau: consistent.

---

## Reality Check — Statistical Tests

`/stats` trả về thêm `statTests` — kiểm tra xem dữ liệu có pattern thực sự hay gần random:

```json
{
  "statTests": {
    "chiSquare": { "stat": 234.5, "df": 215, "pValue": 0.18, "significant": false },
    "autocorr":  { "r": 0.023,   "z": 0.82,  "pValue": 0.41, "significant": false },
    "runs":      { "runs": 634,  "z": -0.5,  "pValue": 0.62, "significant": false },
    "verdict": "no_pattern"
  }
}
```

| Test | H0 | Ý nghĩa nếu p < 0.05 |
|------|-----|----------------------|
| **Chi-square** | Tần suất mỗi combo = 1/216 | Một số combo xuất hiện nhiều hơn kỳ vọng |
| **Autocorr** | Sum giữa các kỳ độc lập (r₁=0) | Kỳ trước tương quan với kỳ sau (chuỗi) |
| **Runs** | Chuỗi trên/dưới median ngẫu nhiên | Có hot/cold streak có ý nghĩa |

**Verdict**:
- `no_pattern` — 0 test significant → shrink=0 → wA=wB=wD=0; fallback về session+GBM+uniform+portfolio diversity
- `weak_pattern` — 1 test → shrink=max(0.5, (0.5−pMin)/0.45) (continuous, không discrete)
- `pattern_detected` — 2–3 test → shrink→1.0
- `weak_pattern` — 1 test → có thể là noise, cần thêm dữ liệu
- `pattern_detected` — 2-3 test → evidence cấu trúc thực sự

**Lưu ý quan trọng:**
- Significant ≠ predictable: Chi-square p < 0.05 chỉ nghĩa là tần suất không hoàn toàn phẳng, không có nghĩa là combo cụ thể có thể dự đoán
- wA = 0.46 (learned) có thể là noise; cần nhiều dữ liệu hơn để kết luận
- Model D (k-NN) bị kill (wD=0) là dấu hiệu không có local pattern

Dashboard hiển thị Reality Check trong tab Độ chính xác — toggle để xem p-value của từng test.

---

## SEO & AdSense

### Files

| File | URL | Mục đích |
|------|-----|---------|
| `web/ads.txt` | `/ads.txt` | AdSense publisher declaration — **bắt buộc** |
| `web/robots.txt` | `/robots.txt` | Cho phép crawl + trỏ sitemap |
| `web/sitemap.xml` | `/sitemap.xml` | 6 URLs, submit lên Search Console |

### Canonical URLs

Tất cả HTML pages dùng absolute canonical URL:
```html
<link rel="canonical" href="https://xs-bingo18.fly.dev/about" />
```

### Google Search Console

Sau deploy, submit sitemap tại:
```
https://search.google.com/search-console
→ Sitemaps → https://xs-bingo18.fly.dev/sitemap.xml
```

Chỉ Request Index riêng cho: `/`, `/about`, `/blog/what-is-bingo18`, `/blog/best-strategy-2026`.

### AdSense

Publisher ID được inject qua Fly secret:
```bash
fly secrets set ADSENSE_PUBLISHER_ID=ca-pub-2330743593269954
```

---

## Fly.io Deploy

```bash
fly deploy       # build Docker + rolling update
fly status       # xem machine state + health
fly logs         # stream logs realtime
```

### Config chính (`fly.toml`)

| Key | Giá trị |
|-----|---------|
| App | `xs-bingo18` |
| Region | `sin` (Singapore) |
| Internal port | `8080` |
| Volume | `bingo_data` → `/app/dataset` (persistent) |
| Auto-stop | `false` |
| Health check | `GET /health` mỗi 15s |

---

## Performance

| Cơ chế | Chi tiết |
|--------|---------|
| **In-memory cache** | `/predict`, `/overdue`: TTL 5 phút; invalidate khi có kỳ mới (crawler SSE + file watcher) |
| **SSE live reload** | Client giữ kết nối `/events`, tự reconnect sau 5s |
| **gzip** | `compression` middleware — SSE exempt |
| **React.memo** | `PredCard`, `SumBar`, `AccuracyPanel`, `OverdueTable`, `TripleSignalCard` |
| **Dual-source crawl** | `Promise.allSettled` — không crash nếu 1 nguồn down |

---

## Roadmap

| Feature | Status | Ghi chú |
|---------|--------|---------|
| Model A z-score | ✅ | Hoạt động |
| Model B Markov-2 | ✅ | Fallback ord-1 với ~1016 kỳ hiện tại |
| Model C Session | ✅ | Ca sáng / chiều / tối |
| Model D k-NN ML | ✅ | Pure-JS, improved features (digit freq + pattern) |
| Model E Python GBM | ✅ | ml_output.json → production ensemble, staleness guard |
| Auto-disable D khi wD < 0 | ✅ | Tự động kill noise model, không tốn compute |
| Sigmoid learned weights | ✅ | wA=0.46 wB=0.10 wC=-0.10 wD=0 wE=0 bias=-0.5 |
| L2 regularisation (λ=0.01) | ✅ | Tránh overfit, weights compact hơn |
| rankNorm (thay minMaxNorm) | ✅ | Stable normalization — không thay đổi theo N |
| Hot-reload model.json | ✅ | fs.watchFile 5s — không cần restart sau retrain |
| version trong model.json | ✅ | v6 — debug & tracking dễ hơn |
| weights_history.json | ✅ | Time-series log mỗi lần train |
| backtest_history.json | ✅ | Time-series accuracy log mỗi lần backtest |
| Dataset corruption guard | ✅ | Array.isArray check trong loadHistory() |
| Backtest dùng predict.ranked() | ✅ | Đo đúng pipeline production (portfolio + boost) |
| scripts/train_weights.js | ✅ | Walk-forward grid+descent+L2, tự lưu model.json |
| Python GBM predictor | ✅ | Offline tool, 64-feature GBM, xuất ml_output.json |
| 5 trang SEO content | ✅ | about, how-it-works, 2 blog, privacy |
| AdSense ads.txt | ✅ | pub-2330743593269954 |
| Sitemap + robots.txt | ✅ | Đã submit Search Console |
| /ml-status endpoint | ✅ | Xem trạng thái Model D + Python GBM |
| Backtest top-10 | ✅ | 5.07% vs baseline 4.63% (+9.5% relative, p≈0.51 — chưa ý nghĩa) |
| CI95 + p-value trên dashboard | ✅ | "Chưa ý nghĩa" khi p>0.05, tránh user hiểu nhầm |
| Model contribution % (UI) | ✅ | Hiển thị % đóng góp thực của từng model sau shrink |
| z=0 cho unseen combo (P1) | ✅ | V9 fix Gambler’s Fallacy (was z=2.0 prior) |
| S3–S6 additive (P2) | ✅ | Không còn multiplicative compounding; max 1.50× |
| Model C hard-disable N<5000 (P3) | ✅ | Không để weight âm hoạt động ngầm nữa |
| S5/S6 mutually exclusive (max +5%) | ✅ | Chỉ lấy max(s5,s6); trước là cộng đồng thời ≤+14.5% |
| Cooldown penalty (z < 0) | ✅ | score × exp(z) — fix h6 re-suggest; z=-1.5 → ×0.22 |
| Direction 3+4: Bayesian p-value shrink | ✅ | no_pattern→shrink=0 (kill A/B/D); pattern→continuous 0.5→1.0 |
| Direction 1+2: Portfolio selection | ✅ | argmax[score − λ×avgOverlap]; λ=0.10; maximize P(hit≥1) |
| anyTriple signal (xxx) | ✅ | Tín hiệu + thống kê hoa bất kỳ trên dashboard |
| TripleSignalCard UI | ✅ | LOW/MED/HIGH + hotTriples + boost multiplier |
| Confidence 35–80% | ✅ | Thay thế hardcap 75%; tính theo score spread top-10 |
| File watcher cache invalidation | ✅ | fs.watchFile 3s + SSE broadcast — backup cho crawler SSE |
| DrawPivotTable ngày × giờ | ✅ | Thay thế bảng lịch sử phẳng; highlight same sum/pair/triple |
| Crawler atomic write + backup | ✅ | Chống mất data khi file JSON corrupt/ghi dang dở |
| Statistical reality check | ✅ | Chi-square / autocorr / runs — p-value trên dashboard |
| Segmented backtest (train/valid/fwd) | ✅ | Phát hiện overfitting; 3 cột trên dashboard |
| Model C slot 6 phút | ⏳ | Cần ~7.200 kỳ (~30 ngày) |
| Markov-2 đầy đủ | ⏳ | Cần ~50.000 kỳ |
| wE > 0 (GBM active) | ⏳ | Cần ~5.000+ kỳ để GBM có signal đủ mạnh |
