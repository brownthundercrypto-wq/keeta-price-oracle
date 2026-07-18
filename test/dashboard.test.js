// (Transparency dashboard) /dashboard-data payload builder — pure, hermetic (no server/network).
// Asserts the all-pairs shape: median/confidence/twap/stale + per-source used-vs-dropped breakdown,
// plus top-level liveSourceCount, lastPriceUpdate, and the latest on-chain publish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboardData } from '../src/dashboard.js';

// Two synthetic cache entries mirroring priceFeed's output: a fresh pair (with an outlier + an
// unreachable source dropped) and a stale pair carrying a last-good price.
const prices = {
  'KTA-USD': {
    pair: 'KTA-USD', symbol: 'KTA', price: '0.116', priceScaled: '11600000', priceScaleDecimals: 8,
    quoteCurrency: 'USD', method: 'median', sources: 'coinbase,kraken', sourceList: ['coinbase', 'kraken'],
    sourceReports: [
      { name: 'coinbase', price: '0.116', ts: 't', quote: 'USD' },
      { name: 'kraken', price: '0.117', ts: 't', quote: 'USD' },
    ],
    droppedSources: [
      { name: 'mexc', price: '0.130', ts: 't', quote: 'USDT', type: 'outlier', deviationPct: '12.0' },
      { name: 'coingecko', ts: 't', quote: 'USD', type: 'unreachable', error: 'HTTP 429' },
    ],
    confidenceBand: '0.0005', confidencePct: '0.43', liveSourceCount: 2, stale: false, updatedAt: '2026-07-18T19:00:00.000Z',
  },
  'BTC-USD': {
    pair: 'BTC-USD', symbol: 'BTC', price: '64000', priceScaled: '6400000000000', priceScaleDecimals: 8,
    quoteCurrency: 'USD', method: 'median', sources: '', sourceList: [],
    sourceReports: [{ name: 'coinbase', price: '64000', ts: 't', quote: 'USD' }],
    droppedSources: [{ name: 'kraken', ts: 't', quote: 'USD', type: 'unreachable', error: 'timeout' }],
    confidenceBand: null, confidencePct: null, liveSourceCount: 1, stale: true, updatedAt: '2026-07-18T18:59:00.000Z',
  },
};

const twapResolver = (pair) => (pair === 'KTA-USD' ? { twap1h: '0.1155', twap24h: 'building' } : { twap1h: 'building', twap24h: 'building' });
const onchain = { blockHash: 'ABC123', previous: 'PREV', publishedAt: '2026-07-18T19:00:05.000Z', trigger: 'heartbeat', reason: 'heartbeat (…)' };

function build() {
  return buildDashboardData({ prices, oracle: 'keeta_testoracle', twapResolver, onchain, nowIso: '2026-07-18T19:00:10.000Z' });
}

test('top-level shape: all pairs in one response with aggregate fields', () => {
  const d = build();
  assert.equal(d.ok, true);
  assert.equal(d.oracle, 'keeta_testoracle');
  assert.equal(d.network, 'test');
  assert.equal(typeof d.version, 'string');
  assert.equal(d.aggregation, 'median');
  assert.equal(d.generatedAt, '2026-07-18T19:00:10.000Z');
  // distinct live sources across ALL pairs (union of sourceReports names): coinbase, kraken
  assert.deepEqual(d.sources, ['coinbase', 'kraken']);
  assert.equal(d.liveSourceCount, 2);
  // most recent updatedAt across pairs
  assert.equal(d.lastPriceUpdate, '2026-07-18T19:00:00.000Z');
  assert.deepEqual(d.onchain, onchain);
  assert.ok(Array.isArray(d.pairs));
  assert.equal(d.pairs.length, 2);
});

test('each pair carries median/confidence/twap/stale and the per-source breakdown', () => {
  const d = build();
  const kta = d.pairs.find((p) => p.pair === 'KTA-USD');
  assert.ok(kta);
  for (const f of ['pair', 'symbol', 'price', 'priceScaled', 'priceScaleDecimals', 'quoteCurrency', 'method', 'stale', 'liveSourceCount', 'confidenceBand', 'confidencePct', 'twap1h', 'twap24h', 'updatedAt', 'sources']) {
    assert.ok(f in kta, `missing field ${f}`);
  }
  assert.equal(kta.price, '0.116');
  assert.equal(kta.confidenceBand, '0.0005');
  assert.equal(kta.confidencePct, '0.43');
  assert.equal(kta.twap1h, '0.1155');
  assert.equal(kta.twap24h, 'building');
  assert.equal(kta.stale, false);
});

test('per-source breakdown labels used vs outlier vs unreachable (with deviation%)', () => {
  const d = build();
  const kta = d.pairs.find((p) => p.pair === 'KTA-USD');
  // 2 used + 2 dropped = 4 rows, sorted by name
  assert.equal(kta.sources.length, 4);
  assert.deepEqual(kta.sources.map((s) => s.name), ['coinbase', 'coingecko', 'kraken', 'mexc']);
  const used = kta.sources.filter((s) => s.status === 'used');
  assert.equal(used.length, 2);
  const outlier = kta.sources.find((s) => s.name === 'mexc');
  assert.equal(outlier.status, 'outlier');
  assert.equal(outlier.quote, 'USDT');
  assert.equal(outlier.deviationPct, '12.0');
  assert.equal(outlier.price, '0.130');
  const unreachable = kta.sources.find((s) => s.name === 'coingecko');
  assert.equal(unreachable.status, 'unreachable');
  assert.equal(unreachable.error, 'HTTP 429');
  assert.equal(unreachable.price, null);
});

test('a stale pair is flagged and still included with its breakdown', () => {
  const d = build();
  const btc = d.pairs.find((p) => p.pair === 'BTC-USD');
  assert.equal(btc.stale, true);
  assert.equal(btc.price, '64000');
  assert.equal(btc.confidencePct, null);
  assert.equal(btc.sources.length, 2); // 1 used + 1 unreachable
  assert.equal(btc.sources.find((s) => s.name === 'kraken').status, 'unreachable');
});

test('handles a null on-chain publish (no snapshot yet) without throwing', () => {
  const d = buildDashboardData({ prices, oracle: 'x', twapResolver, onchain: null, nowIso: 'now' });
  assert.equal(d.onchain, null);
  assert.equal(d.pairs.length, 2);
});
