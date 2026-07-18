// (Level-1 abuse protection) RATE LIMITER — pure token-bucket decision, hermetic (no server, no
// network, deterministic clock passed in). Allows under limit, blocks over, refills over time,
// per-IP isolation, global cap; plus X-Forwarded-For client-IP parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRateLimit, getClientIp, rateLimitConfig } from '../src/rateLimit.js';

// Small helper mirroring the middleware's per-key state map + shared global bucket.
function harness(cfg) {
  const state = { buckets: new Map(), global: undefined };
  return (key, now) => {
    const r = decideRateLimit({ now, bucket: state.buckets.get(key), global: state.global, cfg });
    state.buckets.set(key, r.bucket);
    state.global = r.global;
    return r;
  };
}

test('allows requests up to the burst, then blocks with a Retry-After', () => {
  const cfg = { perMin: 60, burst: 5, globalPerMin: 100000, globalBurst: 100000 };
  const hit = harness(cfg);
  for (let i = 0; i < 5; i++) assert.equal(hit('ip1', 0).allowed, true, `req ${i + 1} should pass`);
  const blocked = hit('ip1', 0);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'per-ip');
  assert.ok(blocked.retryAfter >= 1, 'Retry-After must be a positive integer seconds');
});

test('refills over time: a blocked client is allowed again after the bucket refills', () => {
  const cfg = { perMin: 60, burst: 5, globalPerMin: 100000, globalBurst: 100000 }; // 1 token/sec
  const hit = harness(cfg);
  for (let i = 0; i < 5; i++) hit('ip1', 0);
  assert.equal(hit('ip1', 0).allowed, false); // empty
  assert.equal(hit('ip1', 999).allowed, false); // <1s later: still < 1 token
  assert.equal(hit('ip1', 1000).allowed, true); // 1s later: exactly 1 token refilled
  assert.equal(hit('ip1', 1000).allowed, false); // and spent again
});

test('per-IP isolation: one client hitting the limit does not affect another', () => {
  const cfg = { perMin: 60, burst: 2, globalPerMin: 100000, globalBurst: 100000 };
  const hit = harness(cfg);
  assert.equal(hit('A', 0).allowed, true);
  assert.equal(hit('A', 0).allowed, true);
  assert.equal(hit('A', 0).allowed, false); // A is throttled
  assert.equal(hit('B', 0).allowed, true); // B is unaffected
  assert.equal(hit('B', 0).allowed, true);
  assert.equal(hit('B', 0).allowed, false);
});

test('global cap protects the instance across all clients', () => {
  // Per-IP is effectively unlimited here; the shared global bucket is the constraint.
  const cfg = { perMin: 100000, burst: 100000, globalPerMin: 60, globalBurst: 3 };
  const hit = harness(cfg);
  assert.equal(hit('A', 0).allowed, true);
  assert.equal(hit('B', 0).allowed, true);
  assert.equal(hit('C', 0).allowed, true);
  const blocked = hit('D', 0); // 4th distinct client, global exhausted
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'global');
});

test('normal use is never limited: steady polling stays under the burst', () => {
  const cfg = rateLimitConfig(); // real defaults (60/min, burst 30, global 600)
  const hit = harness(cfg);
  // A dashboard polling all 5 pairs every 10s -> 5 requests per tick, well within burst + refill.
  let now = 0;
  for (let tick = 0; tick < 20; tick++) {
    for (let p = 0; p < 5; p++) assert.equal(hit('dash', now).allowed, true, `tick ${tick} pair ${p}`);
    now += 10_000;
  }
});

test('decideRateLimit does not mutate the input buckets', () => {
  const cfg = { perMin: 60, burst: 5, globalPerMin: 100, globalBurst: 100 };
  const bucket = { tokens: 5, last: 0 };
  const global = { tokens: 100, last: 0 };
  decideRateLimit({ now: 0, bucket, global, cfg });
  assert.equal(bucket.tokens, 5, 'per-ip bucket must be immutable');
  assert.equal(global.tokens, 100, 'global bucket must be immutable');
});

// ── client IP resolution (X-Forwarded-For) ───────────────────────────────────────────────────────
test('getClientIp reads the originating client from X-Forwarded-For (leftmost), not the socket', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' }, socket: { remoteAddress: '10.0.0.9' } };
  assert.equal(getClientIp(req), '203.0.113.7');
});

test('getClientIp falls back to the socket address when XFF is missing', () => {
  const req = { headers: {}, socket: { remoteAddress: '198.51.100.4' } };
  assert.equal(getClientIp(req), '198.51.100.4');
});

test('getClientIp handles a missing socket safely (never throws)', () => {
  assert.equal(getClientIp({ headers: {} }), 'unknown');
  assert.equal(getClientIp({ headers: { 'x-forwarded-for': '   ' }, socket: {} }), 'unknown');
});

test('two different client IPs get independent buckets even via XFF', () => {
  const cfg = { perMin: 60, burst: 1, globalPerMin: 100000, globalBurst: 100000 };
  const hit = harness(cfg);
  const ipA = getClientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 10.0.0.1' } });
  const ipB = getClientIp({ headers: { 'x-forwarded-for': '2.2.2.2, 10.0.0.1' } });
  assert.equal(hit(ipA, 0).allowed, true);
  assert.equal(hit(ipA, 0).allowed, false);
  assert.equal(hit(ipB, 0).allowed, true); // different real client -> own bucket
});
