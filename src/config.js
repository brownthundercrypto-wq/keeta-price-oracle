// Static configuration for the price-oracle anchor. TESTNET ONLY.

export const VERSION = '3.0.0'; // multi-source aggregation + signed provenance + /proof + TWAP + persisted store + push feed

// Minimum number of INDEPENDENT live sources required to publish a (median) price for a pair.
// Fewer than this -> the pair is marked stale rather than publishing a single-source number.
export const MIN_SOURCES = 2;

// Outlier guard: a live source whose value deviates more than this fraction from the median center
// is dropped as a likely-bad print, and the median is recomputed over the survivors.
// Configurable via OUTLIER_THRESHOLD_PCT (percent); default 2%.
export const OUTLIER_THRESHOLD = (() => {
  const pct = Number(process.env.OUTLIER_THRESHOLD_PCT);
  return Number.isFinite(pct) && pct > 0 ? pct / 100 : 0.02;
})();

// The oracle refuses to run on anything other than 'test' (hard-fail in index.js + keetaOracle.js).
export const NETWORK = process.env.KEETA_NETWORK || 'test';

export const PORT = parseInt(process.env.PORT || '9010', 10);

// Public base URL advertised in the discovery SET_INFO metadata (so consumers get the live
// endpoint, not localhost). PUBLIC_URL wins; otherwise Railway auto-injects RAILWAY_PUBLIC_DOMAIN.
// Empty in local dev -> discovery endpoints stay relative.
export const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
).replace(/\/$/, '');

export const POLL_INTERVAL_MS = 60_000;          // fetch CoinGecko every 60s
export const PUBLISH_INTERVAL_MS = 5 * 60_000;   // (legacy) fixed publish cadence — superseded by the push feed below

// ── On-chain PUSH feed (heartbeat + deviation triggers) ─────────────────────────────────────────
// Replaces the fixed publish timer. A fresh on-chain snapshot is published when EITHER a heartbeat
// interval has elapsed since the last on-chain publish, OR any pair's current median has moved more
// than DEVIATION_THRESHOLD_PCT vs that pair's LAST-PUBLISHED-ON-CHAIN price. Publish frequency is
// bounded (min interval + max/hour) to cap on-chain fees; deviations that fire faster than the min
// interval are coalesced into a single publish once the interval clears.
const intEnv = (name, def) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};
const floatEnv = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};

// (a) Heartbeat: always publish at least this often, even with zero price movement. Default 30 min.
export const HEARTBEAT_SECONDS = intEnv('HEARTBEAT_SECONDS', 1800);
// (b) Deviation: publish when any pair's median moves more than this % vs its last on-chain price.
export const DEVIATION_THRESHOLD_PCT = floatEnv('DEVIATION_THRESHOLD_PCT', 0.5);
// Frequency floor: no trigger may publish more often than this (coalesces bursts). Default 60s.
export const MIN_PUBLISH_INTERVAL_SECONDS = intEnv('MIN_PUBLISH_INTERVAL_SECONDS', 60);
// Hard cap on on-chain publishes per rolling hour (fee guard). Default 30.
export const MAX_PUBLISHES_PER_HOUR = intEnv('MAX_PUBLISHES_PER_HOUR', 30);
// How often the trigger evaluator runs. Fine enough to honor the min interval + heartbeat without
// out-pacing the 60s price poll; never coarser than the min interval, never finer than 10s.
export const PUBLISH_EVAL_INTERVAL_MS = Math.max(10_000, Math.min(MIN_PUBLISH_INTERVAL_SECONDS * 1000, POLL_INTERVAL_MS));

