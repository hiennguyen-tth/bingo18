# Bingo18 AI Predictor

Hệ thống dự đoán Bingo18 sử dụng **Ensemble Model** 7 tín hiệu: Combo Overdue + Sum Overdue + Pattern Overdue + Digit Coldness + Markov Chain + Stability Factor + Pre-Triple Signal, crawl dữ liệu thực từ xoso.net.vn, phục vụ qua REST API + Dashboard React.

---

## Cấu trúc thư mục

```
bingo/
├── api/
│   └── server.js          # Express API + SSE live stream + in-memory cache
├── crawler/
│   └── crawl.js           # Crawler xoso.net.vn, hỗ trợ crawl toàn bộ lịch sử
├── dataset/
│   └── history.json       # Dữ liệu đã crawl (~920+ kỳ)
├── predictor/
│   ├── ensemble.js        # 5-signal ensemble predictor (overdue + markov)
│   ├── frequency.js       # Tần suất combo
│   ├── markov.js          # Markov chain bậc 1
│   └── features.js        # Feature engineering (sum, pattern)
├── backtest/
│   └── walkForward.js     # Walk-forward backtest
├── web/
│   ├── index.html         # Dashboard entry point (ADSENSE_PUBLISHER_ID injected by server)
│   ├── app.jsx            # React 18 (Babel Standalone, không cần build)
│   └── heatmap.jsx        # Heatmap component
├── python/
│   └── train.py           # (Tùy chọn) XGBoost / sklearn model
├── .env                   # Local config (không commit — xem .env.example)
├── .env.example           # Template biến môi trường
├── test.js                # Unit tests (36 cases)
└── README.md
```

---

## Yêu cầu

- **Node.js 20+** (đã test trên v20.19.4)
- npm ≥ 10 (đi kèm Node 20)
- Kết nối internet (để crawl)

---

## Cài đặt và chạy local

### 1. Cài dependencies

```bash
cd bingo
nvm use          # tự chọn Node 20 theo file .nvmrc
npm install
```

> Nếu chưa có nvm: https://github.com/nvm-sh/nvm

### 2. Cấu hình môi trường

```bash
cp .env.example .env
# Chỉnh .env theo nhu cầu:
#   PORT=3000
#   ADSENSE_PUBLISHER_ID=ca-pub-XXXXXXXXXXXXXXXX
```

### 3. Crawl dữ liệu

**Crawl ~15 kỳ mới nhất:**
```bash
node crawler/crawl.js
```

**Crawl toàn bộ ~6 ngày (~920 kỳ):**
```bash
node crawler/crawl.js --all
```

Dữ liệu: `dataset/history.json`, tự động merge (không trùng lặp theo `id` + `ky`).

### 4. Khởi động API server

```bash
node api/server.js
```

Dashboard: **http://localhost:3000**

Server tự động crawl **30 giây sau mỗi phút mở thưởng** (`:00`, `:06`, `:12`, `:18`, `:24`, `:30`, `:36`, `:42`, `:48`, `:54`) và push SSE đến dashboard khi có kỳ mới.

---

## API Endpoints

| Method | Route | Mô tả |
|--------|-------|--------|
| GET | `/` | Dashboard HTML (ADSENSE_PUBLISHER_ID được inject server-side) |
| GET | `/predict` | Top 10 combo, % share, overdueRatio, comboGap — **cached** |
| GET | `/history?limit=500` | Lịch sử kỳ gần nhất (tối đa 500) |
| GET | `/overdue` | Thống kê quá hạn: bộ ba, cặp đôi, tổng — **cached** |
| GET | `/stats` | Walk-forward backtest: top1/top3/top10 accuracy — **cached 30 phút** |
| GET | `/frequency` | Tần suất xuất hiện combo — **cached** |
| GET | `/events` | SSE stream — phát `new-draw` khi có kỳ mới |
| POST | `/crawl` | Crawl thủ công ngay lập tức (từ nút "⬇ Tải mới") |
| GET | `/health` | Liveness probe |

---

## Logic dự đoán (7-signal Ensemble v2)

### Base overdueRatio (5 tín hiệu tuyến tính)

| Signal | Weight | Ý nghĩa |
|--------|--------|----------|
| C1 Combo Overdue | 0.30 | `min(comboGap, 2×216) / 216` — cap ở 2× để tránh never-seen dominate |
| C2 Sum Overdue | 0.25 | Tổng (3–18) nào quá hạn so với kỳ vọng |
| C3 Pattern Overdue | 0.20 | triple/pair/normal nào quá hạn |
| C4 Digit Coldness | 0.15 | Các số trong combo lâu chưa ra |
| C5 Markov Chain | 0.10 | `P(combo | combo_trước)` bậc 1 |

