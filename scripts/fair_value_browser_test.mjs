/** Local browser integration of actual React page + actual Fair Value routes/workers.
 * Broker data is deterministic fixture data; never credentials/live trading.
 * Requires project-local scratch Playwright/Chromium approved for verification.
 */
import assert from 'node:assert/strict';
import express from '../../Cal_Spread_Backend/node_modules/express/index.js';
import { chromium } from '../scratch/node_modules/playwright/index.mjs';
import { createServer as createViteServer } from '../node_modules/vite/dist/node/index.js';
import { FairValueEngine } from '../../Cal_Spread_Backend/dist/fairValue/engine.js';
import { registerFairValueRoutes } from '../../Cal_Spread_Backend/dist/fairValue/routes.js';
import { inputSnapshot, memoryStore, NOW } from '../../Cal_Spread_Backend/tests/fairValue/fixtures.mjs';
import { once } from 'node:events';

const input = inputSnapshot({ expiries: ['2026-10-20T10:00:00Z', '2026-11-17T10:00:00Z', '2026-12-15T10:00:00Z'],
  configPatch: { proportional_calendar_assumption: true, forward_interpolation: 'log_carry_assumption' } });
let tokens = [];
const engine = new FairValueEngine({ getAllInstruments: async () => input.instruments,
  getBoard: async () => [{ symbol: 'TEST', name: 'Test underlying', spot_token: 1 }], metadataVersion: () => 'browser-fixture-v1',
  activeBroker: () => 'zerodha', brokerGeneration: () => 1, dataReady: () => true, switching: () => false,
  setTokens: (t) => { tokens = t; }, tokenBudget: () => 600, retainFeed: () => () => {}, feedStatus: () => ({ connected: true }),
  store: memoryStore(), config: input.config, now: () => NOW });
