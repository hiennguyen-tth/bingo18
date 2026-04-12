# Bingo18 AI Predictor

Hệ thống dự đoán Bingo18 dùng **3-model Ensemble v4** — normalize từng model về `[0, 1]` rồi cộng bình quân. Crawl dữ liệu song song từ 2 nguồn (xoso.net.vn + xsmn.net), phục vụ qua REST API + Dashboard React, deploy trên Fly.io.

> **Production:** https://xs-bingo18.fly.dev

---

## Cấu trúc thư mục

```
bingo/
├── api/
│   └── server.js          # Express API + SSE live stream + in-memory cache
├── crawler/
│   └── crawl.js           # Dual-source parallel crawler (xoso + xsmn)
├── dataset/
│   └── history.json       # Dữ liệu đã crawl (1000+ kỳ, lưu trên Fly volume)
├── predictor/
│   ├── ensemble.js        # 3-model ensemble v4 (stat + markov + session)
│   ├── frequency.js       # Tần suất combo
│   └── features.js        # Feature engineering (sum, pattern)
├── backtest/
│   └── walkForward.js     # Walk-forward backtest
├── web/
│   ├── index.html         # Dashboard entry point
│   ├── app.jsx            # React 18 (Babel Standalone, không cần build)
│   └── heatmap.jsx        # Digit frequency heatmap
├── fly.toml               # Fly.io config
├── Dockerfile             # node:20-alpine, port 8080
├── start.sh               # Diagnostic wrapper → node api/server.js
└── README.md
```

---

## Cài đặt local

```bash
cd bingo
npm install
cp .env.example .env      # chỉnh PORT, ADSENSE_PUBLISHER_ID nếu cần

node crawler/crawl.js     # crawl ~10 kỳ mới nhất
node api/server.js        # dashboard → http://localhost:3000
```

---

## API Endpoints

| Method | Route | Mô tả |
|--------|-------|--------|
| GET | `/` | Dashboard React |
| GET | `/predict` | Top 10 combo + breakdown 3 model — **cached 5 phút** |
| GET | `/history?limit=500` | Lịch sử kỳ gần nhất |
| GET | `/overdue` | Thống kê quá hạn: bộ ba / cặp đôi / tổng — **cached** |
| GET | `/stats` | Walk-forward backtest accuracy — **cached 30 phút** |
| GET | `/frequency` | Tần suất combo — **cached** |
| GET | `/events` | SSE stream — phát `new-draw` khi có kỳ mới |
| POST | `/crawl` | Crawl thủ công ngay lập tức |
| GET | `/health` | Liveness probe |

---

## Logic dự đoán — Ensemble v4

### Tổng quan pipeline

```
Lịch sử N kỳ
    │
    ├─ Model A: Statistical z-score ──► normalize [0,1] ─┐
    ├─ Model B: Markov order-2       ──► normalize [0,1] ─┼─►  1/3 mỗi model
    └─ Model C: Session (giờ trong ngày) ► normalize [0,1] ─┘  (50/50 A+B nếu C thiếu data)
                                                            │
                                              S2 Triple boost (chỉ khi hạn)
                                                            │
                                              Diversity cap + top-10
```

---

### MODEL A — Statistical z-score (33.33%)

**Ý nghĩa:** Combo nào đang xuất hiện ÍT hơn kỳ vọng (under-represented) → tăng điểm.

```
Window: 1000 kỳ gần nhất
expected = W / 216
z = (observed – expected) / sqrt(expected)   ← Poisson z-score

Score_A = –z × S3 × S4
```

Điểm cơ bản là `–z`: z âm (ít hơn kỳ vọng) → điểm cao. Khuếch đại bởi:

**S3 — Sum deviation (window 200 kỳ)**
```
dev[s] = max(0, expected_s – actual_s) / expected_s   ∈ [0, 1]
S3 = 1 + dev[sum] × 0.30     → boost tối đa +30% nếu sum hoàn toàn vắng mặt
```

**S4 — Digit momentum (window 30 kỳ)**
```
hot[d] = max(0, count[d] – expected) / expected
S4 = 1 + avgHot × 0.15        → boost tối đa +15% nếu các digit đều đang hot
```

> **Cần bao nhiêu data:** Window 1000 kỳ → expected ≈ 4.6 lần/combo. Với 1000 kỳ, tín hiệu z-score đủ ổn định.

---

### MODEL B — Markov order-2 (33.33%)

**Ý nghĩa:** Dựa trên 2 kỳ liền trước, combo nào có xác suất transition cao nhất?

**Fallback chain — không bao giờ crash:**
```
1. Thử key (kỳ[-2], kỳ[-1]) → dùng nếu ≥ 5 observations
2. Thử key (kỳ[-1]) → order-1, dùng nếu có transition nào
3. Fallback: uniform 1/216
```

> **Cần bao nhiêu data:** Order-2 cần mỗi state xuất hiện ≥ 5 lần. Với 216² = 46.656 states, thực tế thường fallback về order-1 với 1000 kỳ hiện có. Sẽ cải thiện khi đủ ~50.000 kỳ.

---

### MODEL C — Session theo giờ (33.33%)

**Ý nghĩa:** Trong ca ngày hiện tại, combo nào xuất hiện nhiều hơn kỳ vọng?

