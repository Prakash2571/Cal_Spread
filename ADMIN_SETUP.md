# Admin and broker setup

The frontend uses the paired Go/Chi/PostgreSQL backend. Start it and the local
PostgreSQL cluster using the backend README; set the browser/backend origins as
described in this repository's README.

## Local configuration

Backend `.env`:

```env
HOST=127.0.0.1
PORT=3001
FRONTEND_URL=http://127.0.0.1:5173
DATABASE_URL=postgres://calspread@127.0.0.1:55472/calspread?sslmode=disable
KITE_API_KEY=<your Kite app key>
KITE_API_SECRET=<your Kite app secret>
ADMIN_SECRET=<your full-admin login secret>
ACCESS_SECRET=<your trade-access login secret>
```

Frontend `.env`:

```env
VITE_API_BASE_URL=http://127.0.0.1:3001
```

Only the backend origin belongs in `VITE_API_BASE_URL`; secrets remain on the
server. Optional Dhan account and shared token-service settings are in the backend
`.env.example` and configuration guide.

## Role and broker sessions are separate

| Session | How to obtain | Capabilities |
|---|---|---|
| Full admin | `/admin/verify` → `POST /api/admin/verify` with `ADMIN_SECRET` | Broker connection/switch, risk-free rate, raw-token controls, Calendar and Synthetic, private Fair Value |
| Trade access | `/admin/access` → `POST /api/access/verify` with `ACCESS_SECRET` | Calendar trade management, Synthetic controls/paper close/history; no broker switch/token controls/Fair Value |
| Broker | Zerodha browser login; Dhan token fetched automatically or pasted by full admin | Active broker's market data; separate from the UI role |

Opaque admin/trade tokens contain 32 cryptographic random bytes (base64url), are
valid for 24 hours and are validated by the backend. PostgreSQL persists them for
restart restoration. The browser stores its role token under
`cal_spread_admin_token`; it does not store private valuation snapshots.
Synthetic deletion additionally requires the full role. Calendar endpoints keep
their existing admin/trade permissions and only delete closed records.

## Connect and switch brokers

1. Browse **http://127.0.0.1:5173/admin/verify** and sign in.
2. Use the Broker panel to select a configured broker.
3. Kite redirects to `/zerodha/verify`; the frontend forwards its request token
   to full-admin `POST /api/session`. Dhan tokens are fetched and saved by the backend
   from env_home after `AUTO_LOGIN_TIME` (08:30 IST by default), without a browser login.
   Its panel shows the token source, expiry, storage and automatic fetch response.
   Use **Fetch token now** to retry or **Paste access token → Use token** if the service
   fails. Pasting validates the configured account before changing its saved session.
4. Check the active broker, session, data-ready and feed state in the Broker panel.

Exactly one broker is active. Trade access inherits that broker. Switching resets
the market-data universe/generation and subscriptions while preserving historical
records and their original broker badges. Synthetic is paper-only. The Box feature
and all real order-placement transports have been removed.

Logout removes the browser's admin token and disconnects the active broker through
its normal logout API. Clearing browser storage alone does not revoke a persisted
role token; backend validation/expiry remains authoritative.
Clearing the Dhan token pauses automatic fetching for that IST day. A successful
manual paste is retained until expiry; an explicit fetch can replace it.

## Endpoint behavior

- Broker login/switch/logout, risk-free-rate writes and raw broker-token controls
  require full admin. Passcode/internal-token reads are separately configured
  and remain disabled when their secrets are blank.
- Calendar records and Synthetic operations require an admin/trade role;
  Synthetic deletion requires full admin.
- Read-only board/quotes/market-data SSE keep their existing backend contracts.
  They depend on an active broker session where applicable; frontend hiding of
  prices is not a new backend authorization guard.
- Browser tick SSE uses `POST /api/stream/session` and a short session-ID URL.
  Synthetic/Fair Value EventSource URLs carry the role token as a query parameter.

## Fair Value

`/fair-value` is full-admin-only. The UI guard mounts before its data component,
so public/trade browsers make zero valuation requests. Every backend
`/api/fair-value/*` route—including config, history, export and stream—also checks
full admin. Asynchronous responses/SSE revalidate access, and revocation clears
private rendered data.

Analytics is independently disabled by default. Configure a verified expiry-time
policy and a versioned discount curve/explicit flat-rate assumption before valuing
date-only contracts. See the backend [Fair Value guide](../Cal_Spread_Backend/docs/FAIR_VALUE.md).

## Troubleshooting

- **Admin authentication required:** check the configured server secret, sign in
  at the correct full/trade route, and check token expiry.
- **No prices after signing in:** connect the active broker separately and inspect
   its data-ready/feed state. A connected socket with no subscriptions is not LIVE.
- **Dhan token fetch failed:** check the Broker panel's service response and backend
  settings. Correct permanent-refusal settings and retry; use the paste-token fallback
  when the shared service is unavailable.
- **Wrong backend or CORS error:** match `VITE_API_BASE_URL` and `FRONTEND_URL`
  to the actual origins; use 127.0.0.1 consistently for the local OAuth flow.
- **Storage unavailable:** start local PostgreSQL and set `DATABASE_URL` before
  restarting the Go service. Persistence-dependent features show their existing
  unavailable state when no usable pool exists.

For generated local verification, run `npm run test:go` and `npm run test:browser`
with the separate local test database as described in README.
