// (8) SIZE GUARD — snapshotMetadataLength for a representative all-pairs snapshot stays < 5000
// (well under the ~5464-char SET_INFO metadata limit). Hermetic: a throwaway oracle address is
// passed in, so no real seed / initOracle / network is needed.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { buildSnapshotMetadata, snapshotMetadataLength } from '../src/keetaOracle.js';
import { ASSETS, PRICE_SCALE_DECIMALS } from '../src/config.js';

const require = createRequire(import.meta.url);
const KeetaNet = require('@keetanetwork/keetanet-client');

// Realistic (long) sources list and 5 source reports per pair — the worst-case payload shape.
const ALL_SOURCES = 'bitmart,coinbase,coinpaprika,kraken,mexc';
const REPORTS = ['bitmart', 'coinbase', 'coinpaprika', 'kraken', 'mexc'];

let oracleAddress;
let prices;

before(() => {
  // Throwaway identity only for the `oracle` field length (realistic ~68-char keeta_ address).
  const seed = KeetaNet.lib.Account.generateRandomSeed({ asString: true });
  oracleAddress = KeetaNet.lib.Account.fromSeed(seed, 0).publicKeyString.get();

  const price = 65000.12345678; // long numbers = worst case for size
  prices = {};
  for (const a of ASSETS) {
    prices[a.pair] = {
      pair: a.pair, symbol: a.symbol, price: String(price), priceScaled: String(Math.round(price * 10 ** PRICE_SCALE_DECIMALS)),
      priceScaleDecimals: PRICE_SCALE_DECIMALS, quoteCurrency: 'USD', method: 'median', sources: ALL_SOURCES,
      liveSourceCount: REPORTS.length, stale: false, updatedAt: '2026-07-18T16:31:44.646Z',
      sourceReports: REPORTS.map((name) => ({ name, price: String(price) })),
    };
  }
});

test('representative all-pairs snapshot metadata stays under 5000 chars', () => {
  const size = snapshotMetadataLength(prices, '2026-07-18T16:31:44.646Z', oracleAddress);
  assert.ok(size < 5000, `snapshot metadata length ${size} must be < 5000`);
});

test('snapshot metadata is well-formed and TWAP is NOT embedded on-chain', () => {
  const snap = buildSnapshotMetadata(prices, '2026-07-18T16:31:44.646Z', oracleAddress);
  assert.equal(snap.type, 'price-snapshot');
  assert.equal(snap.oracle, oracleAddress);
  assert.equal(snap.aggregation, 'median');
  assert.equal(Object.keys(snap.prices).length, ASSETS.length);
  // Size discipline: no TWAP / timestamps-per-source / quote labels bloat the on-chain object.
  const json = JSON.stringify(snap);
  assert.ok(!/twap/i.test(json), 'TWAP must stay API-only, never on-chain');
});
