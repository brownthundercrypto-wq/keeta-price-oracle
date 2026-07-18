// API rate limiting (abuse protection). ADDITIVE — it only gates request admission on the POST
// endpoints; it never touches signing, aggregation, or publishing.
//
// Algorithm: token bucket. Each bucket refills continuously at `ratePerMin` tokens/minute up to a
// max of `capacity` (the burst). A request costs 1 token; if the bucket is empty the request is
// rejected with a Retry-After. Two buckets are checked per request: the caller's per-IP bucket
// (fairness) and one shared global bucket (instance protection). A request is admitted only if BOTH
// have a token, and consumes from both only when admitted.
//
// State is IN-MEMORY — correct for a single instance (the current deploy: numReplicas: 1). Multi-
// instance (Tier 3) would need shared state (e.g. Redis) so limits are enforced across replicas.
import { RATE_LIMIT_PER_MIN, RATE_LIMIT_BURST, RATE_LIMIT_GLOBAL_PER_MIN } from './config.js';

// Refill a bucket to `now`. A missing bucket starts full. Pure (returns a new bucket).
function refill(bucket, now, capacity, ratePerMin) {
  const b = bucket || { tokens: capacity, last: now };
  const perMs = ratePerMin / 60_000;
  const elapsed = Math.max(0, now - b.last);
  const tokens = Math.min(capacity, b.tokens + elapsed * perMs);
  return { tokens, last: now };
}

// Whole seconds until the bucket has >= 1 token again (min 1). Pure.
function retryAfterSeconds(tokens, ratePerMin) {
  const perSec = ratePerMin / 60;
  if (perSec <= 0) return 60;
  return Math.max(1, Math.ceil((1 - tokens) / perSec));
}

// PURE limiter decision: (per-IP bucket + global bucket + now + cfg) -> admission + updated buckets.
// `cfg` = { perMin, burst, globalPerMin, globalBurst }. Never mutates the input buckets.
// Returns { allowed, retryAfter, reason:'per-ip'|'global'|'both'|null, bucket, global }.
export function decideRateLimit({ now, bucket, global, cfg }) {
  const perBucket = refill(bucket, now, cfg.burst, cfg.perMin);
  const gBucket = refill(global, now, cfg.globalBurst, cfg.globalPerMin);
  const perOk = perBucket.tokens >= 1;
  const gOk = gBucket.tokens >= 1;
  const allowed = perOk && gOk;

  let retryAfter = 0;
  let reason = null;
  if (allowed) {
    perBucket.tokens -= 1;
    gBucket.tokens -= 1;
  } else {
    if (!perOk) {
      reason = 'per-ip';
      retryAfter = Math.max(retryAfter, retryAfterSeconds(perBucket.tokens, cfg.perMin));
    }
    if (!gOk) {
      reason = reason ? 'both' : 'global';
      retryAfter = Math.max(retryAfter, retryAfterSeconds(gBucket.tokens, cfg.globalPerMin));
    }
  }
  return { allowed, retryAfter, reason, bucket: perBucket, global: gBucket };
}

// Resolve the real client IP behind Railway's proxy. X-Forwarded-For is "client, proxy1, proxy2, …"
// with the ORIGINATING client leftmost; the socket address would just be the proxy (every request
// would look identical), so we read XFF. Falls back safely when XFF is absent. (Per-IP keying is
// best-effort — a client can spoof the leftmost XFF entry — but the GLOBAL cap still bounds abuse.)
export function getClientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  if (Array.isArray(xff) && xff.length) {
    const first = String(xff[0]).split(',')[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

// Resolve config (env defaults, or overrides for tests). globalBurst = one minute's worth.
export function rateLimitConfig(overrides = {}) {
  return {
    perMin: overrides.perMin ?? RATE_LIMIT_PER_MIN,
    burst: overrides.burst ?? RATE_LIMIT_BURST,
    globalPerMin: overrides.globalPerMin ?? RATE_LIMIT_GLOBAL_PER_MIN,
    globalBurst: overrides.globalBurst ?? RATE_LIMIT_GLOBAL_PER_MIN,
  };
}

// Build an Express middleware that enforces the limiter. In-memory state (single instance). Prunes
// fully-replenished buckets periodically so memory can't grow unbounded with unique IPs.
export function createRateLimiter(overrides = {}) {
  const cfg = rateLimitConfig(overrides);
  const state = { buckets: new Map(), global: undefined };
  let reqCount = 0;

  const maybePrune = (now) => {
    if (++reqCount % 256 !== 0) return;
    for (const [key, b] of state.buckets) {
      // A bucket that has fully refilled carries no useful state — a fresh request recreates it
      // identically — so it can be forgotten. (`now` clock only moves forward here.)
      if (refill(b, now, cfg.burst, cfg.perMin).tokens >= cfg.burst) state.buckets.delete(key);
    }
  };

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const key = getClientIp(req);
    const decision = decideRateLimit({ now, bucket: state.buckets.get(key), global: state.global, cfg });
    state.buckets.set(key, decision.bucket);
    state.global = decision.global;
    maybePrune(now);

    if (decision.allowed) return next();

    // 429 — small JSON body, Retry-After header, no internals leaked (no IP, no bucket state).
    res.set('Retry-After', String(decision.retryAfter));
    return res.status(429).json({
      ok: false,
      error: 'rate limited: too many requests, please slow down',
      retryAfter: decision.retryAfter,
    });
  };
}
