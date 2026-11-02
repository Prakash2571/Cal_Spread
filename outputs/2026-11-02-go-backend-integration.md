# CalSpread frontend — verified Go integration

Date: 2026-11-02. Paired backend: `Prakash2571/Cal_Spread_Backend`.

- Box page/tab/API, Box-only controls/audio/components/tests removed.
- Shared record broker badge and Synthetic presentation/types preserved.
- Calendar, broker controls, stock/option analytics, Synthetic and Fair Value remain.
- Local setup/role documentation now targets Go/Chi/PostgreSQL.
- `test:go` and `test:browser` run against the actual Go app in an isolated local
  PostgreSQL schema; no Express/retired backend fixtures or new browser dependencies.
- CI builds/tests the frontend and checks the public paired backend main with PostgreSQL.

## Verified

From frontend root, all commands exited 0:

```bash
../Cal_Spread_Backend/scratch/go-migration/check.sh npm run build
../Cal_Spread_Backend/scratch/go-migration/check.sh npm test
../Cal_Spread_Backend/scratch/go-migration/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' npm run test:go
../Cal_Spread_Backend/scratch/go-migration/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' FIREFOX_BIN=/snap/firefox/current/usr/lib/firefox/firefox GECKODRIVER_BIN=/snap/firefox/current/usr/lib/firefox/geckodriver npm run test:browser
```

Results: **37 tests, zero skipped**, six real-Go HTTP groups, **12 Firefox 157.0
workflow groups**. JS bundle 356.20 kB (previously 496.16 kB).
Reports/screenshots/downloads: ignored `scratch/go-integration/browser-YQPNFa/`.

Browser checks exercise the real admin form, board prices, Broker/Calendar/Synthetic,
saved settings and original venue, independent refit, hypothetical calculator, JSON
download, PostgreSQL history, pause/resume and access revocation. Mobile viewport
390px / scrollWidth 378px. Public/trade browsers make zero valuation requests;
zero Box calls or uncaught JavaScript errors. A verified Synthetic stream's expected
Firefox navigation-cancellation message is recorded separately in the browser report.

The complete migration/reference/local-process review is recorded in the paired
backend's `outputs/2026-11-02-go-postgres-migration.md` and task STATUS.
Published frontend feature [`08f4707`](https://github.com/Prakash2571/Cal_Spread/commit/08f47070d0c7f93ecf72d406a4046bb9356f3823)
on main after backend runtime `0217698`. Both push commands exited 0 and both worktrees
matched origin/main. [Frontend CI 41418509911](https://github.com/Prakash2571/Cal_Spread/actions/runs/41418509911)
passed locked build/unit and real-Go/PostgreSQL integration; paired
[backend CI 41418473148](https://github.com/Prakash2571/Cal_Spread_Backend/actions/runs/41418473148) also passed.
Final receipt commits change documentation/completion state only; verified runtime source is unchanged.