```
overdueRatio = C1×0.30 + C2×0.25 + C3×0.20 + C4×0.15 + C5×0.10
```

### 3 nhân tử nhân (multiplier signals)

**Signal 6 — Stability Factor**
```
stability = σ_gap / avgGap   (chuẩn hóa độ biến thiên lịch sử)
clip: [0.6, 3.0]
```
Combo có lịch sử xuất hiện đều đặn (stability thấp) → ổn định hơn combo ngẫu nhiên.

**Signal 7 — Pre-Triple Signal (tripleBoost)**
```
nếu 3 kỳ gần nhất KHÔNG có triple → ×1.15
nếu 3 kỳ gần nhất CÓ triple     → ×0.60
```
Phát hiện "nợ triple" trong chuỗi xúc xắc.

**PAT_WEIGHT** — hệ số loại pattern
```
triple: 1.5  |  pair: 1.0  |  normal: 0.7
```

### Raw score & diversity cap
```
logFactor = log(avgGap) / log(216)          -- chuẩn hóa theo không gian
momentum  = 0.7 nếu comboGap < 0.3×avgGap  -- phạt combo vừa mới ra
rawScore  = overdueRatio × PAT_WEIGHT × stability × logFactor × momentum × tripleBoost

pct = (rawScore_combo / tổng_rawScore_top10) × 100
```

**Top-10 diversity cap** — tránh top-10 bị độc chiếm:
- Tối đa 2 triple, 4 pair, 4 normal
- Tối đa 2 combo chia sẻ cùng 1 chữ số

### Badge ranking trong Dashboard

Score chuẩn hóa 0–100 (`normScore = rawScore / maxRawScore × 100`):

| Badge | Ngưỡng | Màu |
|-------|--------|-----|
| 🔥 HOT | ≥ 85 | Cam đỏ |
| ⭐ STRONG | 70–84 | Vàng |
| 👍 GOOD | 55–69 | Xanh dương |
| ⚠️ WEAK | 40–54 | Tím |
| ❄️ COLD | < 40 | Xám |

Confidence bar: `sigmoid(normScore) = 1 / (1 + e^{-0.05×(normScore-50)})`

---

## Crawler — lịch tự động

Bingo18 mở thưởng mỗi 6 phút. Server crawl **30 giây sau** mỗi phút mở thưởng:

```
:00:30  :06:30  :12:30  :18:30  :24:30
:30:30  :36:30  :42:30  :48:30  :54:30
```

Khi phát hiện kỳ mới → invalidate cache → broadcast SSE `new-draw` → dashboard tự reload.

Nút **"⬇ Tải mới"** trên dashboard gọi `POST /crawl` để crawl thủ công ngay lập tức.

---

## Performance

| Cơ chế | Chi tiết |
|--------|---------|
| **In-memory cache** | `/predict`, `/overdue`, `/frequency`: TTL 5 phút; `/stats`: 30 phút. Invalidate tự động khi crawl ra kỳ mới |
| **gzip compression** | `compression` middleware — tất cả response đều nén |
| **React.memo** | `PredCard`, `SumBar`, `PatTag`, `AccuracyPanel`, `OverdueTable` chỉ re-render khi props thay đổi |
| **History limit** | Fetch tối đa 500 kỳ (đủ hiển thị 444 ở index ~379) |

---

## Walk-forward Backtest

Với mỗi kỳ `i` (sau window ban đầu), train trên `i-1` kỳ quá khứ, dự đoán kỳ thứ `i`:
- **Top-1**: đúng nếu combo #1 khớp kỳ thực tế
- **Top-3**: combo trong top 3
- **Top-10**: combo trong top 10
- **Baseline ngẫu nhiên**: 1/216 ≈ 0.46% / 3/216 ≈ 1.39% / 10/216 ≈ 4.63%

---

## Thống kê quá hạn (Overdue)

Với mỗi bộ ba (111–666), cặp đôi (11–66), hoặc tổng (3–18):
```
overdueScore = kỳ_chưa_về ÷ TB_mỗi_kỳ
```
- `overdueScore > 1` → quá hạn
- `overdueScore > 2` → rất quá hạn (highlight đỏ)

TB mỗi kỳ hiển thị làm tròn số nguyên.

---

## AdSense

Để bật quảng cáo, thêm publisher ID vào `.env`:
```bash
ADSENSE_PUBLISHER_ID=ca-pub-1234567890123456
```
Server tự inject vào `<meta name="google-adsense-account">` trong HTML. Sau khi có domain, thêm script AdSense vào `web/index.html`.

---

## Deploy lên server (Oracle Cloud / VPS)

### Dùng PM2

```bash
npm install -g pm2
pm2 start api/server.js --name bingo-ai
pm2 save
pm2 startup
```

