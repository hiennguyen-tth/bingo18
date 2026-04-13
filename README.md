# Bingo18 AI Predictor

Hệ thống dự đoán Bingo18 dùng **3-model Ensemble v4** — normalize từng model về `[0, 1]` rồi cộng bình quân. Crawl dữ liệu song song từ 2 nguồn (xoso.net.vn + xsmn.net), phục vụ qua REST API + Dashboard React + 5 trang content SEO, deploy trên Fly.io.

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
│   ├── ensemble.js            # 3-model ensemble v4 (stat + markov + session)
│   ├── frequency.js           # Tần suất combo
│   ├── features.js            # Feature engineering
│   └── markov.js              # Markov chain model
├── backtest/
│   └── run_backtest.js        # Walk-forward backtest
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

## Logic dự đoán — Ensemble v4

### Tổng quan pipeline

```
Lịch sử N kỳ
    │
    ├─ Model A: Statistical z-score ──► normalize [0,1] ─┐
    ├─ Model B: Markov order-2       ──► normalize [0,1] ─┼─►  1/3 mỗi model
    └─ Model C: Session (giờ ngày)  ──► normalize [0,1] ─┘  (50/50 A+B nếu C thiếu data)
                                                            │
                                              S2 Triple boost (chỉ khi hạn)
                                                            │
                                              Diversity cap + top-10
```

---

### MODEL A — Statistical z-score (33.33%)

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

### MODEL B — Markov order-2 (33.33%)

**Ý nghĩa:** Dựa trên 2 kỳ liền trước, combo nào có xác suất transition cao nhất?

**Fallback chain:**
```
1. key(kỳ[-2], kỳ[-1]) → dùng nếu ≥ 5 observations
2. key(kỳ[-1]) → order-1
3. Fallback: uniform 1/216
```

Cần ~50.000 kỳ để Matrix order-2 đầy đủ. Hiện tại (~1210 kỳ) thường fallback về order-1.

---

### MODEL C — Session theo giờ (33.33%)

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
| Model B Markov-2 | ✅ | Fallback ord-1 với ~1210 kỳ hiện tại |
| Model C Session | ✅ | Ca sáng / chiều / tối |
| 5 trang SEO content | ✅ | about, how-it-works, 2 blog, privacy |
| AdSense ads.txt | ✅ | pub-2330743593269954 |
| Sitemap + robots.txt | ✅ | Đã submit Search Console |
| Model C slot 6 phút | ⏳ | Cần ~7.200 kỳ (~30 ngày) |
| Markov-2 đầy đủ | ⏳ | Cần ~50.000 kỳ |
