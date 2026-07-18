// (Level-1 monitoring) ALERT DECISION LOGIC — pure, hermetic (no webhook, no network, no timers).
// Fires on state transition (bad once, recover once), does NOT re-fire while bad, respects the
// re-alert cooldown, and tracks each condition/pair independently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAlerts, formatAlert, sendAlert } from '../src/alerter.js';

const CFG = { minSources: 3, disagreementPct: 2, realertMs: 60 * 60_000 }; // 60-min cooldown
const healthySources = { liveSourceCount: 5, pairs: {}, publishOk: true };
const lowSources = { liveSourceCount: 2, pairs: {}, publishOk: true };
const only = (alerts, key) => alerts.filter((a) => a.key === key);

// ── transition semantics on the global sources floor ─────────────────────────────────────────────
test('fires ONCE when a condition goes bad (ok -> bad)', () => {
  const { alerts, state } = decideAlerts(lowSources, {}, 1000, CFG);
  const s = only(alerts, 'sources');
  assert.equal(s.length, 1);
  assert.equal(s[0].transition, 'bad');
  assert.equal(state.sources.status, 'bad');
});

test('does NOT re-fire while it stays bad (within cooldown)', () => {
  const first = decideAlerts(lowSources, {}, 1000, CFG);
  const second = decideAlerts(lowSources, first.state, 1000 + 5 * 60_000, CFG); // 5 min later
  assert.equal(only(second.alerts, 'sources').length, 0);
  assert.equal(second.state.sources.status, 'bad');
});

test('fires ONCE on recovery (bad -> ok)', () => {
  const bad = decideAlerts(lowSources, {}, 1000, CFG);
  const rec = decideAlerts(healthySources, bad.state, 2000, CFG);
  const s = only(rec.alerts, 'sources');
  assert.equal(s.length, 1);
  assert.equal(s[0].transition, 'recover');
  assert.equal(rec.state.sources.status, 'ok');
});

test('sends a single reminder after the cooldown, then goes quiet again', () => {
  const cfg = { ...CFG, realertMs: 1000 };
  const t0 = decideAlerts(lowSources, {}, 0, cfg); // bad
  assert.equal(only(t0.alerts, 'sources')[0].transition, 'bad');
  const beforeCooldown = decideAlerts(lowSources, t0.state, 999, cfg); // still bad, < cooldown
  assert.equal(only(beforeCooldown.alerts, 'sources').length, 0);
  const atCooldown = decideAlerts(lowSources, beforeCooldown.state, 1000, cfg); // reminder due
  assert.equal(only(atCooldown.alerts, 'sources')[0].transition, 'reminder');
  const afterReminder = decideAlerts(lowSources, atCooldown.state, 1500, cfg); // quiet again
  assert.equal(only(afterReminder.alerts, 'sources').length, 0);
});

test('cooldown disabled (realertMs = 0) never sends reminders', () => {
  const cfg = { ...CFG, realertMs: 0 };
  let st = decideAlerts(lowSources, {}, 0, cfg).state;
  for (const t of [10_000, 100_000, 1_000_000]) {
    const r = decideAlerts(lowSources, st, t, cfg);
    assert.equal(only(r.alerts, 'sources').length, 0);
    st = r.state;
  }
});

// ── per-condition coverage ───────────────────────────────────────────────────────────────────────
test('a pair going stale fires, and recovers when fresh again', () => {
  const staleH = { liveSourceCount: 5, pairs: { 'KTA-USD': { stale: true, confidencePct: null } }, publishOk: true };
  const freshH = { liveSourceCount: 5, pairs: { 'KTA-USD': { stale: false, confidencePct: 0.1 } }, publishOk: true };
  const bad = decideAlerts(staleH, {}, 1, CFG);
  assert.equal(only(bad.alerts, 'stale:KTA-USD')[0].transition, 'bad');
  const rec = decideAlerts(freshH, bad.state, 2, CFG);
  assert.equal(only(rec.alerts, 'stale:KTA-USD')[0].transition, 'recover');
});

test('high disagreement fires above the threshold (>2%) and is a warning, not critical', () => {
  const hi = { liveSourceCount: 5, pairs: { 'BTC-USD': { stale: false, confidencePct: 3.5 } }, publishOk: true };
  const lo = { liveSourceCount: 5, pairs: { 'BTC-USD': { stale: false, confidencePct: 1.0 } }, publishOk: true };
  const bad = decideAlerts(hi, {}, 1, CFG);
  const d = only(bad.alerts, 'disagree:BTC-USD');
  assert.equal(d[0].transition, 'bad');
  assert.equal(d[0].severity, 'warning');
  // exactly at the threshold is NOT bad (strictly greater-than)
  const atThreshold = decideAlerts({ ...lo, pairs: { 'BTC-USD': { stale: false, confidencePct: 2 } } }, {}, 1, CFG);
  assert.equal(only(atThreshold.alerts, 'disagree:BTC-USD').length, 0);
  // recovers below threshold
  const rec = decideAlerts(lo, bad.state, 2, CFG);
  assert.equal(only(rec.alerts, 'disagree:BTC-USD')[0].transition, 'recover');
});

test('publish failure fires; recovers when a snapshot lands; unknown (null) is not evaluated', () => {
  const failing = { liveSourceCount: 5, pairs: {}, publishOk: false };
  const ok = { liveSourceCount: 5, pairs: {}, publishOk: true };
  const unknown = { liveSourceCount: 5, pairs: {}, publishOk: null };
  assert.equal(only(decideAlerts(unknown, {}, 1, CFG).alerts, 'publish').length, 0);
  const bad = decideAlerts(failing, {}, 1, CFG);
  assert.equal(only(bad.alerts, 'publish')[0].transition, 'bad');
  const rec = decideAlerts(ok, bad.state, 2, CFG);
  assert.equal(only(rec.alerts, 'publish')[0].transition, 'recover');
});

test('individual source fetch errors do NOT alert — only the liveSourceCount floor does', () => {
  // liveSourceCount still >= floor even though some sources are missing -> no alert.
  const stillOk = { liveSourceCount: 3, pairs: {}, publishOk: true };
  assert.equal(decideAlerts(stillOk, {}, 1, CFG).alerts.length, 0);
});

test('conditions are tracked independently (one bad does not mask another)', () => {
  const h = {
    liveSourceCount: 2, // sources bad
    pairs: { 'KTA-USD': { stale: true, confidencePct: null }, 'ETH-USD': { stale: false, confidencePct: 9 } },
    publishOk: false, // publish bad
  };
  const { alerts, state } = decideAlerts(h, {}, 1, CFG);
  const keys = alerts.map((a) => a.key).sort();
  assert.deepEqual(keys, ['disagree:ETH-USD', 'publish', 'sources', 'stale:KTA-USD']);
  assert.equal(state.sources.status, 'bad');
  assert.equal(state['stale:KTA-USD'].status, 'bad');
});

test('decideAlerts does not mutate the prior state object', () => {
  const prior = {};
  decideAlerts(lowSources, prior, 1, CFG);
  assert.deepEqual(prior, {}, 'prior state must be treated as immutable');
});

// ── sender safety (hermetic: no webhook configured -> no network) ─────────────────────────────────
test('sendAlert with no webhook is disabled (log-only) and never throws', async () => {
  const r = await sendAlert('hello', { url: '' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'no-webhook');
});

test('formatAlert prefixes the oracle tag', () => {
  const line = formatAlert({ message: '🔴 something' });
  assert.match(line, /^\[keeta-price-oracle testnet\] /);
});
