/** Actual React + actual Go App/Chi/PostgreSQL + local Firefox integration.
 * Broker prices are generated on loopback; no real credentials/market/order transport.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer as createViteServer } from '../node_modules/vite/dist/node/index.js';
import { startGoFixture, root, scratch, freePort, delay } from './go_backend_fixture.mjs';
import { startFirefox } from './webdriver.mjs';

const sitePort = await freePort();
const site = `http://127.0.0.1:${sitePort}`;
const go = await startGoFixture(site);
const directory = await mkdtemp(path.join(scratch, 'browser-'));
const checks = [];
let browser, vite;
try {
  vite = await createViteServer({ root, clearScreen: false,
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(go.origin) },
    server: { host: '127.0.0.1', port: sitePort, strictPort: true } });
  await vite.listen();
  browser = await startFirefox(directory);
  await browser.resize(1440, 1000);
  await browser.goto(`${site}/admin/verify`);
  await browser.wait("document.querySelector('.admin-input')");
  await browser.fill('.admin-input', 'loopback-fixture-admin');
  await browser.button('Verify & use Zerodha');
  await browser.wait("location.pathname === '/' && document.querySelector('a[href=\"/fair-value\"]')");
  await browser.wait("Number(document.querySelector('.card-price')?.textContent.trim()) === 100");
  assert.doesNotMatch(await browser.js('return document.body.innerText'), /\bBox\b/);
  checks.push('real admin form, board prices and retained navigation');

  await browser.click('.toolbar-menu-trigger');
  await browser.button('Trades');
  await browser.wait("document.querySelector('.modal .trade-card')");
  await browser.click('.modal .month-all');
  assert.ok((await browser.js("return document.querySelector('.modal .month-stats').innerText")).includes('+₹120'));
  assert.equal(await browser.js("return document.querySelectorAll('.modal [role=tab]').length"), 0);
  assert.ok((await browser.js("return document.querySelector('.modal').innerText")).includes('History'));
  await browser.click('.modal-x');
  checks.push('PostgreSQL Calendar history, gross/charges/net and no Box tab');

  await browser.button('Broker');
  await browser.wait("document.querySelectorAll('.broker-row').length === 2");
  assert.equal(await browser.js("return document.querySelector('.broker-live .feed-state--LIVE')?.textContent"), 'Live');
  await browser.click('.modal-x');
  checks.push('actual broker readiness panel');

  await browser.button('Synthetic');
  await browser.wait("document.querySelector('.sf-controls input')");
  await browser.wait("window.__verificationStreams.some((s) => s.path === '/api/synthetic/stream' && s.opened && s.frames > 0)");
  await browser.fill('.sf-controls label:nth-of-type(3) input', '2');
  await browser.button('Save');
  await browser.wait("document.body.innerText.includes('saved')");
  assert.equal((await go.request('GET', '/api/synthetic/status', undefined, go.full)).config.max_open_positions, 2);
  await browser.button('Closed trades', true);
  await browser.wait("document.querySelector('.box-history-days')");
  assert.ok((await browser.js("return document.querySelector('.box-history-days').innerText")).includes('DHAN'));
  assert.ok((await browser.js('return document.body.innerText')).includes('150'));
  await browser.screenshot('synthetic-history');
  checks.push('Synthetic controls, saved settings and original record broker');

  await browser.goto(site);
  await browser.wait("document.querySelector('a[href=\"/fair-value\"]')");
  await browser.button('Fair Value');
  await browser.wait("document.querySelectorAll('.fv-table tbody tr').length >= 18", 30000);
  await browser.wait("[...document.querySelectorAll('.fv-table tbody tr')].some((row) => row.cells[7]?.textContent.trim() !== '—')");
  await browser.button('Pause display');
  await browser.fill('[aria-label="Search option chain"]', '100 CE');
  await browser.wait("document.querySelectorAll('.fv-table tbody tr').length === 1");
  await browser.click('.fv-table tbody tr .fv-link');
  await browser.button('Calculate independent estimate');
  await browser.wait("document.querySelector('.fv-drawer')?.textContent.includes('Status: available')");
  assert.ok((await browser.js("return document.querySelector('.fv-drawer').innerText")).includes('both target sides excluded'));
  await browser.button('Close');
  checks.push('Fair Value chain search and independent leave-one-strike-out refit');

  await browser.fill('[aria-label="Calculator strike"]', '102');
  await browser.fill('[aria-label="Calculator expiry IST"]', go.info.calculator_expiry);
  await browser.button('Calculate theoretical value');
  await browser.wait("document.querySelector('.fv-calculation')");
  const calculated = await browser.js("return document.querySelector('.fv-calculation').innerText");
  assert.ok(calculated.includes('Hypothetical contract'));
  assert.ok(calculated.includes('maturity_interpolation'));
  checks.push('real hypothetical strike/maturity calculator');

  await browser.button('Export snapshot');
  let download;
  for (let n = 0; n < 80; n++) {
    download = (await readdir(path.join(directory, 'downloads'))).find((name) => /^fair-value-TEST.*\.json$/.test(name));
    if (download) break;
    await delay(100);
  }
  assert.ok(download, 'Firefox must save the real snapshot export');
  const exported = JSON.parse(await readFile(path.join(directory, 'downloads', download), 'utf8'));
  assert.ok(exported.snapshot.input_snapshot_id);
  assert.equal(exported.snapshot.underlying, 'TEST');
  checks.push('browser JSON download from real export API');

  await browser.button('Resume display');
  await browser.button('Load bounded history');
  await browser.wait("document.querySelector('.fv-history li .fv-link')");
  await browser.click('.fv-history li .fv-link');
  await browser.wait("document.body.innerText.includes('Historical — no live valuation')");
  assert.equal(await browser.js("return [...document.querySelectorAll('button')].find((b) => b.textContent === 'Calculate theoretical value').disabled"), true);
  await browser.button('Return to current snapshot');
  await browser.wait("document.querySelectorAll('.fv-table tbody tr').length > 0");
  await browser.button('Pause analytics');
  await browser.wait("[...document.querySelectorAll('button')].some((b) => b.textContent === 'Resume analytics')");
  assert.equal((await go.request('GET', '/api/fair-value/status', undefined, go.full)).subscribed_tokens, 0);
  await browser.button('Resume analytics');
  await browser.wait("[...document.querySelectorAll('.fv-table tbody tr')].some((row) => row.cells[7]?.textContent.trim() !== '—')", 30000);
  checks.push('PostgreSQL history mode, current return and subscription pause/resume');

  await browser.fill('[aria-label="Search option chain"]', '');
  await browser.resize(390, 844);
  await delay(150);
  const dimensions = await browser.js('return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth }');
  assert.equal(dimensions.width, 390);
  assert.ok(dimensions.scrollWidth <= dimensions.width + 2, 'Mobile page must contain table/chart overflow');
  await browser.screenshot('fair-value-mobile');
  await browser.resize(1440, 1000);
  await browser.screenshot('fair-value-desktop');
  checks.push('390px mobile containment and desktop rendering');

  await browser.js("window.dispatchEvent(new Event('calspread:fair-value-access-denied')); return true");
  await browser.wait("document.body.innerText.includes('Full admin access required')");
  assert.equal(await browser.js("return document.querySelectorAll('.fv-table').length"), 0);
  checks.push('authorization revocation clears private rendered data');

  for (const token of [null, go.trade]) {
    await browser.goto(site);
    await browser.js("if (arguments[0]) localStorage.setItem('cal_spread_admin_token', arguments[0]); else localStorage.removeItem('cal_spread_admin_token'); return true", [token]);
    const before = browser.requests.filter((r) => r.path.startsWith('/api/fair-value')).length;
    await browser.goto(`${site}/fair-value`);
    await browser.wait("document.body.innerText.includes('Full admin access required')");
    await delay(500);
    const after = browser.requests.filter((r) => r.path.startsWith('/api/fair-value')).length;
    assert.equal(after - before, 0, 'Public/trade-access browser must make zero valuation requests');
    assert.deepEqual(await browser.js('return window.__verificationErrors'), []);
  }
  checks.push('public and trade-access zero valuation requests');
  assert.equal(browser.requests.some((r) => r.path.startsWith('/api/box')), false);
  // Firefox may log a CORS/null-status message when navigation closes an already
  // verified EventSource. Its successful open + actual snapshot were checked above.
  const streamCancellations = browser.errors.filter((message) =>
    message.includes('/api/synthetic/stream?') && message.includes('CORS request did not succeed') && message.includes('Status code: (null)'));
  const pageErrors = browser.errors.filter((message) => !streamCancellations.includes(message));
  assert.deepEqual(pageErrors, []);
  const info = await (await fetch(`${go.origin}/__fixture`)).json();
  assert.equal(info.blocked_outbound, 0);
  checks.push('zero hidden Box calls, JavaScript errors or remote upstream calls');
  const report = { browser: `Firefox ${browser.version}`, runtime: info.runtime, data: 'generated loopback market in isolated PostgreSQL schema', checks,
    mobile: dimensions, page_errors: pageErrors.length, verified_stream_cancellation_logs: streamCancellations.length,
    hidden_box_calls: 0, non_admin_valuation_requests: 0 };
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, passed: checks.length, evidence: directory }));
} catch (error) {
  if (browser) await browser.screenshot('failure').catch(() => undefined);
  await writeFile(path.join(directory, 'failure.log'), `${error.stack}\n\n${browser?.getLog() || ''}\n${go.getLog()}`);
  throw error;
} finally {
  await browser?.stop();
  await vite?.close();
  await go.stop();
}
