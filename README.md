# DukaanSathi Backend

REST API for **DukaanSathi**, a shop management app for Indian kirana / general stores:
stock, udhaar khata (customer credit ledger), suppliers & purchases, billing, reports, and a
Hindi/Hinglish voice-command parser.

Frontend: [DukaanSaathiFrontEnd](https://github.com/sameer-debug-ai/DukaanSaathiFrontEnd)

**Stack:** Node 20+ · Express · TypeScript (strict) · MongoDB + Mongoose · Zod · JWT
(access token + httpOnly refresh cookie) · Anthropic Claude SDK (optional) · Jest

## Run locally

```powershell
copy .env.example .env      # then edit values
npm install
npm run dev                 # http://localhost:4000/api
```

With an empty database the server seeds a **demo shop** (60 days of data).
Demo login: **9876543210 / demo123**. `npm run seed` recreates it (other shops are untouched).

| Script | Does |
| --- | --- |
| `npm run dev` | Start with auto-reload (tsx) |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run seed` | Recreate the demo shop |
| `npm test` | Jest unit + integration tests (uses an in-memory MongoDB) |

## Configuration (`.env`)

| Variable | Notes |
| --- | --- |
| `PORT` | Default `4000` |
| `MONGODB_URI` | e.g. `mongodb://127.0.0.1:27017/dukaansathi`, an Atlas URI, or `memory` (throwaway in-memory replica set) |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Long random strings |
| `ANTHROPIC_API_KEY` | Optional. Without it, voice commands use the built-in offline parser |
| `AI_MODEL` | Default `claude-haiku-5-5` |
| `STT_PROVIDER` | Speech-to-text fallback: `none` (default), `openai`, `groq` or `whisper` (self-hosted, Whisper-compatible) |
| `STT_API_KEY` | Key for the STT provider (not needed for a self-hosted `whisper` server) |
| `STT_BASE_URL`, `STT_MODEL` | Optional overrides of the provider's default URL / model |
| `CLIENT_URL` | Allowed CORS origin(s), comma separated |
| `REMINDER_CRON` | Daily reminder job (cron, Asia/Kolkata). Default `0 9 * * *`; empty turns it off |
| `AUTO_SEED` | `true` seeds the demo shop into an empty database |

### Transactions

Multi-collection writes (sale -> stock + udhaar, purchase -> stock + payable) use MongoDB
transactions, which need a **replica set**. A standalone `mongod` still works, but without
transactions (the server logs a warning). To convert the local Windows "MongoDB" service, run
once from an **Administrator** PowerShell in this repo:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\enable-mongo-replica.ps1
```

## Docker

```bash
cp .env.example .env
docker compose up --build      # MongoDB replica set + API on :4000
```

## API

All responses: `{ success, data, message, meta }`. Everything except `/auth/*` and `/health`
requires `Authorization: Bearer <token>` and is scoped to the logged-in shop.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /api/auth/register` `login` `refresh` `logout`, `PATCH /api/auth/change-password`, `GET/PATCH /api/auth/me` |
| Products | `GET/POST /api/products`, `GET/PATCH/DELETE /api/products/:id`, `GET /api/products/categories` `alerts` `export`, `POST /api/products/import` |
| Stock | `POST /api/stock/adjust`, `GET /api/stock/history/:productId` |
| Customers | `GET/POST /api/customers`, `GET/PATCH/DELETE /api/customers/:id`, `GET /api/customers/:id/ledger`, `POST /api/customers/:id/ledger/credit` `payment` |
| Suppliers | `GET/POST /api/suppliers`, `GET/PATCH/DELETE /api/suppliers/:id`, `GET /api/suppliers/:id/history` |
| Purchases | `GET/POST /api/purchases`, `GET /api/purchases/:id`, `GET/POST /api/supplier-payments` |
| Sales | `GET/POST /api/sales`, `GET /api/sales/:id` |
| Dashboard | `GET /api/dashboard/summary`, `GET /api/dashboard/charts?days=7` |
| Reports | `GET /api/reports/{sales,profit,udhaar,supplier-purchases,stock-valuation,product-sales}?from&to&format=json\|csv` |
| Voice | `POST /api/ai/parse-command` (rate limited), `POST /api/ai/transcribe` (audio, rate limited), `POST /api/ai/execute-batch`, `POST /api/ai/undo/:id` `undo-last`, `GET /api/ai/status`, `GET /api/voice-logs`, `PATCH /api/voice-logs/:id` |
| Settings | `GET /api/settings/backup`, `GET /api/settings/data-counts`, `POST /api/settings/sample-data` |
| Udhaar recovery | `GET /api/reminders/today`, `POST /api/customers/:id/reminder-sent`, `GET/POST/DELETE /api/customers/:id/share-link`, `GET /api/reports/aging` |
| Smart stock | `GET /api/stock/runout?days=7`, `GET /api/stock/reorder?days=15`, `GET /api/stock/expiry?days=7`, `GET /api/products/barcode/:code`, `GET /api/products/:id/batches` |
| Public (no login) | `GET /api/public/khata/:token` (rate limited) |

## Voice assistant

1. **Fast rules first.** Everyday sentences are parsed locally, with no AI call:
   - `Sharma ji 500 udhaar`
   - `Sharma ji ke 500 ka saman gaya`
   - `Gupta ji ne dhai sau diye`
   - `Ramesh traders ko 2000 diye`

   Hindi number words work in Roman or Devanagari script: ek, do, paanch sau, dedh sau, dhai hazaar, lakh.

   The fast path is used only when the whole sentence fits, the name is exactly one known customer or supplier, and there is one amount. Everything else goes to the AI.

   Each `VoiceCommandLog` records `parsePath`:
   - `rule`: the fast path
   - `ai`: the AI
   - `offline`: no AI key, or the AI failed
2. **Analytics questions** are answered by fixed, read-only, shop-scoped functions in `src/services/voiceAnalytics.service.ts`. The AI only picks one and its parameters, which are validated and clamped. It never writes a query.

   | Function | Example question |
   | --- | --- |
   | `top_products` | "Is mahine sabse zyada kya bika?" |
   | `inactive_debtors` | "Kaun 2 mahine se paisa nahi de raha?" |
   | `compare_sales` | "Aaj kal se kam bikri kyun hui?" |
   | `profit` | "Is hafte kitna munafa hua?" |
   | `top_debtors` | "Sabse zyada udhaar kiska hai?" |
3. **Speech-to-text fallback.** `POST /api/ai/transcribe?lang=hi|en` takes raw audio and returns `{ text }`:
   - Accepted body types: `audio/webm`, `audio/mp4`, `audio/ogg`, `audio/mpeg` and `audio/wav`.
   - Maximum size is 1 MB. The app stops recording at 30 seconds.
   - Rate limit: 10 requests per minute per shop.
   - Needs `STT_PROVIDER`. `GET /api/ai/status` reports `stt.available`.

## Udhaar recovery

- **UPI:** The shop's UPI ID and payee name are stored in `settings.upiId` and `settings.upiPayeeName`.
  - Links use the NPCI format: `upi://pay?pa=..&pn=..&am=..&cu=INR`. There is no `tn` note, because on a personal UPI ID it made banks decline QR payments with "duplicate RRN".
  - They appear in WhatsApp reminders, the statement PDF (with a QR code) and the public khata page.
- **Reminders:** Each customer has `reminderEveryDays` (0, 7, 15 or 30), a `dueDate` and `lastReminderAt`.
  - A `node-cron` job runs daily at 9 AM IST and builds a `DailyReminder` list for each shop.
  - `GET /reminders/today` refreshes that list on every view.
  - Sending a reminder from the app sets `lastReminderAt`.
- **Public khata link:** The token is 32 random bytes in base64url. Only its SHA-256 hash is stored in `KhataLink`.
  - Creating a new link revokes the old one, and the owner can also turn the link off.
  - Every failure returns the same 404, and the endpoint is rate limited to 30 requests per minute per IP.
  - The response contains no ids, settings or other customers' data.
- **Credit score:** The score runs from 0 to 100 and is worked out from the ledger. Payments are matched to the oldest udhaar first (FIFO). Points come from three parts:

  | Part | Points | How it scores |
  | --- | --- | --- |
  | Recovered (last 180 days) | 40 | Proportional to the share of udhaar paid back |
  | Average days to pay | 30 | Full at 15 days or less, zero at 90 days or more |
  | Age of the oldest unpaid udhaar | 30 | Full at 30 days or less, zero at 120 days or more |

  - Badges: **Good** at 70 or more, **Average** from 40 to 69, **Risky** below 40.
  - **New** means not enough history yet.
  - Voice udhaar for a customer who goes over their credit limit or is **Risky** carries a `creditWarning` and is never auto-saved.
- **Aging report:** `reports/aging` splits each customer's pending udhaar into 0-30, 31-60, 61-90 and 90+ day buckets, using FIFO.

## Smart stock

- **Run-out forecast** (`prediction.service.ts`):
  - Net units sold per IST day over the last 30 days come from `StockMovement` sales, minus undone bills.
  - Each day's weight halves every 10 days back, and days with no sales count as 0.
  - A product added recently is averaged over the days since it was added, with a minimum of 7 days.
  - `daysLeft = floor(stock / dailyRate)`; it is `null` when the product is not selling.
  - Product list, detail and barcode responses carry `forecast: { dailyRate, daysLeft }`.
  - The voice question "kya kya khatam hone wala hai" also lists items that will run out within 7 days.
- **Reorder list:**
  - Quantity is `dailyRate × N days − stock`, rounded up to whole packs, 0.5 kg/litre or 50 g/ml.
  - Items that stopped selling (often because they ran out) are refilled to twice their low-stock level when at or below it.
  - Items are grouped by the product's supplier. N comes from `settings.reorderDays` (default 15) or `?days=`.
- **Expiry batches (FEFO):** Products with `trackExpiry` keep `ProductBatch` documents.
  - `applyStockChange` keeps them in step for these products only. Stock added creates a batch, with the `expiryDate` from the purchase line if one was given.
  - Stock removed takes from the earliest-expiry batch first. Batches without an expiry are used last.
  - `stock/adjust` takes a `batchId` so a write-off removes that batch. Undoing a purchase removes that purchase's batches first.
  - Turning tracking on turns the current stock into one batch with no expiry. Turning it off deletes the batches.
  - Products without tracking are untouched.

## Notes

- Money is stored as integer paise (₹500 = 50000). "Today" uses Asia/Kolkata.
- Stock only changes through `StockMovement` records.
- A Mongoose tenant guard rejects any query on shop data that doesn't filter by `shopId`.
- Products, customers and suppliers are soft-deleted.