### Biến môi trường

| Biến | Mặc định | Mô tả |
|------|----------|--------|
| `PORT` | `3000` | Cổng server |
| `ADSENSE_PUBLISHER_ID` | _(trống)_ | Google AdSense publisher ID |

---

## Deploy Oracle Cloud (Ubuntu VPS)

### 1. Chuẩn bị VPS
- Cài Ubuntu 22.04 hoặc mới hơn
- Mở port 80, 443, 3000 trên firewall/cloud panel

### 2. Cài Node.js, git, pm2
```bash
sudo apt update && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g pm2
```

### 3. Clone code & cài đặt
```bash
cd ~
git clone <repo-url> bingo
cd bingo
nvm install 20  # nếu dùng nvm
nvm use 20
npm install
cp .env.example .env
# Sửa .env cho đúng (PORT, ADSENSE_PUBLISHER_ID...)
```

### 4. Crawl dữ liệu lần đầu
```bash
node crawler/crawl.js --all
```

### 5. Chạy server bằng PM2
```bash
pm2 start api/server.js --name bingo-ai
pm2 save
pm2 startup
```

### 6. Cấu hình domain/nginx (nếu cần)
- Cài nginx: `sudo apt install nginx`
- Cấu hình reverse proxy từ domain về `localhost:3000`
- Reload nginx: `sudo systemctl reload nginx`

### 7. Kiểm tra
- Truy cập `http://<ip-vps>:3000` hoặc domain đã cấu hình
- Dashboard sẽ realtime, auto reload mỗi 3 phút, live SSE khi có kỳ mới

---

## Deploy lên Vercel (preview tĩnh)

> ⚠️ **Lưu ý:** Vercel là serverless — SSE (`/events`) và crawler tự động **không hoạt động**. Dùng Vercel chỉ để preview UI tĩnh. Để có đầy đủ tính năng realtime, dùng Oracle Cloud / VPS bên dưới.

### Các bước

1. **Push code lên GitHub**
   ```bash
   git init && git add . && git commit -m "init"
   git remote add origin https://github.com/<user>/bingo.git
   git push -u origin main
   ```

2. **Import repo vào Vercel**
   - Vào https://vercel.com/new → Import Git Repository → chọn repo `bingo`

3. **Cấu hình project**
   - **Framework Preset:** Other
   - **Root Directory:** `.` (để trống)
   - **Build Command:** _(để trống — không cần build step)_
   - **Output Directory:** `web`

4. **Biến môi trường** (Settings → Environment Variables)
   ```
   PORT=3000
   ADSENSE_PUBLISHER_ID=ca-pub-XXXXXXXXXXXXXXXX
   ```

5. **Deploy** → Vercel sẽ serve `web/` làm static site.

### Giới hạn khi dùng Vercel

| Tính năng | Vercel (serverless) | Oracle Cloud / VPS |
|-----------|--------------------|-----------------|
| Dashboard UI | ✅ | ✅ |
| REST API (`/predict`, `/history`…) | ❌ (cần serverless adapter) | ✅ |
| SSE live reload (`/events`) | ❌ | ✅ |
| Crawler tự động | ❌ | ✅ |
| Thời gian request tối đa | 10s (hobby) | Không giới hạn |

**Khuyến nghị:** Dùng Oracle Cloud Always Free (VM.Standard.E2.1.Micro) + PM2 để có full tính năng.

---

## Chạy tests

```bash
node test.js
```

36 unit tests: frequency, Markov, ensemble, features, backtest.

---

## Kế hoạch nâng cấp & kiếm tiền

### Nên deploy ở đâu? (Kết luận nhanh)

| Nền tảng | Chi phí | SSE realtime | Crawler tự động | Khuyến nghị |
|----------|---------|-------------|----------------|-------------|
| **Oracle Cloud Always Free** | $0 mãi mãi | ✅ | ✅ | ✅ **Chọn cái này** |
| Render.com Free | $0 (sleep mỗi 15 phút) | ✅ khi thức | ❌ khi sleep | Chỉ demo |
| Railway Starter | $5/tháng | ✅ | ✅ | OK nếu muốn trả tiền |
| Fly.io Free | $0 (2 CPU, 256MB RAM) | ✅ | ✅ | Thay thế Oracle |
| Vercel | $0 | ❌ (serverless) | ❌ | Không phù hợp |

> **Dùng Oracle Cloud VM.Standard.E2.1.Micro (Always Free)** — đủ mạnh, 0 đồng mãi mãi, không reboot, full SSE + crawler.

---

### Roadmap & Monetization Plan

#### 🟢 Phase 1 — Deploy & AdSense (Tuần 1–2, $0 chi phí)

**Mục tiêu:** Ra mắt, thu traffic tự nhiên từ SEO.

