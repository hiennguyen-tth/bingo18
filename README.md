# Bingo18 AI Predictor

Hệ thống dự đoán Bingo18 dùng **5-model Ensemble v6** — normalize từng model về `[0, 1]`, kết hợp qua **sigmoid với trọng số đã học (walk-forward + L2 regularisation)**. Crawl dữ liệu song song từ 2 nguồn (xoso.net.vn + xsmn.net), phục vụ qua REST API + Dashboard React + 5 trang content SEO, deploy trên Fly.io.

> **Production:** https://xs-bingo18.fly.dev

---

## Cấu trúc thư mục

```
bingo/
├── api/
│   └── server.js              # Express API + SSE live stream + in-memory cache
├── crawler/
│   ├── crawl.js               # Dual-source parallel crawler (xoso + xsmn)
│   └── realtime.js            # Standalone crawler loop (dùng local dev)
├── dataset/
│   └── history.json           # Dữ liệu đã crawl (persistent Fly volume)
├── predictor/
│   ├── ensemble.js            # 5-model ensemble v6 (sigmoid, learned weights, rankNorm)
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
node crawler/crawl.js          # crawl ~15 kỳ mới nhất từ xoso.net.vn
node crawler/crawl.js --all    # crawl toàn bộ lịch sử (60 trang × 15 ≈ 900 kỳ)

# Chạy server
node api/server.js             # dashboard → http://localhost:8080
```

---

## API Endpoints

| Method | Route | Mô tả |
|--------|-------|--------|
| GET | `/` | Dashboard React |
| GET | `/predict` | Top 10 combo + breakdown 3 model — **cached 5 phút** |
| GET | `/history?limit=500` | Lịch sử kỳ gần nhất |
| GET | `/overdue` | Thống kê quá hạn: bộ ba / cặp đôi / tổng — **cached** |
| GET | `/stats` | Walk-forward backtest accuracy — **cached** |
| GET | `/frequency` | Tần suất combo — **cached** |
| GET | `/events` | SSE stream — phát `new-draw` khi có kỳ mới |
| POST | `/crawl` | Crawl thủ công ngay lập tức |
| GET | `/health` | Liveness probe (historySize, lastDrawAt, sseClients) |
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

## Logic dự đoán — Ensemble v6

### Tổng quan pipeline

```
Lịch sử N kỳ
    │
    ├─ Model A: Statistical z-score  ──► normalize [0,1] ─┐
    ├─ Model B: Markov order-2        ──► normalize [0,1] ─┼──► sigmoid(wA·sA + wB·sB + wC·sC + wD·sD + wE·sE + bias)
    ├─ Model C: Session (giờ ngày)   ──► normalize [0,1] ─┤         ↑ learned weights + L2 reg (dataset/model.json)
    ├─ Model D: k-NN Temporal ML     ──► normalize [0,1] ─┤         auto-disable D if wD < 0
    └─ Model E: Python GBM prior     ──► normalize [0,1] ─┘         (from python/ml_output.json)
                                                             │
                                               S2 Triple boost (chỉ khi hạn)
                                                             │
                                               Diversity cap + top-10
```

### Sigmoid ensemble (v6)

```
score = sigmoid(wA·sA + wB·sB + wC·sC + wD·sD + wE·sE + bias)
```

- Trọng số học qua **walk-forward optimisation với L2 regularisation** (node scripts/train_weights.js)
- `objective = top10_acc - λ·(wA²+wB²+wC²+wD²+wE²)`, λ=0.01 để tránh overfit
- Weights có thể **âm** → phạt model nhiễu; **Model D tự động bị disable khi wD < 0**
- Model E (GBM): dùng khi `python/ml_output.json` tồn tại và còn fresh (< 200 kỳ staleness)
- Fallback về fixed linear nếu `dataset/model.json` không tồn tại hoặc `improvesValid=false`

**Kết quả hiện tại** (1016 kỳ, April 2026):

| | Fixed weights | Learned weights (v6) | Baseline random |
|---|---|---|---|
| Top-1 | — | 0.20% | 0.46% |
| Top-3 | — | 0.89% | 1.39% |
| Top-10 | 4.72% | **5.07%** | 4.63% |

> Top-10 +9.5% trên baseline. Top-1/3 thấp hơn random — bình thường với ~1016 kỳ (random game + diversity cap phân tán slots 1 và 3). Metric quan trọng nhất là Top-10.

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

**Ý nghĩa:** Combo đang xuất hiện ÍT hơn kỳ vọng (under-represented) → tăng điểm.

```
Window: 1000 kỳ gần nhất
expected = W / 216
z = (observed – expected) / sqrt(expected)   ← Poisson z-score
Score_A = –z × S3 × S4
```

**S3 — Sum deviation (window 200 kỳ):** boost +30% nếu sum vắng mặt hoàn toàn.  
**S4 — Digit momentum (window 30 kỳ):** boost +15% nếu các digit đang "hot".

---

### MODEL B — Markov order-2 (25%)

**Ý nghĩa:** Dựa trên 2 kỳ liền trước, combo nào có xác suất transition cao nhất?

**Fallback chain:**
```
1. key(kỳ[-2], kỳ[-1]) → dùng nếu ≥ 5 observations
2. key(kỳ[-1]) → order-1
3. Fallback: uniform 1/216
```

Cần ~50.000 kỳ để Matrix order-2 đầy đủ. Hiện tại (~1210 kỳ) thường fallback về order-1.

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

### Diversity cap + top-10 selection

```
Pass 0 — bypass: z < –2.5 → bắt buộc vào top 10 (tối đa 3 slot)
Pass 1 — full: max 2 triple, 4 pair, 4 normal; không quá 2 combo cùng digit
Pass 2 — relax digit-sharing
Pass 3 — no constraints
```

---

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

### Dual-source parallel

```js
Promise.allSettled([crawl(), crawlXsmn()])   // xoso.net.vn + xsmn.net
```

Hai nguồn chạy song song, `merge()` dedup theo `ky`. Crawl tự động mỗi **90 giây** bên trong `api/server.js`.

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
| **In-memory cache** | `/predict`, `/overdue`: TTL 5 phút; invalidate khi có kỳ mới |
| **SSE live reload** | Client giữ kết nối `/events`, tự reconnect sau 5s |
| **gzip** | `compression` middleware — SSE exempt |
| **React.memo** | `PredCard`, `SumBar`, `AccuracyPanel`, `OverdueTable` |
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
| Model C slot 6 phút | ⏳ | Cần ~7.200 kỳ (~30 ngày) |
| Markov-2 đầy đủ | ⏳ | Cần ~50.000 kỳ |
| wE > 0 (GBM active) | ⏳ | Cần ~5.000+ kỳ để GBM có signal đủ mạnh |