```
Ca sáng:   6h–12h
Ca chiều: 12h–18h
Ca tối:   18h–6h

score[k] = count_in_session / (session_draws / 216)   ← ratio, 1.0 = đúng kỳ vọng
```

**Tự động disable:** Nếu session hiện tại có < 20 kỳ → weight Model C = 0, redistrib về **50% A + 50% B** (không crash, không bias).

> **Cần bao nhiêu data:** ~7.200 kỳ (~30 ngày) để mỗi slot 6-phút có ≥ 30 mẫu. Hiện tại (~1000 kỳ) Model C hoạt động ở cấp ca ngày (sáng/chiều/tối), không phải slot 6 phút.

---

### Normalization

```js
normalize(scoreMap) = (x – min) / (max – min)   cho tất cả 216 combo
// Nếu tất cả combo có cùng điểm → 0.5 (signal đều, trung tính)
```

Mỗi model có đơn vị khác nhau (z-score, probability, ratio) → **bắt buộc normalize trước khi kết hợp**.

---

### S2 — Triple streak boost (sau ensemble)

Áp dụng **sau** khi kết hợp 3 model, chỉ cho triple combos:

```
EXPECTED_GAP = 36 kỳ   (1/36 ≈ 2.78% xác suất triple mỗi kỳ)
ratio = sinceTriple / 36

ratio ≤ 1.0  → boost = 1.0  (bình thường, không khuếch đại)
ratio = 1.5  → boost ≈ 1.25×
ratio ≥ 2.0  → boost = 1.5× (tối đa)
```

> **Lý do chỉnh lại:** Formula cũ `(210/216)^N` bắt đầu boost ngay từ kỳ đầu (1.65× sau chỉ 14 kỳ — dưới kỳ vọng thông thường), gây ra tình trạng 2 triple luôn chiếm top 1–2 ngay cả khi không có dấu hiệu gì bất thường. Formula mới chỉ boost khi thật sự có "hạn" (vượt quá khoảng cách kỳ vọng).

---

### Diversity cap + top-10 selection

```
Pass 0 — bypass: combo có z < –2.5 (thiếu nghiêm trọng) → bắt buộc vào top 10 (tối đa 3 slot)
Pass 1 — full constraints: max 2 triple, 4 pair, 4 normal; không quá 2 combo cùng chữ số
Pass 2 — relax digit-sharing, giữ pattern cap
Pass 3 — no constraints (fill nốt)
```

---

### Confidence cap 75%

`pct` (% share trong top-10) bị cap cứng ở **75%** trên server.js:
```js
pct = Math.min(75, (score / totalScore) * 100)
```
Confidence bar trong UI dùng sigmoid chuẩn hóa, cũng cap tại 75% — tránh người dùng hiểu nhầm là xác suất thắng cao.

---

### Badge ranking

`normScore = score / maxScore × 100` (trong top-10):

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

Hai nguồn chạy song song, `merge()` dedup theo `ky` → không mất kỳ nếu một nguồn down. Crawl tự động mỗi **90 giây**.

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

## Thống kê quá hạn (Overdue)

```
overdueScore = kỳ_chưa_về / TB_mỗi_kỳ
> 1 → quá hạn  |  > 2 → rất quá hạn (highlight đỏ)
```

---

## Fly.io Deploy

```bash
fly deploy       # build + push Docker image + rolling update
fly status       # xem machine state
fly logs         # stream logs realtime
```

### Config chính (`fly.toml`)

| Key | Giá trị |
|-----|---------|
| App | `xs-bingo18` |
| Region | `sin` (Singapore) |
| Internal port | `8080` |
| Memory | `1 GB` |
| Volume | `bingo_data` → `/app/dataset` (1 GB persistent) |
| Auto-stop | `false` |
| Restart | `always`, max 10 retries |

### Fly Secrets

```bash
fly secrets set ADSENSE_PUBLISHER_ID=ca-pub-XXXXXXXXXXXXXXXX
```

---

## Performance

| Cơ chế | Chi tiết |
|--------|---------|
| **In-memory cache** | `/predict`, `/overdue`: TTL 5 phút; `/stats`: 30 phút. Invalidate khi crawl ra kỳ mới |
| **SSE live reload** | Client giữ kết nối `/events`, tự reconnect sau 5s nếu mất |
| **gzip** | `compression` middleware — tất cả response đều nén |
| **React.memo** | `PredCard`, `SumBar`, `AccuracyPanel`, `OverdueTable` chỉ re-render khi props thay đổi |
| **Dual-source crawl** | `Promise.allSettled` — không crash nếu 1 nguồn down |

---

## Roadmap

| Feature | Status | Ghi chú |
|---------|--------|---------|
| Model A z-score | ✅ | Cần ~500 kỳ để ổn định |
| Model B Markov-2 | ✅ | Thực tế fallback ord-1 với 1000 kỳ |
| Model C Session (sáng/chiều/tối) | ✅ Active | Đủ data |
| Model C Slot 6 phút (240 slots) | ⏳ Cần ~7.200 kỳ | ~30 ngày crawl thêm |
| Markov-2 đầy đủ (không fallback) | ⏳ Cần ~50.000 kỳ | Dài hạn |
| Expose model weights qua Fly secrets | 💡 Idea | Tune không cần redeploy |
