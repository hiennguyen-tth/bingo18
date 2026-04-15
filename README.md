# Bingo18 AI Predictor

Hệ thống dự đoán Bingo18 dùng **5-model Ensemble v9** — normalize từng model về `[0, 1]`, kết hợp qua **sigmoid với trọng số đã học (walk-forward + L2 regularisation)**. Model A được bổ sung 4 tín hiệu phụ (S3–S6 với S5/S6 loại trừ nhau), Model B dùng Laplace smoothing, và ensemble dùng **Bayesian p-value shrink**: khi `no_pattern` → wA=wB=wD=0 (kill hoàn toàn); khi có pattern → shrink liên tục theo confidence. Top-10 dùng **portfolio selection** (maximize P(hit ≥ 1)). Crawler dùng **xoso.net.vn** làm primary và **xomo.com** làm fallback, phục vụ qua REST API + Dashboard React, deploy trên Fly.io.

Kể từ logic mới nhất, `/stats` bổ sung **Reality Check** (chi-square, autocorr, runs), chia 3 segment (train/valid/forward), và trả thêm **calibrated hit rate theo từng rank**. Triple signal chỉ còn là lớp thông tin hỗ trợ; top-10 không còn ép combo hoa lên đầu bằng bypass. **Cooldown penalty** ngăn combo vừa xuất hiện tiếp tục được suggest (fix h6 re-suggest bug).

UI lịch sử đã chuyển từ bảng phẳng 500 kỳ sang **pivot theo ngày × khung giờ** (lấy tối đa 1000 kỳ gần nhất): highlight khác màu cho `same sum`, `đôi`, `hoa`, và `same pair/triple` giữa các ngày sát nhau ở cùng time slot.

**Dataset (Apr 2025 update):** 43,000+ kỳ lịch sử từ 2025-07-06 import từ Excel (`scripts/import_excel.py`). Tổng dữ liệu huấn luyện tăng 28× giúp model có sample size lớn hơn đáng kể.

> **Production:** https://xs-bingo18.fly.dev

---

## ⚠️ Giới hạn thống kê — Đọc trước khi dùng

Đây là những sự thật cần nhìn thẳng trước khi diễn giải bất kỳ kết quả nào:

| Thực tế | Chi tiết |
|---------|----------|
| **p-value = 0.51** | Top-10 đạt 5.07% vs random 4.63% (+9.5% relative) — nhưng **chưa có ý nghĩa thống kê**. Khả năng cao đây là variance, không phải edge. Cần thêm nhiều kỳ để kết luận. |
| **Reality check = no_pattern** | Chi-square p=0.18, autocorr p=0.41, runs p=0.62 → cả 3 test đều không reject H0. Data gần như IID random. **Giới hạn vật lý, không phải do code.** |
| **Effective pipeline = 1 model** | `wA=0.46, wB=0.10, wC=–0.10 (disabled), wD=0, wE=0` → khi `no_pattern`, shrink=0 khiến wA=wB=wD=0. Score tất cả combo gần bằng nhau → lựa chọn thực chất là **portfolio diversity thuần túy**, không phải AI prediction. |
| **Bản chất IID** | Bingo18 / 36D có 216 outcomes. Không có bộ nhớ giữa các kỳ (như đã xác nhận bởi autocorr). Về lý thuyết, không có edge dài hạn có thể khai thác. |

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
│   └── dedup.js               # Dataset deduplication
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
| History corruption risk | `readJSON().catch(()=>[])` có thể ghi đè mất dữ liệu | `loadHistorySafe()` + backup `.bak` + atomic write `.tmp→move` |

**Pre-warm mechanism:** `invalidateCache()` clears the in-memory cache and immediately calls `_prewarmCaches()` (takes ~50ms) so the next HTTP request always hits a warm cache. The stats backtest is debounced 3.5s to collapse the crawl-write and the file-watcher detection into a single compute.

---

## Cài đặt local

