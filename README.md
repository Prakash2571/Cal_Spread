# CalSpread frontend

React 18 + TypeScript + Vite UI for CalSpread. The paired Express service is in
`../Cal_Spread_Backend`. Configure the backend origin in `.env.example`, run
`npm ci`, then `npm run dev`. `npm run build` checks types and builds the UI.

Authentication and the full/trade role split are described in `ADMIN_SETUP.md`.
Routes live in `src/App.tsx`; market-data transport uses the shared backend feeds.
Charts use SVG and the design tokens in `src/styles.css`.

The full-admin-only Fair Value implementation is tracked in
`tasks/2026-10-03-fair-value/`; its mathematical/configuration guide lives in the
paired backend's `docs/FAIR_VALUE.md`.

`npm test` uses the locked TypeScript dependency through a test-only Node loader,
including on Node builds without built-in type stripping. Browser integration:
`PLAYWRIGHT_BROWSERS_PATH=scratch/browsers node scripts/fair_value_browser_test.mjs`
with locally installed scratch Playwright/Chromium. It runs fixture market data
against the real Fair Value API/workers; no broker login is required.
