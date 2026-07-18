// Price-oracle anchor entrypoint. TESTNET ONLY.
import { NETWORK, PORT, PUBLISH_EVAL_INTERVAL_MS, MONITOR_INTERVAL_MS, VERSION } from './config.js';
import { pollOnce, startPolling, getCache } from './priceFeed.js';
import { initOracle, publishDiscovery } from './keetaOracle.js';
import { initTimeseries } from './timeseries.js';
import { evaluateAndMaybePublish, pushFeedConfig, getPublishHealth } from './pushFeed.js';
import { initAlerter, runAlertCycle, sendStartupAlert } from './alerter.js';
import { createServer } from './server.js';

function hardFailIfNotTest() {
  if (NETWORK !== 'test') {
    console.error(`[oracle] FATAL: network is '${NETWORK}', but this oracle is TESTNET ONLY. Exiting.`);
    process.exit(1);
  }
}

// Build the health snapshot the alerter evaluates (distinct live sources, per-pair stale +
// disagreement, and the last publish outcome). Read-only over the current cache.
function buildHealth() {
  const cache = getCache();
  const pairs = {};
  const liveSources = new Set();
  for (const e of Object.values(cache.prices)) {
    // Only surface disagreement for a fresh pair; a stale pair alerts as stale, not as disagreement.
    const confidencePct = !e.stale && e.confidencePct != null ? Number(e.confidencePct) : null;
    pairs[e.pair] = { stale: !!e.stale, confidencePct };
    for (const r of e.sourceReports || []) liveSources.add(r.name);
  }
  return { liveSourceCount: liveSources.size, pairs, publishOk: getPublishHealth().ok };
}

async function main() {
  hardFailIfNotTest();

  const { address } = await initOracle();
  console.log(`[oracle] identity: ${address}`);
  console.log(`[oracle] network: test (hard-fail on any other network)`);

  // Persisted TWAP time-series (survives restarts; on Railway points at a mounted volume).
  const { path: dbPath } = initTimeseries();
  console.log(`[oracle] timeseries db: ${dbPath}`);

  // Warm the cache before serving / publishing.
  await pollOnce();
  console.log(`[oracle] initial prices: ${Object.keys(getCache().prices).join(', ')}`);
  startPolling();

  // Discovery metadata (second SET_INFO, services.oracle) once at startup.
  try {
    const { blockHash: dHash, previous: dPrev } = await publishDiscovery();
    console.log(`[oracle] discovery SET_INFO block: ${dHash} (previous: ${dPrev})`);
  } catch (e) {
    console.error('[oracle] discovery publish failed:', e.message);
  }

  // On-chain PUSH feed: publish when a heartbeat interval elapses OR any pair deviates past a
  // threshold vs its last on-chain price — bounded by a min interval + max/hour (see config.js).
  const cfg = pushFeedConfig();
  console.log(
    `[oracle] push feed: heartbeat=${cfg.heartbeatSeconds}s, deviation>${cfg.deviationThresholdPct}%, ` +
      `minInterval=${cfg.minPublishIntervalSeconds}s, maxPerHour=${cfg.maxPublishesPerHour}, ` +
      `eval every ${Math.round(PUBLISH_EVAL_INTERVAL_MS / 1000)}s`,
  );
  // Evaluate once now (first run publishes to establish the baseline), then on the eval tick.
  await evaluateAndMaybePublish();
  setInterval(() => { evaluateAndMaybePublish(); }, PUBLISH_EVAL_INTERVAL_MS);

  // Internal monitoring + alerting (additive; observes health only). Fires on state transitions to
  // a configurable Discord webhook; disabled/log-only when ALERT_WEBHOOK_URL is unset.
  const { enabled } = initAlerter();
  const health0 = buildHealth();
  console.log(
    `[oracle] alerting: ${enabled ? 'enabled (ALERT_WEBHOOK_URL set)' : 'disabled (ALERT_WEBHOOK_URL unset — log only)'} | ` +
      `monitor every ${Math.round(MONITOR_INTERVAL_MS / 1000)}s`,
  );
  sendStartupAlert(VERSION, health0.liveSourceCount); // one-shot restart notice (fire-and-forget)
  setInterval(() => { runAlertCycle(buildHealth()); }, MONITOR_INTERVAL_MS); // fire-and-forget; never blocks

  const app = createServer();
  app.listen(PORT, () => console.log(`[oracle] HTTP listening on http://localhost:${PORT}`));
}

main().catch((e) => {
  console.error('[oracle] FATAL:', e.message);
  process.exit(1);
});
