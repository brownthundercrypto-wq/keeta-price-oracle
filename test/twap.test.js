// (6) TWAP — proper time-weighting (uneven durations), carry-in clipped to the window start,
// cold-start returns "building". Hermetic: in-memory SQLite, no network / chain.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initTimeseries, recordPrice, computeTwap } from '../src/timeseries.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

before(() => {
  initTimeseries(':memory:'); // isolated, no volume, no file
});

test('TWAP is time-weighted by duration, not a naive sample average (133.33, not 150)', () => {
  // Window [7000, 10000] (3000ms). Price 100 from before the window (carry-in) until t=9000, then
  // 200 until now=10000. So 100 is current for 2000ms and 200 for 1000ms.
  const pair = 'WEIGHT-USD';
  recordPrice(pair, 100, 6000); // carry-in sample, starts BEFORE the window
  recordPrice(pair, 200, 9000); // inside the window
  const r = computeTwap(pair, 3000, 10000);
  assert.equal(r.status, 'ready');
  // (100*2000 + 200*1000) / 3000 = 400000/3000 = 133.33...  (a naive mean of {100,200} would be 150)
  close(r.value, 400000 / 3000);
});

test('carry-in is clipped to the window start (not counted from its actual timestamp)', () => {
  // Same data, but if the carry-in 100 were counted from t=6000 instead of the window start 7000,
  // the weighted average would be (100*3000 + 200*1000)/4000 = 125, not 133.33.
  const pair = 'CLIP-USD';
  recordPrice(pair, 100, 6000);
  recordPrice(pair, 200, 9000);
  const clipped = computeTwap(pair, 3000, 10000).value;
  close(clipped, 400000 / 3000); // 133.33 proves clipping to the window start
  assert.notStrictEqual(Math.round(clipped * 100) / 100, 125);
});

test('cold start returns "building" when history does not reach the window start', () => {
  // Only one sample, AFTER the window start -> no carry-in -> cannot cover the whole window.
  const pair = 'COLD-USD';
  recordPrice(pair, 100, 9000); // window start is 7000; nothing at/before it
  const r = computeTwap(pair, 3000, 10000);
  assert.equal(r.status, 'building');
  assert.equal(r.value, null);
  assert.ok(r.haveMs >= 0);
});

test('cold start with NO samples at all returns "building"', () => {
  const r = computeTwap('EMPTY-USD', 3000, 10000);
  assert.equal(r.status, 'building');
  assert.equal(r.value, null);
});

test('constant price over the whole window equals that price', () => {
  const pair = 'FLAT-USD';
  recordPrice(pair, 50, 1000); // well before the window start
  const r = computeTwap(pair, 3000, 10000);
  assert.equal(r.status, 'ready');
  close(r.value, 50);
});