```bash
cd bingo
npm install

# Crawl dữ liệu ban đầu
node crawler/crawl.js          # crawl ~15 kỳ mới nhất từ xoso.net.vn (fallback xomo.com nếu lỗi)
node crawler/crawl.js --all    # crawl toàn bộ lịch sử (60 trang × 15 ≈ 900 kỳ)

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
| GET | `/predict` | Top 10 combo + breakdown model + `tripleSignal` đã được AI xác nhận — **cached 5 phút** |
| GET | `/history?limit=1000` | Feed lịch sử cho pivot table ngày × giờ |
| GET | `/overdue` | Thống kê quá hạn: bộ ba / `anyTriple` / cặp đôi / tổng — **cached** |
| GET | `/stats` | Walk-forward backtest + Reality Check + Train/Valid/Forward + calibrated rank buckets — **disk-persisted, stale-while-revalidate** |
| GET | `/frequency` | Tần suất combo — **cached** |
| GET | `/events` | SSE stream — phát `new-draw` khi có kỳ mới |
| POST | `/crawl` | Crawl thủ công ngay lập tức |
| POST | `/admin/recover-history` | Emergency restore dữ liệu lịch sử (token-gated, disabled nếu thiếu `RECOVERY_TOKEN`) |
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
- Hàng: khung giờ mở thưởng (HH:MM)
- Mỗi ô hiển thị `n1 n2 n3` + `sum`
- Highlight theo rule:
  - `same sum` với ngày kề bên: nền đỏ nhạt
  - `đôi`: nền xanh/cyan
  - `hoa (triple)`: nền vàng
  - `same pair` hoặc `same triple` với ngày kề bên: highlight đậm hơn

Footer có tổng kết theo ngày: số lần ra `HOA`, `Đôi`, `Thường`.

---

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

> **Thực tế hiện tại (no_pattern):** shrink=0 → wA=wB=wD=0; wC disabled (N<5000); wE=0.
> Rút gọn: `score ≈ sigmoid(bias) = const ≈ 0.378` cho **tất cả** combo.
> → Lựa chọn top-10 hoàn toàn do **portfolio diversity** (digit overlap penalty), không phải model score.
> Chỉ khi `pattern_detected` (cần ≥2 test có p<0.05) thì A và B mới có trọng số thực sự.

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
{ "version": "v6", "wA": 0.46, "wB": 0.10, "wC": -0.10, "wD": 0.00, "wE": 0.00, "bias": -0.50, "lambda": 0.01 }
```
> wA=0.46 — có chút signal hoặc noise fit; không thể kết luận vì p=0.51.  
> wB=0.10 — Markov rất yếu; cần ~50.000 kỳ để transition matrix có ý nghĩa.  
> wC=–0.10 (âm) → disabled hoàn toàn khi N<5000 — session model là nhiễu.  
> wD=0 → k-NN auto-disabled — không có local pattern để học.  
> wE=0 → GBM chưa có signal (cần ~5000+ kỳ).  
> **Dưới no_pattern, ensemble thực chất là: `score ≈ sigmoid(–0.50) ≈ 0.378` (hằng số) → uniform.**

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

### MODEL D — k-NN Temporal Similarity

**Ý nghĩa:** Tìm k kỳ lịch sử có "bối cảnh" gần nhất, dự đoán combo dựa trên tần suất kết quả thực tế sau các bối cảnh đó.

```
Feature vector per context (dim = 5×WINDOW + 6):
  [sum/18, n1/6, n2/6, n3/6, pattern] × WINDOW(8)  ← lag features (5×8=40 dims)
  digit_frequency[1..6] / max_count                  ← global context (6 dims)

k = adaptive: max(15, 5% records), capped at 60
Score(combo) = Σ 1/(dist+ε) for each neighbor that resulted in combo
```

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
- **Active khi:** file tồn tại AND `|currentRecords - trainRecords| ≤ 200`
- **Stale check:** nếu dataset tăng > 200 kỳ → sE=0 (tự động vô hiệu)
- **Feature engineering (64 dims):** last-10 sum/n1/n2/n3/pattern lags + sin/cos giờ + digit counts + digit gaps

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

### Confidence + calibration

Không dùng giá trị cứng 75%. Confidence được tính dựa trên khoảng cách score thực trong top-10:

```
confidence = 35 + ((score – minScore) / (maxScore – minScore)) × 45
```

→ Rank 1: ~80%, Rank 10: ~35%. Đây là confidence tương đối theo score spread.

UI hiển thị thêm `lịch sử: x.xxx%` từ `/stats.calBuckets` — đó mới là hit rate thực nghiệm theo từng rank position.

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

| Badge | normScore | Màu |
|-------|-----------|-----|
| 🔥 HOT | ≥ 85 | Cam đỏ |
| ⭐ STRONG | 70–84 | Vàng |
| 👍 GOOD | 55–69 | Cyan |
| ⚠️ WEAK | 40–54 | Tím |
| ❄️ COLD | < 40 | Xám |

---

## Crawler

### Crawler

```js
crawl()   // xoso.net.vn primary, xomo.com fallback nếu primary lỗi
```

Crawler tự chạy mỗi **30 giây** trong giờ mở thưởng. `crawl.js` dùng timeout ngắn + no-cache headers + fallback source để giảm lag nhưng vẫn giữ rate-limit lịch sự.

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
