// Static configuration for the price-oracle anchor. TESTNET ONLY.

export const VERSION = '2.0.0'; // multi-source aggregation + signed provenance + /proof

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
export const PUBLISH_INTERVAL_MS = 5 * 60_000;   // publish an on-chain SET_INFO snapshot every 5 min

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
