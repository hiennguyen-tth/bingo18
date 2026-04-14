# Bingo18 AI Predictor

Hệ thống dự đoán Bingo18 dùng **5-model Ensemble v8** — normalize từng model về `[0, 1]`, kết hợp qua **sigmoid với trọng số đã học (walk-forward + L2 regularisation)**. Model A được bổ sung 4 tín hiệu phụ (S3–S6), Model B dùng Laplace smoothing, và ensemble có **reality-aware shrink** khi dữ liệu trông gần random. Crawler dùng **xoso.net.vn** làm primary và **xomo.com** làm fallback, phục vụ qua REST API + Dashboard React, deploy trên Fly.io.

Kể từ logic mới nhất, `/stats` bổ sung **Reality Check** (chi-square, autocorr, runs), chia 3 segment (train/valid/forward), và trả thêm **calibrated hit rate theo từng rank**. Triple signal chỉ còn là lớp thông tin hỗ trợ; top-10 không còn ép combo hoa lên đầu bằng bypass.

> **Production:** https://xs-bingo18.fly.dev

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
│   ├── ensemble.js            # 5-model ensemble v8 (sigmoid, learned weights, rankNorm)
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
├── fly.toml                   # Fly.io config
├── Dockerfile                 # node:20-alpine, port 8080
├── start.sh                   # Diagnostic wrapper → node api/server.js
└── README.md
```

---

## Cài đặt local

```bash
cd bingo
npm install

# Crawl dữ liệu ban đầu
node crawler/crawl.js          # crawl ~15 kỳ mới nhất từ xoso.net.vn (fallback xomo.com nếu lỗi)
node crawler/crawl.js --all    # crawl toàn bộ lịch sử (60 trang × 15 ≈ 900 kỳ)

# Chạy server
node api/server.js             # dashboard → http://localhost:8080
```

---

## API Endpoints

| Method | Route | Mô tả |
|--------|-------|--------|
| GET | `/` | Dashboard React |
| GET | `/predict` | Top 10 combo + breakdown model + `tripleSignal` đã được AI xác nhận — **cached 5 phút** |
| GET | `/history?limit=500` | Lịch sử kỳ gần nhất |
| GET | `/overdue` | Thống kê quá hạn: bộ ba / `anyTriple` / cặp đôi / tổng — **cached** |
| GET | `/stats` | Walk-forward backtest + Reality Check + Train/Valid/Forward + calibrated rank buckets — **cached** |
| GET | `/frequency` | Tần suất combo — **cached** |
| GET | `/events` | SSE stream — phát `new-draw` khi có kỳ mới |
| POST | `/crawl` | Crawl thủ công ngay lập tức |
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

---

## Logic dự đoán — Ensemble v8

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
                                              Diversity cap + top-10 selection
```

### Sigmoid ensemble (v8)

```
score = sigmoid(wA·sA + wB·sB + wC·sC + wD·sD + wE·sE + bias)
```

- Trọng số học qua **walk-forward optimisation với L2 regularisation** (node scripts/train_weights.js)
- `objective = (top10_acc - baseline_random) - λ·(wA²+wB²+wC²+wD²+wE²)`, λ=0.01 để tránh học noise không beat nổi random
- Weights có thể **âm** → phạt model nhiễu; **Model D tự động bị disable khi wD < 0**
- Model E (GBM): dùng khi `python/ml_output.json` tồn tại và còn fresh (< 200 kỳ staleness)
- Fallback về fixed linear nếu `dataset/model.json` không tồn tại hoặc `improvesValid=false`
- Khi `Reality Check = no_pattern`, weights của A/B/D bị shrink để tránh overconfidence

**Kết quả học gần nhất** (`dataset/model.json`):

| | Fixed weights | Learned weights | Baseline random |
|---|---|---|---|
| Top-10 valid | 4.72% | **5.91%** | 4.63% |

> Metric chính là Top-10. Rank 1–3 được hiển thị kèm calibrated historical hit rate trong UI để tránh ảo giác tự tin.

