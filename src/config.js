// Static configuration for the price-oracle anchor. TESTNET ONLY.

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
