// (9) PUSH-FEED TRIGGERS (pure logic) — deviation fires when a pair moves > threshold vs its
// last-published baseline; heartbeat fires after the interval; min-interval + max/hour bounds hold.
// Hermetic: decidePublish is pure (no cache / db / chain).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePublish } from '../src/pushFeed.js';

// Explicit thresholds so the test is independent of env-derived defaults.
const CFG = { heartbeatMs: 1_800_000, deviationFraction: 0.005 /* 0.5% */, minIntervalMs: 60_000, maxPerHour: 30 };
const NOW = 1_000_000_000;

test('deviation: a pair moving > threshold vs its baseline triggers a publish', () => {
  const d = decidePublish(
    { priced: { 'KTA-USD': 100.6 }, baselines: { 'KTA-USD': { price: 100, ts: 0 } }, lastPublishTs: NOW - 120_000, now: NOW },
    CFG,
  );
  assert.equal(d.publish, true);
  assert.equal(d.triggerDeviation, true);
  assert.equal(d.triggerHeartbeat, false); // heartbeat window not elapsed
  assert.equal(d.breached[0].pair, 'KTA-USD');
  assert.equal(d.breached[0].reason, 'moved');
});

test('deviation: a move under the threshold does NOT trigger', () => {
  const d = decidePublish(
    { priced: { 'KTA-USD': 100.4 }, baselines: { 'KTA-USD': { price: 100, ts: 0 } }, lastPublishTs: NOW - 120_000, now: NOW },
    CFG,
  );
  assert.equal(d.publish, false);
  assert.equal(d.reason, 'no-trigger');
  assert.equal(d.triggerDeviation, false);
});

test('heartbeat: fires after the interval even with zero price movement', () => {
  const d = decidePublish(
    { priced: { 'KTA-USD': 100 }, baselines: { 'KTA-USD': { price: 100, ts: 0 } }, lastPublishTs: NOW - (CFG.heartbeatMs + 1), now: NOW },
    CFG,
  );
  assert.equal(d.publish, true);
  assert.equal(d.triggerHeartbeat, true);
  assert.equal(d.triggerDeviation, false);
});

test('heartbeat: does NOT fire before the interval elapses (and no deviation)', () => {
  const d = decidePublish(
    { priced: { 'KTA-USD': 100 }, baselines: { 'KTA-USD': { price: 100, ts: 0 } }, lastPublishTs: NOW - (CFG.heartbeatMs - 1), now: NOW },
    CFG,
  );
  assert.equal(d.publish, false);
  assert.equal(d.reason, 'no-trigger');
});

test('min-interval: a deviation firing faster than the floor is COALESCED (deferred), not published', () => {
  const d = decidePublish(
    { priced: { 'KTA-USD': 100.6 }, baselines: { 'KTA-USD': { price: 100, ts: 0 } }, lastPublishTs: NOW - 1_000, now: NOW },
    CFG,
  );
  assert.equal(d.publish, false);
  assert.equal(d.deferred, true);
  assert.equal(d.triggerDeviation, true); // trigger IS active — just held back by the floor
});

test('min-interval boundary: exactly at the floor is allowed (not < min)', () => {
  const atFloor = decidePublish(
    { priced: { 'KTA-USD': 100.6 }, baselines: { 'KTA-USD': { price: 100, ts: 0 } }, lastPublishTs: NOW - CFG.minIntervalMs, now: NOW },
    CFG,
  );
  assert.equal(atFloor.publish, true);
  const justUnder = decidePublish(
    { priced: { 'KTA-USD': 100.6 }, baselines: { 'KTA-USD': { price: 100, ts: 0 } }, lastPublishTs: NOW - (CFG.minIntervalMs - 1), now: NOW },
    CFG,
  );
  assert.equal(justUnder.publish, false);
  assert.equal(justUnder.deferred, true);
});

test('max/hour: the per-hour cap blocks an otherwise-valid trigger', () => {
  const base = { priced: { 'KTA-USD': 100.6 }, baselines: { 'KTA-USD': { price: 100, ts: 0 } }, lastPublishTs: NOW - 120_000, now: NOW };
  assert.equal(decidePublish({ ...base, recentPublishCount: CFG.maxPerHour - 1 }, CFG).publish, true);
  const capped = decidePublish({ ...base, recentPublishCount: CFG.maxPerHour }, CFG);
  assert.equal(capped.publish, false);
  assert.equal(capped.rateCapped, true);
});

test('first run: no baseline at all publishes once to establish it (bounds do not apply)', () => {
  const d = decidePublish(
    { priced: { 'KTA-USD': 100, 'BTC-USD': 65000 }, baselines: {}, lastPublishTs: null, now: NOW, recentPublishCount: 999 },
    CFG,
  );
  assert.equal(d.publish, true);
  assert.equal(d.firstRun, true);
});

test('a currently-priced pair with no baseline yet is "due" (gets onto the chain)', () => {
  const d = decidePublish(
    {
      priced: { 'BTC-USD': 65000, 'KTA-USD': 0.12 }, // BTC has a baseline, KTA is new
      baselines: { 'BTC-USD': { price: 65000, ts: 0 } },
      lastPublishTs: NOW - 120_000,
      now: NOW,
    },
    CFG,
  );
  assert.equal(d.publish, true);
  assert.equal(d.triggerDeviation, true);
  const kta = d.breached.find((b) => b.pair === 'KTA-USD');
  assert.equal(kta.reason, 'no-baseline');
});

test('no priced pairs -> nothing to publish', () => {
  const d = decidePublish({ priced: {}, baselines: {}, lastPublishTs: null, now: NOW }, CFG);
  assert.equal(d.publish, false);
  assert.equal(d.reason, 'no-priced-pairs');
});
