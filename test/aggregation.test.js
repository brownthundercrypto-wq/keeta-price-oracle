// (3) OUTLIER GUARD, (4) STALE STATE, (5) CONFIDENCE — pure aggregation core, no network / chain / db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, guardOutliers, computeConfidence } from '../src/priceFeed.js';
import { MIN_SOURCES, OUTLIER_THRESHOLD } from '../src/config.js';

const rows = (...prices) => prices.map((p, i) => ({ name: String.fromCharCode(97 + i), price: p, quote: 'USD', ts: 't' }));
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// ── (3) OUTLIER GUARD ───────────────────────────────────────────────────────────────────────────
test('outlier guard: a source beyond the threshold is dropped and the median recomputed over survivors', () => {
  // center = median([100,101,99,200]) = 100.5; the 200 print is ~99% away -> dropped.
  const used = rows(100, 101, 99, 200);
  const { center, survivors, outliers } = guardOutliers(used, OUTLIER_THRESHOLD);
  close(center, 100.5);
  assert.equal(survivors.length, 3);
  assert.equal(outliers.length, 1);
  assert.equal(outliers[0].price, 200);
  assert.ok(outliers[0].dev > OUTLIER_THRESHOLD);
  // Republished median is over survivors only (100), NOT the pre-guard center (100.5).
  assert.equal(median(survivors.map((s) => s.price)), 100);
});

test('outlier guard: all sources in tight agreement -> none dropped', () => {
  const used = rows(100, 100.1, 99.9, 100.05);
  const { survivors, outliers } = guardOutliers(used, OUTLIER_THRESHOLD);
  assert.equal(outliers.length, 0);
  assert.equal(survivors.length, 4);
});

// ── (4) STALE STATE (never a single-source number) ───────────────────────────────────────────────
test('stale: after the guard, fewer than MIN_SOURCES survivors signals stale (never single-source)', () => {
  // Two sources far apart: center = 150, both ~33% away -> both dropped -> 0 survivors.
  const { survivors } = guardOutliers(rows(100, 200), OUTLIER_THRESHOLD);
  assert.ok(survivors.length < MIN_SOURCES, 'guard leaving < MIN_SOURCES must be treated as stale');
});

test('stale: a single live source is below MIN_SOURCES (the pre-guard stale condition)', () => {
  const used = rows(123.45);
  assert.ok(used.length < MIN_SOURCES);
  // Even so, the guard itself does not throw on one row (graceful).
  const { survivors, outliers } = guardOutliers(used, OUTLIER_THRESHOLD);
  assert.equal(survivors.length, 1);
  assert.equal(outliers.length, 0);
});

test('graceful drop: empty / malformed-filtered inputs do not crash aggregation', () => {
  // Sources that errored or returned non-finite prices never reach `used`; aggregation must still
  // handle an empty or single-row set without throwing.
  assert.doesNotThrow(() => guardOutliers([], OUTLIER_THRESHOLD));
  const empty = guardOutliers([], OUTLIER_THRESHOLD);
  assert.equal(empty.survivors.length, 0);
  assert.equal(empty.outliers.length, 0);
  assert.doesNotThrow(() => median([]));
});

// ── (5) CONFIDENCE (band + %) ────────────────────────────────────────────────────────────────────
test('confidence: band = population std-dev, % = band relative to the median', () => {
  // prices [100, 100, 106]: mean 102, variance = ((-2)^2+(-2)^2+(4)^2)/3 = 24/3 = 8, std = sqrt(8).
  const prices = [100, 100, 106];
  const { band, pct } = computeConfidence(prices);
  close(band, Math.sqrt(8));
  const med = median(prices); // 100
  close(pct, (Math.sqrt(8) / med) * 100);
});

test('confidence: identical sources -> zero band and zero percent (perfect agreement)', () => {
  const { band, pct } = computeConfidence([50, 50, 50]);
  assert.equal(band, 0);
  assert.equal(pct, 0);
});
