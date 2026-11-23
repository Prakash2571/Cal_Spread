import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.localStorage = { getItem: () => null };
const { subscribeStraddle } = await import('../src/straddleApi.ts');

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