await engine.boot(); await engine.watch('TEST');
const ingest = () => {
  engine.ingestTicks([{ token: 1, last_price: 100, close_price: 100, oi: 0, bid: 0, ask: 0, depth_updated: false }], NOW);
  engine.ingestTicks(input.quotes.map((q) => ({ token: q.token, last_price: (q.bid + q.ask) / 2, close_price: 0, oi: 0, bid: q.bid, ask: q.ask,
    bids: [{ price: q.bid, qty: 1000, orders: 1 }], asks: [{ price: q.ask, qty: 1000, orders: 1 }], depth_updated: true, exchange_ts: NOW - 100 })), NOW);
};
ingest(); await engine.refresh('TEST');
const feedTimer = setInterval(ingest, 1000);
const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:5175');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; } next();
});
app.use(express.json());
const getRole = (token) => token === 'browser-full' ? 'full' : token === 'browser-trade' ? 'trade' : null;
app.get('/api/admin/status', (req, res) => res.json({ authenticated: getRole(req.header('x-admin-token')) !== null, role: getRole(req.header('x-admin-token')), broker: 'zerodha' }));
app.get('/api/status', (_req, res) => res.json({ authenticated: true, broker: 'zerodha', data_ready: true, runtime: { data_ready: true }, zerodha: { authenticated: true } }));
app.get('/api/fno/board', (_req, res) => res.json({ board: [] }));
app.get('/api/fno/stocks', (_req, res) => res.json({ instruments: [] }));
app.get('/api/dividends', (_req, res) => res.json({ yields: {} }));
app.get('/api/rf/current', (_req, res) => res.json({ rf: 5 }));
app.get('/api/box/trades', (_req, res) => res.json({ open: [], trades: [] }));
app.get('/api/trades', (_req, res) => res.json({ trades: [], dbEnabled: false }));
registerFairValueRoutes(app, { engine, getAdminRole: getRole, requireFullAdmin: (req, res, next) => getRole(req.header('x-admin-token')) === 'full' ? next() : res.status(403).json({ error: 'Full admin required' }) });
const server = app.listen(3001, '127.0.0.1'); await once(server, 'listening');
const vite = await createViteServer({ root: new URL('../', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 5175, strictPort: true }, clearScreen: false });
await vite.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.addInitScript(() => localStorage.setItem('cal_spread_admin_token', 'browser-full'));
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:5175/');
  await page.getByRole('link', { name: 'Fair Value', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Fair Value', exact: true }).click();
  await page.getByRole('heading', { name: 'Fair Value', exact: true }).waitFor();
  await page.waitForSelector('.fv-table tbody tr');
  assert.ok(await page.locator('.fv-table tbody tr').count() >= 18);
  await page.getByLabel('Search option chain').fill('100 CE');
  assert.equal(await page.locator('.fv-table tbody tr').count(), 1);
  await page.locator('.fv-table tbody tr .fv-link').click();
  await page.getByRole('button', { name: 'Calculate independent estimate' }).click();
  await page.waitForFunction(() => document.querySelector('.fv-drawer')?.textContent.includes('Status: available'));
  assert.ok((await page.locator('.fv-drawer').innerText()).includes('both target sides excluded'));
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByLabel('Calculator strike').fill('102');
  await page.getByLabel('Calculator expiry IST').fill('2026-11-01T15:30');
  await page.getByRole('button', { name: 'Calculate theoretical value' }).click();
  await page.waitForSelector('.fv-calculation');
  assert.ok((await page.locator('.fv-calculation').innerText()).includes('Hypothetical contract'));
  assert.ok((await page.locator('.fv-calculation').innerText()).includes('maturity_interpolation'));
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export snapshot' }).click();
  const download = await downloadPromise; assert.match(download.suggestedFilename(), /fair-value-TEST/);
  await page.getByRole('button', { name: 'Load bounded history' }).click();
  await page.waitForSelector('.fv-history li');
  await page.locator('.fv-history li .fv-link').first().click();
  assert.ok(await page.getByRole('button', { name: 'Calculate theoretical value' }).isDisabled());
  await page.getByRole('button', { name: 'Return to current snapshot' }).click();
  await page.waitForSelector('.fv-table tbody tr');
  await page.getByRole('button', { name: 'Pause analytics', exact: true }).click();
  await page.getByRole('button', { name: 'Resume analytics', exact: true }).waitFor();
  assert.equal(tokens.length, 0);
  await page.getByRole('button', { name: 'Resume analytics', exact: true }).click();
  await page.getByRole('button', { name: 'Pause analytics', exact: true }).waitFor();
  await page.waitForTimeout(1100);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.fv-table tbody tr')].some((row) => row.cells[7]?.textContent?.trim() !== '—'));
  await page.getByLabel('Search option chain').fill('');
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  assert.equal(overflow, false, 'Mobile page must contain table/chart overflow');
  await page.screenshot({ path: new URL('../scratch/fair-value-mobile.png', import.meta.url).pathname, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: new URL('../scratch/fair-value-desktop.png', import.meta.url).pathname, fullPage: true });
  assert.deepEqual(errors, []);
  await page.getByRole('button', { name: 'Pause display' }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('calspread:fair-value-access-denied')));
  await page.getByRole('heading', { name: 'Full admin access required' }).waitFor();
  assert.equal(await page.locator('.fv-table').count(), 0);
  // Each non-admin browser mounts the guard, with no valuation requests.
  for (const token of [null, 'browser-trade']) {
    const denied = await browser.newContext();
    if (token) await denied.addInitScript((t) => localStorage.setItem('cal_spread_admin_token', t), token);
    const deniedPage = await denied.newPage(); let valuationRequests = 0;
    deniedPage.on('request', (req) => { if (req.url().includes('/api/fair-value')) valuationRequests++; });
    await deniedPage.goto('http://127.0.0.1:5175/fair-value');
    await deniedPage.getByRole('heading', { name: 'Full admin access required' }).waitFor();
    await deniedPage.waitForTimeout(300);
    assert.equal(valuationRequests, 0);
    await denied.close();
  }
  console.log(JSON.stringify({ browser: 'Chromium', navigation: true, chain_search: true, independent_refit: true,
    hypothetical_calculator: true, exports: true, history: true, pause: true, mobile_overflow: false,
    non_admin_requests: 0, page_errors: errors.length }));
} finally {
  clearInterval(feedTimer); await browser?.close(); await vite.close(); await engine.dispose();
  server.closeAllConnections(); await new Promise((r) => server.close(r));
}