- [ ] Deploy lên Oracle Cloud, cấu hình domain `bingo18.io.vn` (domain `.io.vn` ~80k/năm)
- [ ] Cài nginx reverse proxy + Let's Encrypt HTTPS (miễn phí)
- [ ] Đăng ký Google AdSense, khai tên miền
- [ ] Chia sẻ lên Facebook Groups: "Bingo 18", "Soi cầu xổ số 36D", "Cộng đồng Bingo"
- [ ] Submit sitemap Google Search Console

**Doanh thu kỳ vọng:** $0–5/tháng (cần tích lũy traffic trước)

---

#### 🔵 Phase 2 — Tăng traffic & Retention (Tháng 1–3)

**Mục tiêu:** 500–2000 lượt xem/ngày.

- [ ] **PWA** — thêm `manifest.json` + `service-worker.js` → nút "Thêm vào màn hình chính" trên mobile (tăng retention 3–5×)
- [ ] **Nút chia sẻ** — "Chia sẻ top 3 combo lên Facebook/Zalo" (viral loop)
- [ ] **Telegram Bot** — tự động gửi top 10 dự đoán sau mỗi kỳ tới channel (Telegram Bot API miễn phí)
- [ ] **Lịch sử dự đoán** — lưu lại "combo #1 dự đoán vs kết quả thực tế" để người dùng kiểm chứng (tăng trust)
- [ ] **Notification** — Web Push Notification khi có kỳ mới (Service Worker + VAPID, miễn phí)

**Doanh thu kỳ vọng:** $10–50/tháng từ AdSense

---

#### 🟡 Phase 3 — Premium Features (Tháng 3–6, doanh thu chính)

**Mục tiêu:** Monetize người dùng loyal.

- [ ] **Đăng ký tài khoản** — Google OAuth (miễn phí qua Firebase Auth)
- [ ] **Gói Premium** — $2–3/tháng, bao gồm:
  - Cảnh báo email/Telegram khi có combo HOT (🔥 normScore ≥ 85)
  - Xem lịch sử accuracy cá nhân ("bạn đã theo combo nào đúng")
  - Tải CSV lịch sử dự đoán
  - Ẩn quảng cáo
- [ ] **Tích hợp thanh toán** — Stripe hoặc MoMo (cho thị trường VN)
- [ ] **Affiliate banner** — Đặt banner liên kết tới các site tổng hợp kết quả xổ số (CPA $5–20/đăng ký)

**Doanh thu kỳ vọng:** 50 subscriber × $2.5 = **$125/tháng** + AdSense $30–80 = ~$150–200/tháng

---

#### 🟠 Phase 4 — Multi-Game & API (Tháng 6–12)

**Mục tiêu:** Mở rộng sản phẩm, tăng DAU.

- [ ] **Hỗ trợ thêm game** — Keno Vietlott, Power 6/45, Mega 6/45 (cùng model, khác dataset)
- [ ] **Mobile App** — Bọc web bằng Capacitor (iOS + Android) → đưa lên CH Play miễn phí
- [ ] **Public API tier** — Developer trả $10/tháng để dùng `/predict` raw JSON (RapidAPI marketplace)
- [ ] **Heatmap nâng cao** — Hiển thị chuỗi streak, hot zone theo giờ/ngày trong tuần

**Doanh thu kỳ vọng:** $300–800/tháng

---

#### 🔴 Phase 5 — Scale (Năm 2+)

- Mô hình ML nặng hơn (LSTM/Prophet) train offline, deploy prediction như file JSON
- White-label cho các admin group soi cầu lớn ($50–200/tháng/group)
- SEO content blog: "Kết quả Bingo18 hôm nay", "Thống kê Bingo18 tháng này" → traffic long-tail
- Doanh thu mục tiêu: **$1000–3000/tháng**

---

### Kỹ thuật cần thêm để monetize

| Tính năng | Công nghệ | Độ khó | Ưu tiên |
|-----------|-----------|--------|---------|
| HTTPS + domain | nginx + Let's Encrypt | Thấp | 🔴 Bắt buộc |
| PWA installable | manifest.json + SW | Thấp | 🟠 Cao |
| Telegram Bot | node-telegram-bot-api | Thấp | 🟠 Cao |
| Chia sẻ Facebook | Web Share API | Thấp | 🟡 Trung |
| Google OAuth | Firebase Auth | Trung | 🟡 Trung |
| Stripe payment | stripe-node | Trung | 🟡 Trung |
| Push Notification | VAPID + SW | Trung | 🟡 Trung |
| Capacitor mobile app | Capacitor | Trung | 🔵 Thấp |
| LSTM predictor | Python + TensorFlow | Cao | 🔵 Thấp |
