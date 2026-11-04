# CalSpread frontend workflow

Follow `/home/prakash/Work/WORKFLOW.md`. Reuse React components and CSS tokens in
`src/`; routes are owned by `src/App.tsx`. Backend contracts come from
`../Cal_Spread_Backend`. Run `npm run build` and `npm test` for relevant changes.
The backend independently enforces authorization. Verify integration with `npm run test:go`
against local PostgreSQL and `npm run test:browser` with locally installed Firefox/geckodriver.
Do not deploy or arm trading.

Cross-repository task record: `../Cal_Spread_Backend/tasks/2026-11-04-spike-paper-straddles/`.
