import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SpikeStraddleChart from '../src/SpikeStraddleChart.tsx';

globalThis.localStorage = { getItem: () => null };
const { subscribeStraddle } = await import('../src/straddleApi.ts');
const { StraddleCard } = await import('../src/Straddle.tsx');

const item = { symbol: 'ABB', name: 'ABB India', expiry: '2026-11-24' };
const now = Date.parse('2026-11-23T15:45:00+05:30');
const bar = { t: now - 900_000, strike: 5000, expiry: item.expiry, premium: 10, vwap: 10 };

function renderClosedCard(points) {
  const chart = {
    day: '2026-11-23', symbol: item.symbol, expiry: item.expiry, status: 'closed',
    recording_since: 0, current: null, points, snapshotAt: now,
  };
  return renderToStaticMarkup(createElement(StraddleCard, {
    item, chart, renderChart: true, connected: true, now, expanded: false, toggle() {},
  }));
}

test('a closed Straddle card with a gap renders the plot and keeps the status in the footer', () => {
  const html = renderClosedCard([{ ...bar, premium: 0, vwap: 0, gap: true }]);
  assert.match(html, /<div class="spike-straddle-plot"><svg\b/);
  assert.match(html, /class="spike-straddle-axis"/);
  assert.match(html, /<path d="" class="spike-straddle-line premium"/);
  assert.doesNotMatch(html, /class="spike-straddle-point"/);
  assert.match(html, /Premium <b>No data<\/b>/);
  assert.doesNotMatch(html, /class="spike-straddle-empty"/);
  assert.match(html, /<footer class="straddle-card-footer"><span>Market closed<\/span><\/footer>/);
});

test('a closed Straddle card with no points shows the status in the chart area', () => {
  const html = renderClosedCard([]);
  assert.match(html, /<div class="spike-straddle-plot"><div class="spike-straddle-empty">Market closed<\/div>/);
  assert.match(html, /<footer class="straddle-card-footer"><span>Market closed<\/span><\/footer>/);
});

test('Spike keeps its empty message with zero or one priced point', () => {
  for (const series of [[], [bar]]) {
    const html = renderToStaticMarkup(createElement(SpikeStraddleChart, {
      symbol: 'NIFTY', series, current: null, expiry: item.expiry, now, expanded: false, onToggleExpanded() {},
    }));
    assert.match(html, /<div class="spike-straddle-empty">Waiting for paired CE and PE option bars\.<\/div>/);
  }
});

function captureRetries() {
  const scheduled = [];
  globalThis.window = {
    setTimeout: (callback, delay) => scheduled.push({ callback, delay }),
    clearTimeout: (id) => { if (id) scheduled[id - 1] = undefined; },
  };
  return scheduled;
}

test('Straddle distinguishes a capacity refusal and respects the retry delay', { timeout: 3000 }, async (t) => {
  const retries = captureRetries();
  const rejected = Response.json({ code: 'straddle_stream_capacity', retry_after: 10 }, { status: 503 });
  t.mock.method(globalThis, 'fetch', async () => rejected);
  const error = await new Promise((resolve) => {
    const stop = subscribeStraddle('/stream', 'snapshot', () => assert.fail('unexpected snapshot'), resolve);
    t.after(stop);
  });
  assert.equal(error, 'capacity');
  assert.equal(retries.length, 1);
  assert.ok(retries[0].delay >= 10_000);
});

test('Straddle parses split SSE frames and reports a transient EOF', { timeout: 3000 }, async (t) => {
  const retries = captureRetries();
  const encoder = new TextEncoder();
  const frames = new ReadableStream({
    start(controller) {
      for (const chunk of ['event: coverage\ndata: {}\n\nevent: snap', 'shot\r\ndata: [{"symbol":"ABB"}]\r', '\n\r\n']) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  const snapshots = [];
  t.mock.method(globalThis, 'fetch', async () => new Response(frames, {
    headers: { 'Content-Type': 'text/event-stream' },
  }));
  const error = await new Promise((resolve) => {
    const stop = subscribeStraddle('/stream', 'snapshot', (snapshot) => snapshots.push(snapshot), resolve);
    t.after(stop);
  });
  assert.deepEqual(snapshots, [[{ symbol: 'ABB' }]]);
  assert.equal(error, 'connection');
  assert.equal(retries.length, 1);
  assert.ok(retries[0].delay >= 5000 && retries[0].delay < 6000);
});
