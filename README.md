# Bingo18 AI Predictor

Hệ thống dự đoán Bingo18 sử dụng **Ensemble Model** 5 tín hiệu: Combo Overdue + Sum Overdue + Pattern Overdue + Digit Coldness + Markov Chain, crawl dữ liệu thực từ xoso.net.vn, phục vụ qua REST API + Dashboard React.

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

## Logic dự đoán (5-signal Ensemble)

### 1. Combo Overdue (35%)
```
C1 = kỳ_chưa_về / kỳ_kỳ_vọng_combo  =  comboGap / (N / 216)
```
Combo nào lâu chưa xuất hiện so với chu kỳ kỳ vọng → score cao hơn.

### 2. Sum Overdue (25%)
```
C2 = kỳ_chưa_về_tổng / kỳ_kỳ_vọng_tổng
```
Tổng (3–18) nào quá hạn → ưu tiên combo có tổng đó.

### 3. Pattern Overdue (15%)
```
C3 = kỳ_chưa_về_pattern / kỳ_kỳ_vọng_pattern
```
Pattern (triple/pair/normal) nào quá hạn → ưu tiên combo thuộc pattern đó.

### 4. Digit Coldness (15%)
```
C4 = trung_bình(kỳ_chưa_về của n1, n2, n3)
```
Combo chứa các số lâu chưa ra → score cao hơn.

### 5. Markov Chain bậc 1 (10%)
```
C5 = P(combo | combo_trước)
```
Xác suất chuyển trạng thái dựa trên lịch sử liền kề.

### Ensemble score
```
score = C1×0.35 + C2×0.25 + C3×0.15 + C4×0.15 + C5×0.10
pct   = (score_combo / tổng_score_top10) × 100
```

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

## Chạy tests

```bash
node test.js
```

36 unit tests: frequency, Markov, ensemble, features, backtest.
