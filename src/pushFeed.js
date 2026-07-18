// On-chain PUSH feed: decides WHEN to publish an on-chain snapshot, and publishes a coherent
// batch of all pairs when a trigger fires.
//
// Triggers (evaluated every PUBLISH_EVAL_INTERVAL_MS):
//   (a) HEARTBEAT  — a heartbeat interval has elapsed since the last on-chain publish (global), OR
//   (b) DEVIATION  — any pair's current median moved > DEVIATION_THRESHOLD_PCT vs that pair's
//                    LAST-PUBLISHED-ON-CHAIN price (per pair; baseline persisted in SQLite).
//   First run (no baseline at all) -> publish once to establish the baseline.
//
// Frequency bounds (fee cap), which NO trigger may bypass:
//   - MIN_PUBLISH_INTERVAL_SECONDS between publishes. A deviation that fires faster than this is
//     COALESCED: we skip now and publish once on the next tick after the interval clears (the
//     deviation is still present because the baseline only advances on a successful publish).
//   - MAX_PUBLISHES_PER_HOUR hard cap (rolling 1h window).
//
// Every publish routes through keetaOracle.publishSnapshot -> the existing serialized, self-healing
// publishSetInfo (single-writer safe). Baselines advance ONLY after a publish actually lands.
import {
  HEARTBEAT_SECONDS,
  DEVIATION_THRESHOLD_PCT,
  MIN_PUBLISH_INTERVAL_SECONDS,
  MAX_PUBLISHES_PER_HOUR,
} from './config.js';
import { getCache } from './priceFeed.js';
import { publishSnapshot, snapshotMetadataLength } from './keetaOracle.js';
import { getAllLastPublished, setLastPublishedBatch, getMeta, setMeta } from './timeseries.js';

const HEARTBEAT_MS = HEARTBEAT_SECONDS * 1000;
const MIN_INTERVAL_MS = MIN_PUBLISH_INTERVAL_SECONDS * 1000;
const DEVIATION_FRACTION = DEVIATION_THRESHOLD_PCT / 100;
const HOUR_MS = 3_600_000;

const META_LAST_PUBLISH_TS = 'last_publish_ts';

// Rolling window of recent publish timestamps (ms) for the per-hour cap. In-memory: the cap is a
// fee guard, not a correctness invariant, so it need not survive restarts (the heartbeat-derived
// cadence is well under the cap anyway).
let publishTimes = [];
// Guard so two overlapping evaluator ticks can't both decide to publish at once.
let evaluating = false;

function recentPublishCount(now) {
  publishTimes = publishTimes.filter((t) => now - t < HOUR_MS);
  return publishTimes.length;
}