**Learned weights** (`dataset/model.json`):
```json
{ "version": "v6", "wA": 0.46, "wB": 0.10, "wC": -0.10, "wD": 0.00, "wE": 0.00, "bias": -0.50, "lambda": 0.01 }
```
> wC âm → session model hơi nhiễu ở dataset hiện tại.  
> wD=0 → k-NN auto-disabled (wD không âm nhưng =0 trong grid).  
> wE=0 → GBM chưa có signal (cần ~5000+ kỳ).  
> L2 regularisation giữ weights compact, tránh overfit.

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
| **S5** Sum overdue | Sum bucket quá hạn (kySinceLast/avgInterval > 1) | +0–7% |
| **S6** Pair-digit overdue | Cặp đôi VV quá hạn, áp cho combo pair/triple | +0–7% |

```
score_A = baseScore × s3 × s4 × s5 × s6
```

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

**Tự động disable:** session < 20 kỳ → weight = 0, redistrib về 50% A + 50% B.

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

### Diversity cap + top-10 selection

```
Pass 1 — full: max 2 triple, 4 pair, 4 normal; không quá 2 combo cùng digit
Pass 2 — relax digit-sharing, giữ pattern cap
Pass 3 — no constraints
```

Không còn bypass ép combo quá hạn vào top-10. Ranking giờ thuần theo final score sau ensemble.

### Cache invalidation

Triple mechanism:
1. **Crawler push**: khi crawl phát hiện kỳ mới → `invalidateCache()` + SSE broadcast
2. **File watcher**: `fs.watchFile(history.json, interval=3s)` — tự clear cache khi file thay đổi từ bên ngoài (dedup, chỉnh tay…)
3. **TTL 5 phút**: safety net nếu cả 2 cơ chế trên miss

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

Crawler tự chạy mỗi **60 giây** trong giờ mở thưởng. `crawl.js` dùng timeout ngắn + no-cache headers + fallback source để giảm lag nhưng vẫn giữ rate-limit lịch sự.

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

Train trên `i-1` kỳ, dự đoán kỳ `i`:
- **Top-1**: combo #1 khớp kỳ thực tế
- **Top-3**: combo trong top 3
- **Top-10**: combo trong top 10
- **Random baseline**: 0.46% / 1.39% / 4.63%

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
- `no_pattern` — 0 test significant → game consistent với IID random → model A/B/D fit noise
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
| Backtest dùng predict.ranked() | ✅ | Đo đúng pipeline production (diversity cap + boost) |
| scripts/train_weights.js | ✅ | Walk-forward grid+descent+L2, tự lưu model.json |
| Python GBM predictor | ✅ | Offline tool, 64-feature GBM, xuất ml_output.json |
| 5 trang SEO content | ✅ | about, how-it-works, 2 blog, privacy |
| AdSense ads.txt | ✅ | pub-2330743593269954 |
| Sitemap + robots.txt | ✅ | Đã submit Search Console |
| /ml-status endpoint | ✅ | Xem trạng thái Model D + Python GBM |
| Backtest top-10 | ✅ | 5.07% vs baseline 4.63% (+9.5%) |
| S5 sum overdue boost | ✅ | +0–25% cho combo có sum quá hạn |
| S6 pair-digit overdue boost | ✅ | +0–20% cho pair/triple khi cặp digit đó quá hạn |
| anyTriple signal (xxx) | ✅ | Tín hiệu + thống kê hoa bất kỳ trên dashboard |
| TripleSignalCard UI | ✅ | LOW/MED/HIGH + hotTriples + boost multiplier |
| Confidence 35–80% | ✅ | Thay thế hardcap 75%; tính theo score spread top-10 |
| File watcher cache invalidation | ✅ | fs.watchFile 3s + SSE broadcast — backup cho crawler SSE |
| Statistical reality check | ✅ | Chi-square / autocorr / runs — p-value trên dashboard |
| Segmented backtest (train/valid/fwd) | ✅ | Phát hiện overfitting; 3 cột trên dashboard |
| Model C slot 6 phút | ⏳ | Cần ~7.200 kỳ (~30 ngày) |
| Markov-2 đầy đủ | ⏳ | Cần ~50.000 kỳ |
| wE > 0 (GBM active) | ⏳ | Cần ~5.000+ kỳ để GBM có signal đủ mạnh |
