import assert from 'node:assert/strict';
import { startGoFixture, delay } from './go_backend_fixture.mjs';

const go = await startGoFixture();
const checks = [];
try {
  assert.equal((await go.request('GET', '/api/admin/status', undefined, go.full)).role, 'full');
  assert.equal((await go.request('GET', '/api/admin/status', undefined, go.trade)).role, 'trade');
  for (const token of [undefined, go.trade]) await go.request('GET', '/api/fair-value/status', undefined, token, 403);
  checks.push('real full/trade authorization');
  const status = await go.request('GET', '/api/status');
  assert.equal(status.market_data_ready, true);
  const board = await go.request('GET', '/api/fno-board');
  assert.ok(board.board.some((row) => row.symbol === 'TEST' && row.futures.length === 3));
  const quotes = await go.request('POST', '/api/quotes', { tokens: [1, 1000, 1001] });
  assert.equal(quotes.ticks.length, 3);
  checks.push('real board/instrument/REST providers');
  const session = await go.request('POST', '/api/stream/session', { tokens: [1, 1000] });
  assert.ok(session.id);
  const controller = new AbortController();
  const stream = await fetch(`${go.origin}/api/stream/session/${session.id}`, { signal: controller.signal });
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  let text = '';
  for (let n = 0; n < 20 && !text.includes('"token":'); n++) {
    const next = await Promise.race([reader.read(), delay(5000).then(() => { throw new Error('Tick SSE timeout'); })]);
    text += new TextDecoder().decode(next.value);
  }
  controller.abort();
  assert.match(text, /"token":(?:1|1000)/);
  checks.push('session-backed SSE reaches real hub/feed');
  const trades = await go.request('GET', '/api/trades', undefined, go.full);
  assert.equal(trades.dbEnabled, true);
  const closed = trades.trades.find((trade) => trade.id === go.info.calendar_id);
  assert.equal(closed.close_pnl, 150);
  assert.equal(closed.total_charges, 30);
  assert.equal(closed.net_pnl, 120);
  const synthHistory = await go.request('GET', '/api/synthetic/trades/history', undefined, go.full);
  assert.ok(synthHistory.trades.some((trade) => trade.id === go.info.synthetic_id && trade.broker === 'dhan' && trade.net_pnl === 150));
  await go.request('POST', '/api/synthetic/settings', { max_open_positions: 2 }, go.full);
  assert.equal((await go.request('GET', '/api/synthetic/status', undefined, go.full)).config.max_open_positions, 2);
  checks.push('PostgreSQL Calendar charges and Synthetic records/settings');
  for (const token of [undefined, go.trade]) {
    await go.request('POST', '/api/dhan/login/broker', {}, token, 403);
    await go.request('POST', '/api/dhan/token', { accessToken: 'loopback-pasted-dhan-token' }, token, 403);
  }
  await go.request('POST', '/api/dhan/login/broker', {}, go.full, 503);
  const pasted = await go.request('POST', '/api/dhan/token', { accessToken: 'loopback-pasted-dhan-token' }, go.full);
  assert.equal(pasted.authenticated, true);
  assert.equal(pasted.persisted, true);
  const fallback = await go.request('GET', '/api/dhan/status', undefined, go.full);
  assert.equal(fallback.source, 'MANUAL');
  assert.equal(fallback.session.client_id, '1100001');
  assert.ok(!JSON.stringify(fallback).includes('loopback-pasted-dhan-token'));
  await go.request('POST', '/api/dhan/token', { accessToken: 'loopback-rejected-dhan-token' }, go.full, 400);
  assert.equal((await go.request('GET', '/api/dhan/status', undefined, go.full)).source, 'MANUAL');
  await go.request('POST', '/__fixture/token-service', { available: true });
  await go.request('POST', '/api/dhan/login/broker', {}, go.full);
  assert.equal((await go.request('GET', '/api/dhan/status', undefined, go.full)).source, 'BROKER_LOGIN');
  checks.push('Dhan service failure, validated/persisted paste fallback, authorization and service recovery');
  await go.request('GET', '/api/spike/status', undefined, undefined, 403);
  await go.request('POST', '/api/broker/select', { broker: 'dhan' }, go.full);
  for (const symbol of ['NIFTY', 'SENSEX']) {
    for (const frame of ['1m', '5m', '30m', '1h']) {
      const history = await go.request('GET', `/api/spike/series?symbol=${symbol}&frame=${frame}`, undefined, go.trade);
      assert.ok(history.points.length > 0);
    }
  }
  await delay(600);
  await go.request('POST', '/__fixture/spike', { stage: 1 });
  await delay(600);
  await go.request('POST', '/__fixture/spike', { stage: 2 });
  let spike;
  for (let n = 0; n < 40; n++) {
    spike = await go.request('GET', '/api/spike/status', undefined, go.trade);
    if (spike.open.length === 2) break;
    await delay(150);
  }
  assert.equal(spike.open.length, 2);
  const niftySpread = spike.open.find((trade) => trade.symbol === 'NIFTY');
  assert.equal(niftySpread.direction, 'CALL_CREDIT');
  assert.equal(niftySpread.quantity, 75);
  assert.ok(niftySpread.short.symbol.endsWith('CE') && niftySpread.hedge.symbol.endsWith('CE'));
  assert.equal(niftySpread.hedge.strike - niftySpread.short.strike, 200);
  const sensexSpread = spike.open.find((trade) => trade.symbol === 'SENSEX');
  assert.equal(sensexSpread.direction, 'PUT_CREDIT');
  assert.equal(sensexSpread.quantity, 20);
  assert.ok(sensexSpread.short.symbol.endsWith('PE') && sensexSpread.hedge.symbol.endsWith('PE'));
  assert.equal(sensexSpread.short.strike - sensexSpread.hedge.strike, 400);
  await go.request('POST', '/__fixture/spike', { stage: 3 });
  await delay(600);
  const spikeExit = await go.request('POST', `/api/spike/trades/${niftySpread.id}/close`, {}, go.trade);
  assert.equal(spikeExit.pnl, -75);
  await go.request('POST', `/api/spike/trades/${sensexSpread.id}/close`, {}, go.trade);
  await go.request('POST', '/api/spike/paper', { enabled: false }, go.trade);
  assert.equal((await go.request('GET', '/api/spike/status', undefined, go.full)).paper_enabled, false);
  await go.request('POST', '/api/broker/select', { broker: 'zerodha' }, go.full);
  checks.push('Spike real Dhan binary WebSocket, both-index fourth-OTM one-lot entries, history, manual P&L and persisted paper control');
  const preflight = await fetch(`${go.origin}/api/fair-value/config`, { method: 'OPTIONS',
    headers: { Origin: 'http://127.0.0.1:5175', 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'content-type,x-admin-token' } });
  assert.equal(preflight.status, 204);
  assert.ok(preflight.headers.get('access-control-allow-methods').includes('PATCH'));
  await go.request('PATCH', '/api/fair-value/config', { max_tokens: 120 }, go.full);
  assert.equal((await go.request('GET', '/api/fair-value/config', undefined, go.full)).config.max_tokens, 120);
  await go.request('POST', '/api/fair-value/refresh', { underlying: 'TEST' }, go.full);
  let snapshot;
  for (let n = 0; n < 80; n++) {
    const result = await go.request('GET', '/api/fair-value/snapshot/TEST', undefined, go.full);
    snapshot = result.snapshot;
    if (snapshot?.slices.some((slice) => slice.rows.some((row) => row.fair_value !== null))) break;
    await delay(150);
  }
  assert.ok(snapshot?.slices.length === 3);
  assert.ok(snapshot.slices.some((slice) => slice.rows.some((row) => Number.isFinite(row.fair_value))), 'Go workers must publish usable values');
  assert.equal((await go.request('GET', '/api/fair-value/status', undefined, go.full)).storage, 'postgres');
  const history = await go.request('GET', '/api/fair-value/history/TEST', undefined, go.full);
  assert.ok(history.snapshots.length > 0);
  const historical = await go.request('GET', `/api/fair-value/history/TEST/${history.snapshots[0].id}`, undefined, go.full);
  assert.equal(historical.historical, true);
  const exported = await go.request('GET', '/api/fair-value/export/TEST', undefined, go.full);
  assert.ok(exported.snapshot.input_snapshot_id);
  await go.request('POST', '/api/fair-value/pause', { paused: true }, go.full);
  assert.equal((await go.request('GET', '/api/fair-value/status', undefined, go.full)).paused, true);
  checks.push('CORS PATCH, real Fair Value models/workers/history/export/pause');
  const missing = await fetch(`${go.origin}/api/box/status`);
  assert.equal(missing.status, 404);
  const info = await (await fetch(`${go.origin}/__fixture`)).json();
  assert.equal(info.blocked_outbound, 0);
  checks.push('Box 404 and all upstream calls stay on loopback');
  console.log(JSON.stringify({ runtime: info.runtime, checks, passed: checks.length }));
} finally {
  await go.stop();
}
