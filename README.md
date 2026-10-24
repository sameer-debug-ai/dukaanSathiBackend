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
| `CLIENT_URL` | Allowed CORS origin(s), comma separated |
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
| Voice | `POST /api/ai/parse-command` (rate limited), `GET /api/ai/status`, `GET /api/voice-logs`, `PATCH /api/voice-logs/:id` |
| Settings | `GET /api/settings/backup`, `GET /api/settings/data-counts`, `POST /api/settings/sample-data` |

## Notes

- Money is stored as integer paise (₹500 = 50000). "Today" uses Asia/Kolkata.
- Stock only changes through `StockMovement` records.
- A Mongoose tenant guard rejects any query on shop data that doesn't filter by `shopId`.
- Products, customers and suppliers are soft-deleted.
