# CalSpread frontend

React 18 + TypeScript + Vite UI for the paired **Go / Chi / PostgreSQL** service
in [`../Cal_Spread_Backend`](../Cal_Spread_Backend/). Calendar spreads, broker
controls, stock/history charts, option analytics, Synthetic paper trading and
full-admin Fair Value are retained. The Box page, tab, controls and API calls are removed.

**Spike** at `/spike` adds continuous NIFTY/SENSEX minimum-straddle and VWAP
monitoring, separate 1m/5m/30m/1h plots, primary fourth-OTM one-lot paper spreads
and manual exit P&L. It requires no new environment variables. Rules and formulas
are documented in [the paired Spike guide](../Cal_Spread_Backend/docs/SPIKE.md).

## Fresh local setup

Use Node 22/npm for the frontend, Go 1.25.x and PostgreSQL 18 for the backend.
Start the local database and Go service following the backend README:

```bash
# From ../Cal_Spread_Backend:
make db-start
cp .env.example .env
# Fill KITE_API_KEY, KITE_API_SECRET, ADMIN_SECRET and ACCESS_SECRET.
make build
./outputs/calspread
```

Then, from this frontend repository:

```bash
cp .env.example .env
npm ci
npm run dev -- --host 127.0.0.1
```

Browse **http://127.0.0.1:5173**. `VITE_API_BASE_URL` is the backend origin
(`http://127.0.0.1:3001`), with no `/api` suffix. The backend's `FRONTEND_URL` must
match the browser origin for CORS/login redirects. Configure Kite's redirect to
`http://127.0.0.1:5173/zerodha/verify`. Dhan access tokens are fetched automatically
by the backend from the shared env_home service; no Dhan browser redirect is needed.
The backend applies embedded SQL migrations at startup. No MongoDB/Redis data import is needed.

Sign in at `/admin/verify` for full access or `/admin/access` for trade access,
then use the selected broker. In **Broker → Dhan**, automatic token status is shown
alongside **Fetch token now** and **Paste access token → Use token** for recovery.
The paste form is masked, clears after submission and never saves the access token
in browser storage. Configure the shared service in the backend `.env` as described
in its [configuration guide](../Cal_Spread_Backend/docs/CONFIGURATION.md#dhan-automatic-token-flow).
Roles, endpoint privileges and session behavior
are documented in [`ADMIN_SETUP.md`](ADMIN_SETUP.md). Fair Value is independently
disabled until its expiry policy/discount assumptions are configured; see the
backend [`Fair Value guide`](../Cal_Spread_Backend/docs/FAIR_VALUE.md).

## Verification

```bash
npm run build
npm test
TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' npm run test:go
```

`npm test` uses the locked TypeScript test loader and includes transport, role,
display/math and retained UI regressions. `test:go` builds the backend's
`cmd/verifyfixture` with the race detector and runs real Go HTTP workflows:
authorization, board/quotes/SSE, Calendar charges, Synthetic records/settings,
Fair Value models/workers/history/export/pause and CORS. A C compiler is needed
for race-enabled Go verification.

The fixture binds loopback on a free port, generates broker prices locally, uses
an isolated schema in the separate **test** database and removes that schema on
shutdown. It does not use the operator's `.env`, broker sessions or application data.
`CALSPREAD_BACKEND_DIR` may identify another local paired checkout.

### Actual browser workflows

Use locally installed Firefox and geckodriver; the runner uses standard WebDriver/BiDi
without an additional npm browser dependency:

```bash
TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' \
FIREFOX_BIN=/absolute/path/to/firefox GECKODRIVER_BIN=/absolute/path/to/geckodriver \
npm run test:browser
```

The default executables are `/usr/bin/firefox` and `geckodriver` on PATH. The check
runs the actual React page against the same real Go app: admin form, live board,
Calendar/Broker/Synthetic views, settings, independent refits, hypothetical
calculator, JSON download, history, pause/resume, mobile containment and
authorization revocation. Public/trade browsers must make zero valuation requests;
all browsers must make zero Box calls. Profiles, reports, downloads and screenshots
are retained under ignored `scratch/go-integration/`.

GitHub CI builds/tests locked frontend dependencies and runs real-Go HTTP verification
with the paired backend main and a PostgreSQL 18.0 service. Browser verification is local.

`npm run test:spike:browser` runs Spike's separate fresh-fixture browser workflow:
both index charts/timeframes, persisted paper control, real Dhan binary-feed signal
entries, manual exit P&L, mobile containment and public-page authorization. It uses
the same existing Firefox/geckodriver setup documented above.

The [Jev-assisted build review receipt](outputs/2026-11-04-spike-jev-review.json)
records the actual typed screenshot/rule judgments, confirmed fixes and token usage.
The [Spike publication receipt](outputs/2026-11-05-spike-publication.md) links both
verified feature commits, matching CI and the operator rollout action.

## Source and handoff

Routes live in `src/App.tsx`; shared market-data transport uses backend sessions/SSE.
Charts use SVG and the design tokens in `src/styles.css`. Shared historical CSS names
remain where Synthetic uses them. The migration handoff is
[`tasks/2026-10-27-go-postgres-migration/STATUS.md`](tasks/2026-10-27-go-postgres-migration/STATUS.md).
