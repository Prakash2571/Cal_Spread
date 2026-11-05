# Spike — publication receipt

Date: 2026-11-05 · Cross-repository task: `2026-11-04-spike-paper-straddles`

## Published features and CI

| Repository | Feature commit on main | Matching CI |
|---|---|---|
| Backend | [214576b](https://github.com/Prakash2571/Cal_Spread_Backend/commit/214576bfdc8ef0c565a01e9850d675a2e8e8fed8) | [41838824663 — success](https://github.com/Prakash2571/Cal_Spread_Backend/actions/runs/41838824663) |
| Frontend | [0020608](https://github.com/Prakash2571/Cal_Spread/commit/0020608012a178d1f27186998f08caac7fe61d7b) | [41839351873 — success](https://github.com/Prakash2571/Cal_Spread/actions/runs/41839351873) |

Backend published first so the frontend's real-Go integration checked the new
Spike API against backend main. Both normal fast-forward pushes succeeded. Both
`gh run watch` commands exited 0; fresh `gh run view` on 2026-11-05 confirmed the
exact feature heads with `status=completed`, `conclusion=success`.

## Delivered

`/spike` monitors NIFTY/SENSEX minimum CE+PE straddles continuously using the
backend's dedicated Dhan WebSocket lane. It provides separate premium/VWAP plots,
1m/5m/30m/1h views, exact rolling-30-minute 5% crossover qualification, primary
fourth-OTM one-lot paper spreads, persisted pause/resume and manual exit/gross P&L.
Existing broker/database configuration is reused.

- Backend `make check` and `make build`: passed, **34 tested packages** with required
  PostgreSQL/race tests plus build/vet/format/module checks.
- Frontend `npm run build` and `npm test`: passed, **37 tests**.
- `npm run test:go`: passed, **8 actual Go/PostgreSQL HTTP groups**.
- `npm run test:spike:browser`: passed, **6 workflows**, including both entries,
  manual P&L and all 20 desktop/12 mobile axis labels inside the SVG.
- `npm run test:browser`: passed, **14 existing workflows**, Firefox 157.0.
- Two live Jev calls: **14 typed Noul judgments** on `jev-1.14.0`, identifying and
  rechecking chart-label/rule-wording corrections. **16,295 input / 306 free output
  tokens**, estimated **US$0.000684390**, zero retries.

[Actual Jev results and budget receipt](2026-11-04-spike-jev-review.json) retain
returned probabilities, request hashes and local exact request/assets locations.
[Full implementation/verification report](https://github.com/Prakash2571/Cal_Spread_Backend/blob/main/outputs/2026-11-04-spike-paper-straddles.md)
records commands, meaningful cases and data boundaries.
[Strategy/configuration guide](https://github.com/Prakash2571/Cal_Spread_Backend/blob/main/docs/SPIKE.md)
documents all rules and formulas.

Local test/browser processes were shut down by their runners. The repository-owned
PostgreSQL was already stopped on resume; stop exited 0 and status confirmed
`no server running` (pg_ctl 3 / make 2). The last SQL inspection on 2026-11-04
found zero non-system test schemas. Data, tools and evidence were retained.

## Operator next action

On the configured VM, as `calspread` with both checkouts clean/on main:

```bash
/home/calspread/Cal_Spread_Backend/scripts/deploy.sh
```

Then open `https://calspread.online/spike` with full/trade access. The existing
deployment script pulls/builds both mains and applies the backend's embedded
migrations during service startup.
