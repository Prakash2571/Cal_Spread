import test from 'node:test';
import assert from 'node:assert/strict';
import { displayIv, displayNumber, localInputToUtc, utcToLocalInput, fittedPoints } from '../src/fairValue/view.ts';

test('valuation display preserves decimal IV/percent and explicit IST conversion', () => {
  assert.equal(displayIv(.2), '20.00%');
  assert.equal(displayIv(null), '—');
  assert.equal(displayNumber(Infinity), '—');
  assert.equal(localInputToUtc('2026-11-17T15:30:00'), '2026-11-17T10:00:00.000Z');
  assert.equal(utcToLocalInput('2026-11-17T10:00:00Z'), '2026-11-17T15:30:00');
  assert.equal(localInputToUtc('2026-11-17'), null);
  assert.equal(localInputToUtc('2026-02-30T15:30'), null);
});

test('smile chart plots w and converts to annualized IV using the same maturity', () => {
  const slice = { t: .5, smile: { valid: true, method: 'validated_interpolation', support: { min_k: -.1, max_k: .1 }, nodes: [{ k: -.1, w: .02 }, { k: .1, w: .045 }] } };
  assert.equal(fittedPoints(slice)[0].iv, .2);
  assert.equal(fittedPoints(slice)[1].iv, .3);
  assert.equal(fittedPoints({ ...slice, smile: { ...slice.smile, valid: false } }).length, 0);
});
