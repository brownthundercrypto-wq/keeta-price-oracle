// CoinGecko poller + in-memory price cache.
import { COINGECKO_URL, COINGECKO_IDS, ASSETS, POLL_INTERVAL_MS, PRICE_SCALE_DECIMALS } from './config.js';

let cache = { prices: {}, fetchedAt: null, source: 'coingecko' };
let timer = null;

export function getCache() {
  return cache;
}

// Exact decimal string for a USD price, never exponential notation (rare for our assets).
export function toDecimalString(n) {
  if (!Number.isFinite(n)) throw new Error(`non-finite price: ${n}`);
  const s = String(n);
  if (!s.includes('e') && !s.includes('E')) return s;
  return n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
}

// Integer form at PRICE_SCALE_DECIMALS precision. PRICE precision only — NOT token on-chain decimals.
export function toPriceScaled(n) {
  return String(Math.round(n * 10 ** PRICE_SCALE_DECIMALS));
}

// One call to /api/v3/simple/price for all ids, priced in usd. Caches in memory.
export async function pollOnce() {
  const url = `${COINGECKO_URL}?ids=${COINGECKO_IDS.join(',')}&vs_currencies=usd`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = await res.json();

  const prices = {};
  for (const a of ASSETS) {
    const usd = data?.[a.id]?.usd;
    if (usd !== undefined && usd !== null) {
      prices[a.pair] = {
        pair: a.pair,
        symbol: a.symbol,
        coingeckoId: a.id,
        // Authoritative, unambiguous USD price as an exact decimal string.
        price: toDecimalString(usd),
        quoteCurrency: 'USD',
        source: 'coingecko',
        // Optional integer form for on-chain consumers. PRICE precision only — unrelated to any
        // token's on-chain decimals. Derived from `price`, so it's verifiable by recomputation.
        priceScaled: toPriceScaled(usd),
        priceScaleDecimals: PRICE_SCALE_DECIMALS,
      };
    }
  }
  cache = { prices, fetchedAt: new Date().toISOString(), source: 'coingecko' };
  return cache;
}

export function startPolling() {
  const run = () => pollOnce().catch((e) => console.error('[priceFeed] poll error:', e.message));
  timer = setInterval(run, POLL_INTERVAL_MS);
}

export function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}
