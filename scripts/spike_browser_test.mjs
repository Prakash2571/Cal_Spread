/** Spike UI against the actual Go/PostgreSQL service and generated Dhan binary feed. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer as createViteServer } from '../node_modules/vite/dist/node/index.js';
import { startGoFixture, root, scratch, freePort, delay } from './go_backend_fixture.mjs';
import { startFirefox } from './webdriver.mjs';

const site = `http://127.0.0.1:${await freePort()}`;
const go = await startGoFixture(site);
const directory = await mkdtemp(path.join(scratch, 'spike-browser-'));
const checks = [];
let browser, vite;
async function chartLabelBounds() {
  return browser.js(`return [...document.querySelectorAll('.spike-chart-grid svg')].flatMap((svg, chart) => {
    const canvas = svg.getBoundingClientRect();
    return [...svg.querySelectorAll('.chart-xlabel')].map((label) => {
      const box = label.getBoundingClientRect();
      return { chart, text: label.textContent, inside: box.left >= canvas.left - 1 && box.right <= canvas.right + 1 };
    });
  });`);
}
async function assertPeakColumn(rowSelector) {
  const table = await browser.js(`const row = document.querySelector(arguments[0]);
    return {
      headers: [...row.closest('table').querySelectorAll('thead th')].map((cell) => cell.textContent),
      cells: [...row.cells].map((cell) => ({ text: cell.textContent, className: cell.className })),
    };`, [rowSelector]);
  const gross = table.headers.indexOf('Gross P&L');
  assert.ok(gross >= 0);
  assert.equal(table.headers[gross + 1], 'Peak P&L');
  assert.equal(table.cells.length, table.headers.length);
  assert.ok(table.cells[gross + 1].text.trim().length > 0);
  assert.match(table.cells[gross + 1].className, /^spike-(positive|negative)$/);
}
try {
  await go.request('POST', '/__fixture/token-service', { available: true });
  await go.request('POST', '/api/dhan/login/broker', {}, go.full);
  await go.request('POST', '/api/broker/select', { broker: 'dhan' }, go.full);
  vite = await createViteServer({ root, clearScreen: false,
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(go.origin) },
    server: { host: '127.0.0.1', port: Number(new URL(site).port), strictPort: true } });
  await vite.listen();
  browser = await startFirefox(directory);
  await browser.resize(1440, 1000);
  await browser.goto(site);
  await browser.js("localStorage.setItem('cal_spread_admin_token', arguments[0]); return true", [go.trade]);
  await browser.goto(site);
  await browser.wait("document.querySelector('a[href=\"/spike\"]')");
  await browser.button('Spike');
  await browser.wait("document.querySelectorAll('.spike-index').length === 2 && document.querySelectorAll('.spike-chart-grid svg').length === 2");
  const charts = await browser.js(`return [...document.querySelectorAll('.spike-index')].map((index) => ({
    symbol: index.querySelector('h2').textContent,
    articles: index.querySelectorAll('.spike-chart-grid article').length,
    plots: index.querySelectorAll('.spike-chart-grid svg').length,
    labels: [...index.querySelectorAll('.chart-readout-main .chart-readout-label')].map((label) => label.textContent),
    lines: [...index.querySelectorAll('svg .chart-line')].map((line) => ({
      color: line.getAttribute('stroke'), dashed: line.getAttribute('stroke-dasharray'),
    })),
  }));`);
  assert.deepEqual(charts, ['NIFTY', 'SENSEX'].map((symbol) => ({
    symbol, articles: 1, plots: 1,
    labels: ['Minimum CE + PE premium', 'CE VWAP + PE VWAP'],
    lines: [{ color: '#22c55e', dashed: null }, { color: '#eab308', dashed: '5 4' }],
  })));
  await browser.wait("window.__verificationStreams.some((stream) => stream.path === '/api/spike/stream' && stream.opened && stream.frames > 0)");
  checks.push('trade-access Spike navigation and one shared plot per index with solid green premium and dashed yellow VWAP');
  for (const frame of ['5m', '30m', '1h', '1m']) {
    await browser.click(`.spike-frame-buttons button:nth-child(${['1m', '5m', '30m', '1h'].indexOf(frame) + 1})`);
    await browser.wait("document.querySelectorAll('.spike-chart-grid svg').length === 2");
  }
  checks.push('all four chart timeframes');
  await browser.button('Pause paper entries');
  await browser.wait("[...document.querySelectorAll('button')].some((button) => button.textContent === 'Resume paper entries')");
  assert.equal((await go.request('GET', '/api/spike/status', undefined, go.trade)).paper_enabled, false);
  await browser.button('Resume paper entries');
  await delay(600);
  await go.request('POST', '/__fixture/spike', { stage: 1 });
  await delay(600);
  await go.request('POST', '/__fixture/spike', { stage: 2 });
  await browser.wait("document.querySelectorAll('tr[data-spike-symbol]').length === 2", 15000);
  assert.ok((await browser.js("return document.querySelector('tr[data-spike-symbol=\"NIFTY\"]').innerText")).includes('75 qty'));
  assert.ok((await browser.js("return document.querySelector('tr[data-spike-symbol=\"SENSEX\"]').innerText")).includes('20 qty'));
  await assertPeakColumn('tr[data-spike-symbol="NIFTY"]');
  await assertPeakColumn('tr[data-spike-symbol="SENSEX"]');
  checks.push('open paper spreads render Peak P&L immediately after Gross P&L');
  const desktopLabels = await chartLabelBounds();
  assert.ok(desktopLabels.length > 0 && desktopLabels.every((label) => label.inside), `Desktop chart labels clipped: ${JSON.stringify(desktopLabels.filter((label) => !label.inside))}`);
  await browser.screenshot('spike-desktop');
  checks.push('persisted paper control and both one-lot fourth-OTM entries from the Dhan WebSocket');
  await go.request('POST', '/__fixture/spike', { stage: 3 });
  await delay(600);
  await browser.click('tr[data-spike-symbol="NIFTY"] button');
  await browser.wait("document.querySelectorAll('tr[data-spike-symbol]').length === 1 && document.body.innerText.includes('-75.00')");
  await assertPeakColumn('.spike-trades tbody tr:not([data-spike-symbol])');
  checks.push('closed paper spreads render Peak P&L immediately after Gross P&L');
  checks.push('manual paper exit and realized executable-touch P&L');
  await browser.resize(390, 844);
  await browser.wait("[...document.querySelectorAll('.spike-chart-grid svg')].every((svg) => svg.getBoundingClientRect().width <= svg.parentElement.clientWidth + 1)");
  const mobile = await browser.js('return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth }');
  assert.ok(mobile.scrollWidth <= mobile.width + 2);
  const mobileLabels = await chartLabelBounds();
  assert.ok(mobileLabels.length > 0 && mobileLabels.every((label) => label.inside), `Mobile chart labels clipped: ${JSON.stringify(mobileLabels.filter((label) => !label.inside))}`);
  await browser.screenshot('spike-mobile');
  checks.push('desktop/mobile chart-axis labels fully contained and 390px chart/table containment');
  const before = browser.requests.filter((request) => request.path.startsWith('/api/spike')).length;
  await browser.js("localStorage.removeItem('cal_spread_admin_token'); return true");
  await browser.goto(`${site}/spike`);
  await browser.wait("document.body.innerText.includes('Trade access required')");
  await delay(300);
  assert.equal(browser.requests.filter((request) => request.path.startsWith('/api/spike')).length - before, 0);
  assert.deepEqual(await browser.js('return window.__verificationErrors'), []);
  const cancelledStreams = browser.errors.filter((message) => message.includes('/api/spike/stream?') &&
    message.includes('CORS request did not succeed') && message.includes('Status code: (null)'));
  assert.deepEqual(browser.errors.filter((message) => !cancelledStreams.includes(message)), []);
  const info = await (await fetch(`${go.origin}/__fixture`)).json();
  assert.equal(info.blocked_outbound, 0);
  checks.push('public page makes no private Spike requests; no JS errors or remote upstream calls');
  const report = { browser: `Firefox ${browser.version}`, runtime: info.runtime, checks, mobile, chart_labels: { desktop: desktopLabels, mobile: mobileLabels },
    verified_stream_cancellation_logs: cancelledStreams.length, passed: checks.length };
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidence: directory }));
} catch (error) {
  await browser?.screenshot('failure').catch(() => undefined);
  await writeFile(path.join(directory, 'failure.log'), `${error.stack}\n${browser?.getLog() || ''}\n${go.getLog()}`);
  throw error;
} finally {
  await browser?.stop();
  await vite?.close();
  await go.stop();
}
