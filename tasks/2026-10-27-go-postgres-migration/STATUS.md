# CalSpread frontend Go migration integration status

State: Done
Updated: 2026-11-02
Blockers: none
Next action: None. Verified frontend integration and main publication are complete; local usage/verification instructions are in README.md.

## Completed

- Read project rules, current task records, npm manifest, and initial API contracts.
- `git status --short && git log -5 --oneline`: exit 0; clean, HEAD `4600d90`.
- User approved project-local installation of missing frontend build dependencies.
- 2026-11-02: reconciled the stale implementation blocker with the paired backend's verified Go service and completed
  retained-suite audit. Backend verification in this session: full build/vet, clean gofmt output and all 29 tested Go
  packages green with `REQUIRE_DB_TESTS=1` and `-race`. Backend audit accounts for 332 retained cases (250 already covered,
  78 completed/strengthened, 4 explained N/A). This was the pre-integration milestone; the integration stage is now verified below.

## Publication — 2026-11-02

- Runtime/frontend feature [`08f4707`](https://github.com/Prakash2571/Cal_Spread/commit/08f47070d0c7f93ecf72d406a4046bb9356f3823)
  committed and pushed to main after paired backend runtime `0217698`.
- `git push origin main && git status --short --branch && git rev-parse HEAD`: exit 0; clean, matched origin/main.
- `gh run watch 41418509911 --interval 10 --exit-status` and
  `gh run view 41418509911 --json headSha,status,conclusion,url,jobs`: exit 0;
  [CI 41418509911](https://github.com/Prakash2571/Cal_Spread/actions/runs/41418509911) completed **success**.
  Locked build/unit and actual Go/PostgreSQL integration passed against the published backend main.
- Backend [CI 41418473148](https://github.com/Prakash2571/Cal_Spread_Backend/actions/runs/41418473148) also succeeded.
  Completion/receipt updates are documentation-only; verified runtime source stays unchanged.

## Current checks (2026-11-02 final migration continuation)
- `../Cal_Spread_Backend/scratch/go-migration/check.sh npm run build && ../Cal_Spread_Backend/scratch/go-migration/check.sh npm test && git diff --check`: exit 0; final bundle 356.20 kB, 37 tests, zero skipped and clean whitespace.
- `../Cal_Spread_Backend/scratch/go-migration/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' npm run test:go`: exit 0; six real-Go HTTP/PostgreSQL workflow groups (auth, providers, session SSE, Calendar/Synthetic records/settings, Fair Value/CORS/history/export, Box 404/loopback).
- `../Cal_Spread_Backend/scratch/go-migration/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' FIREFOX_BIN=/snap/firefox/current/usr/lib/firefox/firefox GECKODRIVER_BIN=/snap/firefox/current/usr/lib/firefox/geckodriver npm run test:browser`: exit 0; Firefox 157.0, 12 actual React/Go/PostgreSQL groups including native admin form, board, broker, Calendar, Synthetic save/history, independent refit, hypothetical calculator, JSON download, history, pause/resume, mobile and revocation. Public/trade browsers made zero valuation requests; zero Box calls/JavaScript exceptions/remote upstream calls.
- Browser evidence: ignored `scratch/go-integration/browser-YQPNFa/report.json`, desktop/mobile and Synthetic screenshots; mobile innerWidth 390 / scrollWidth 378. One Firefox CORS/null-status cancellation message followed navigation from the Synthetic EventSource; successful stream open and actual snapshot were separately verified, so it is recorded as cancellation rather than an uncaught page exception.
- Browser harness intermediate failures were corrected: existing number/label formatting and disabled-busy control timing; fixture interval/source timestamps now obey the retained validator; startup errors fail immediately instead of minting tokens on retry. Final runners use the actual Go app/authorization/workers, not Express stubs or retired source.
- README, ADMIN_SETUP and WORKFLOW now document local Go/PostgreSQL setup and actual role/endpoint permissions. CI checks the public paired backend main with PostgreSQL and runs `test:go`; both repositories confirmed public. `actionlint` is unavailable locally (not run).
- Box page, Trades-panel Box tab, Box API/type exports, controls, audio hooks/helpers and Box-only tests removed. Shared broker badge extracted to `src/BrokerBadge.tsx`, order-side type renamed, PostgreSQL storage messages updated and Synthetic's options-feed capacity labels corrected.
- Final `../Cal_Spread_Backend/scratch/go-migration/check.sh npm run build`: exit 0; bundle JS 356.20 kB (baseline 496.16 kB).
- Final `../Cal_Spread_Backend/scratch/go-migration/check.sh npm test && git diff --check`: exit 0; 37 tests passed, 0 skipped; whitespace check clean.
- Intermediate checks found a remaining unused Box audio hook (removed), and two test-only assertions that accidentally matched SVG `viewBox` or expected fixed decimal padding where the existing money formatter is compact. Corrected; the final net-summary assertion verifies +₹120 after ₹30 charges.
- `../Cal_Spread_Backend/scratch/go-migration/check.sh npm run build`: exit 0 on the unchanged frontend baseline.
- `../Cal_Spread_Backend/scratch/go-migration/check.sh npm test`: exit 0, 52 tests passed, 0 skipped on the baseline.
- `git fetch origin main`: exit 0; main still at `4600d90` before migration edits. Existing dependencies are present; no installation needed.

## Coordination

2026-11-02: the user explicitly requested complete migration/deep review and pushes to main; EC2 deployment and data
import are out of scope. Activate the frontend and backend stages sequentially to stay within the workspace's two-Doing limit.

Authoritative migration status:
`../Cal_Spread_Backend/tasks/2026-10-27-go-postgres-migration/STATUS.md`.
