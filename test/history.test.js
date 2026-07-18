// (Dashboard sparkline) recentHistory downsampling/bounding + /dashboard-data history wiring.
// Hermetic: in-memory SQLite time-series, no network, no chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initTimeseries, recordPrice, recentHistory } from '../src/timeseries.js';
import { buildDashboardData } from '../src/dashboard.js';

initTimeseries(':memory:');

const HOUR = 3_600_000;
const NOW = 4_000_000_000_000; // fixed clock (ms)

// Seed 300 points across the last hour for KTA-USD, and 3 points for BTC-USD (cold-ish).
for (let i = 0; i < 300; i++) recordPrice('KTA-USD', 0.10 + i * 0.0001, NOW - HOUR + i * (HOUR / 300));
for (let i = 0; i < 3; i++) recordPrice('BTC-USD', 64000 + i, NOW - 3 * 60_000 + i * 60_000);

test('recentHistory is bounded to maxPoints and returns [{t, price}] ascending', () => {
  const h = recentHistory('KTA-USD', HOUR, 60, NOW);
  assert.ok(h.length <= 60, `expected <= 60, got ${h.length}`);
  assert.ok(h.length >= 40, `expected a healthy sample count, got ${h.length}`);
  for (const pt of h) {
    assert.equal(typeof pt.t, 'number');
    assert.equal(typeof pt.price, 'number');
  }
  for (let i = 1; i < h.length; i++) assert.ok(h[i].t >= h[i - 1].t, 'must be ascending by time');
});

test('recentHistory preserves the first and last points when downsampling', () => {
  const h = recentHistory('KTA-USD', HOUR, 60, NOW);
  assert.equal(h[0].price, 0.10, 'first point preserved');
  // last recorded price is 0.10 + 299*0.0001
  assert.ok(Math.abs(h[h.length - 1].price - (0.10 + 299 * 0.0001)) < 1e-9, 'last (latest) point preserved');
});

test('recentHistory returns all points (no downsample) when under the cap', () => {
  const h = recentHistory('BTC-USD', HOUR, 60, NOW);
  assert.equal(h.length, 3);
  assert.equal(h[0].price, 64000);
});

test('recentHistory is empty for an unknown pair (no history yet)', () => {
  assert.deepEqual(recentHistory('DOGE-USD', HOUR, 60, NOW), []);
});

test('/dashboard-data includes a bounded per-pair history array for the sparkline', () => {
  const prices = {
    'KTA-USD': { pair: 'KTA-USD', symbol: 'KTA', price: '0.13', quoteCurrency: 'USD', method: 'median', stale: false, liveSourceCount: 5, sourceReports: [{ name: 'coinbase', price: '0.13', quote: 'USD' }], droppedSources: [], updatedAt: '2026-07-18T20:00:00.000Z' },
    'BTC-USD': { pair: 'BTC-USD', symbol: 'BTC', price: '64002', quoteCurrency: 'USD', method: 'median', stale: false, liveSourceCount: 3, sourceReports: [{ name: 'coinbase', price: '64002', quote: 'USD' }], droppedSources: [], updatedAt: '2026-07-18T20:00:00.000Z' },
  };
  const d = buildDashboardData({
    prices,
    oracle: 'keeta_test',
    twapResolver: () => ({ twap1h: '0.12', twap24h: 'building' }),
    historyResolver: (pair) => recentHistory(pair, HOUR, 60, NOW),
    onchain: null,
    nowIso: 'now',
  });
  const kta = d.pairs.find((p) => p.pair === 'KTA-USD');
  const btc = d.pairs.find((p) => p.pair === 'BTC-USD');
  assert.ok(Array.isArray(kta.history));
  assert.ok(kta.history.length > 1 && kta.history.length <= 60);
  assert.ok('t' in kta.history[0] && 'price' in kta.history[0]);
  assert.equal(btc.history.length, 3);
});

test('history is an empty array when no historyResolver is provided', () => {
  const d = buildDashboardData({
    prices: { 'KTA-USD': { pair: 'KTA-USD', symbol: 'KTA', price: '0.13', sourceReports: [], droppedSources: [], stale: false } },
    oracle: 'x', twapResolver: () => ({ twap1h: null, twap24h: null }), onchain: null, nowIso: 'now',
  });
  assert.deepEqual(d.pairs[0].history, []);
});