// ── Monitoring & alerting (internal health -> optional Discord webhook) ───────────────────────────
// Additive: purely observes the running oracle. Does NOT affect signing / aggregation / publishing.
// The alerter fires on STATE TRANSITIONS only (bad -> once, recovered -> once) with an optional
// reminder after ALERT_REALERT_MINUTES, so a persistent problem does not spam the channel.
//
// ALERT_WEBHOOK_URL is a SECRET — set it in the Railway environment only, never commit it. When it
// is unset, alerting is disabled and conditions are logged locally instead.
export const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';
// Alert when the distinct live-source count across all pairs drops below this floor. Default 3.
export const ALERT_MIN_SOURCES = intEnv('ALERT_MIN_SOURCES', 3);
// Alert when a pair's signed confidencePct (relative source disagreement) exceeds this %. Default 2%.
export const ALERT_DISAGREEMENT_PCT = floatEnv('ALERT_DISAGREEMENT_PCT', 2);
// While a condition stays bad, re-send a single reminder at most this often (minutes). Default 60.
export const ALERT_REALERT_MINUTES = intEnv('ALERT_REALERT_MINUTES', 60);
// How often the health monitor evaluates conditions (well under the ~60s detection goal).
export const MONITOR_INTERVAL_MS = 30_000;

// ── API rate limiting (abuse protection) ─────────────────────────────────────────────────────────
// Additive: token-bucket limiter on the POST endpoints only. Defaults are generous — a human
// curling or a dashboard polling is never limited; only hammering gets 429'd. GET / and /health are
// EXEMPT (so UptimeRobot + the monitor are never throttled). Per-IP protects fairness; the global
// cap protects the instance (and bounds abuse even if a client spoofs X-Forwarded-For).
// Per-client-IP sustained rate (requests/minute) once the burst is spent. Default 60 (1/sec).
export const RATE_LIMIT_PER_MIN = intEnv('RATE_LIMIT_PER_MIN', 60);
// Per-client-IP burst: how many requests a client may make back-to-back before throttling. Default 30.
export const RATE_LIMIT_BURST = intEnv('RATE_LIMIT_BURST', 30);
// Instance-wide cap across ALL clients (requests/minute). Default 600 (10/sec). Its burst capacity is
// a full minute's worth.
export const RATE_LIMIT_GLOBAL_PER_MIN = intEnv('RATE_LIMIT_GLOBAL_PER_MIN', 600);

// TWAP (time-weighted average price) — API-only, NEVER added to the on-chain snapshot.
export const TWAP_WINDOWS = { '1h': 3_600_000, '24h': 86_400_000 };
export const TWAP_LONGEST_MS = Math.max(...Object.values(TWAP_WINDOWS));
// Keep a couple hours beyond the longest window so the carry-in sample (the price active at the
// window's start) isn't pruned.
export const TWAP_RETENTION_MS = TWAP_LONGEST_MS + 2 * 3_600_000;
// Persisted time-series DB. On Railway this points at a mounted volume (DB_PATH=/data/...) so the
// TWAP window survives redeploys. Local default lives under ./data (gitignored).
export const DB_PATH = process.env.DB_PATH || './data/prices.sqlite';

export const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';

// The exact set from the spec.
// IMPORTANT: this oracle reports a USD *price*, not a token amount. It deliberately does NOT
// carry any token's on-chain decimals (e.g. testnet KTA = 9 dp), because that value is
// meaningless for a USD price and conflating the two is a scaling footgun. Price precision is
// a separate concept — see PRICE_SCALE_DECIMALS below.
export const ASSETS = [
  { id: 'keeta',     pair: 'KTA-USD',  symbol: 'KTA'  },
  { id: 'bitcoin',   pair: 'BTC-USD',  symbol: 'BTC'  },
  { id: 'ethereum',  pair: 'ETH-USD',  symbol: 'ETH'  },
  { id: 'usd-coin',  pair: 'USDC-USD', symbol: 'USDC' },
  { id: 'euro-coin', pair: 'EURC-USD', symbol: 'EURC' },
];

// Fixed-point precision for the OPTIONAL integer `priceScaled` form (for on-chain consumers who
// want integer math). This is PRICE precision only — it has nothing to do with any token's
// on-chain decimals. The authoritative value is always the exact decimal `price` STRING.
export const PRICE_SCALE_DECIMALS = 8;

export const COINGECKO_IDS = ASSETS.map((a) => a.id);
export const PAIRS = ASSETS.map((a) => a.pair);