// Numeric last-published timestamp (global). Persisted so heartbeat/min-interval survive restarts.
function lastPublishTs() {
  const v = Number(getMeta(META_LAST_PUBLISH_TS));
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Currently-priced (non-null) pairs from the cache, as { pair -> numeric price }.
// Includes stale pairs carrying a last-good price (their on-chain published price is that value).
function pricedPairs(cache) {
  const out = {};
  for (const [pair, e] of Object.entries(cache.prices || {})) {
    if (e && e.price != null) {
      const n = Number(e.price);
      if (Number.isFinite(n)) out[pair] = n;
    }
  }
  return out;
}

// Decide + publish. Safe to call on a timer: never throws (errors are logged, baseline untouched).
// Returns the trigger reason string when it published, or null when it didn't.
export async function evaluateAndMaybePublish(nowMs = Date.now()) {
  if (evaluating) return null;
  evaluating = true;
  try {
    const cache = getCache();
    const priced = pricedPairs(cache);
    if (!Object.keys(priced).length) {
      // No usable prices yet (cold start / all pairs stale-with-no-history) -> nothing to publish.
      return null;
    }

    const baselines = getAllLastPublished();
    const firstRun = Object.keys(baselines).length === 0;
    const lastTs = lastPublishTs();

    // (a) Heartbeat: elapsed since last on-chain publish (or never published).
    const heartbeatElapsed = lastTs == null || nowMs - lastTs >= HEARTBEAT_MS;

    // (b) Deviation: any priced pair moved > threshold vs its last on-chain price. A currently-priced
    //     pair with NO baseline yet (never published) is also "due" so it gets onto the chain.
    const breached = [];
    for (const [pair, price] of Object.entries(priced)) {
      const b = baselines[pair];
      if (!b || !(b.price > 0)) {
        if (!firstRun) breached.push({ pair, reason: 'no-baseline', from: b?.price ?? null, to: price });
        continue;
      }
      const dev = Math.abs(price - b.price) / b.price;
      if (dev > DEVIATION_FRACTION) {
        breached.push({ pair, reason: 'moved', from: b.price, to: price, devPct: +(dev * 100).toFixed(4) });
      }
    }

    const triggerHeartbeat = !firstRun && heartbeatElapsed;
    const triggerDeviation = breached.length > 0;

    if (!firstRun && !triggerHeartbeat && !triggerDeviation) {
      return null; // no trigger active
    }

    // Frequency floor (coalesce). Never blocks the first-ever publish. Because HEARTBEAT >= MIN
    // interval, this can only ever defer a deviation-triggered publish — exactly the burst case.
    if (!firstRun && lastTs != null && nowMs - lastTs < MIN_INTERVAL_MS) {
      const waitS = Math.ceil((MIN_INTERVAL_MS - (nowMs - lastTs)) / 1000);
      console.log(
        `[push] trigger active (${triggerDeviation ? 'deviation' : 'heartbeat'}) but within min interval; ` +
          `coalescing — will publish in ~${waitS}s. breached=${breached.map((b) => b.pair).join(',') || 'none'}`,
      );
      return null;
    }

    // Per-hour fee cap (also never blocks the first-ever publish).
    if (!firstRun) {
      const count = recentPublishCount(nowMs);
      if (count >= MAX_PUBLISHES_PER_HOUR) {
        console.warn(`[push] rate cap hit: ${count}/${MAX_PUBLISHES_PER_HOUR} publishes in the last hour; skipping this trigger`);
        return null;
      }
    }

    // Compose the human-readable trigger reason for the log.
    const reasons = [];
    if (firstRun) reasons.push('first-run baseline');
    if (triggerHeartbeat) reasons.push(`heartbeat (${Math.round((nowMs - (lastTs ?? nowMs)) / 1000)}s since last publish)`);
    if (triggerDeviation) {
      const detail = breached
        .map((b) => (b.reason === 'moved' ? `${b.pair} ${b.devPct}% (${b.from}->${b.to})` : `${b.pair} no-baseline`))
        .join(', ');
      reasons.push(`deviation [${detail}]`);
    }
    const reason = reasons.join(' + ');

    // Measure the on-chain payload BEFORE publishing (size rule #2: must stay < 5000).
    const size = snapshotMetadataLength(cache.prices, new Date(nowMs).toISOString());
    console.log(`[push] TRIGGER -> ${reason} | snapshotMetadataLength=${size} (limit 5000)`);
    if (size >= 5000) {
      console.error(`[push] ABORT: snapshot metadata ${size} >= 5000 char safety limit; not publishing`);
      return null;
    }

    // Publish the coherent batch of ALL pairs through the serialized, self-healing publisher.
    const { blockHash, previous } = await publishSnapshot(cache.prices);

    // Success -> advance baselines (per priced pair) + the global last-publish ts, atomically.
    setLastPublishedBatch(Object.entries(priced), nowMs);
    setMeta(META_LAST_PUBLISH_TS, nowMs);
    publishTimes.push(nowMs);

    console.log(
      `[push] published snapshot SET_INFO block: ${blockHash} (previous: ${previous}) | ` +
        `trigger=${firstRun ? 'first-run' : triggerDeviation && triggerHeartbeat ? 'heartbeat+deviation' : triggerDeviation ? 'deviation' : 'heartbeat'} | ` +
        `size=${size} | publishes/hr=${recentPublishCount(nowMs)}/${MAX_PUBLISHES_PER_HOUR}`,
    );
    return reason;
  } catch (e) {
    console.error('[push] evaluate/publish failed:', e.message);
    return null;
  } finally {
    evaluating = false;
  }
}

// Expose the resolved trigger config for a one-line startup banner (log evidence of the config).
export function pushFeedConfig() {
  return {
    heartbeatSeconds: HEARTBEAT_SECONDS,
    deviationThresholdPct: DEVIATION_THRESHOLD_PCT,
    minPublishIntervalSeconds: MIN_PUBLISH_INTERVAL_SECONDS,
    maxPublishesPerHour: MAX_PUBLISHES_PER_HOUR,
  };
}
