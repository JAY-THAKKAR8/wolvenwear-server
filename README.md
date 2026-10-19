# wolvenwear-server — WOLVENWEAR API (Node + Express + TypeScript + PostgreSQL)

Backend shared by the two front-end projects: **wolvenwear-website** (customer storefront) and
**wolvenwear-admin** (Command Nexus admin panel).

```bash
docker compose up -d db       # local Postgres 16 (or use Neon / Supabase / any Postgres 14+)
cp .env.example .env          # DATABASE_URL, JWT_SECRET, CORS_ORIGINS, ADMIN_*
npm install
npm run db:reset              # create tables + seed catalogue, drops, 60 days of demo orders
npm run dev                   # http://localhost:4000/api/health
```

Scripts: `dev`, `build`, `start`, `db:migrate`, `db:seed`, `db:reset`, `typecheck`.

## How it connects the two apps

```
Website ──GET /api/public/bootstrap──▶ API ◀──JWT /api/admin/*── Admin panel
   ▲    ──POST /api/public/orders──▶    │  ──SSE /api/admin/stream──▶ live order terminal, notifications
   └────SSE /api/public/stream──────────┘   (theme / settings / catalogue changes pushed to open website tabs)
```

- Checkout: the server re-prices the bag (never trusts the client), locks and decrements stock, upserts the
  customer and pushes the order to the admin dashboard instantly.
- Admin changes to settings or the catalogue are broadcast to open website tabs.

## API

Public — `GET /api/public/bootstrap`, `GET /products`, `GET /products/:slug`, `GET /settings`, `POST /orders`,
`GET /orders/:id?phone=` (name/address only returned with the matching phone), `GET /stream` (SSE).

Admin (Bearer JWT, 7 days) — `POST /auth/login`, `GET /auth/me`, `POST /auth/password`, `GET /stream` (SSE),
`GET /dashboard`, `GET /analytics?days=`, `GET|POST /products`, `GET|PUT|DELETE /products/:id`,
`PATCH /products/:id/stock`, `POST /products/bulk`, `GET /orders`, `GET|PATCH /orders/:id`, `GET /customers`,
`GET|PATCH /customers/:id`, `GET|POST /drops`, `PUT|DELETE /drops/:id`, `GET|PUT /settings`, `GET|POST /team`.

Schema: `migrations/*.sql`. Products with order history are archived instead of deleted. Money is whole rupees.

## Deploying

Database on Neon / Supabase / Render (SSL is auto-enabled). API on Render / Railway / Fly: build `npm run build`,
start `npm start`, then run `npm run db:migrate && npm run db:seed` once. Set a long random `JWT_SECRET` and
`CORS_ORIGINS` = your website URL + admin URL. Change the seeded admin password after first login.
