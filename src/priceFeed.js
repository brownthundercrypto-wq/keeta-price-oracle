// Multi-source price poller + in-memory cache.
// For each pair: fetch all sources, take the MEDIAN as the published price, and record each
// source's raw value + fetch timestamp. Requires >= MIN_SOURCES live sources to publish a price;
// fewer -> the pair is marked stale (never publish a single-source number).
import { ASSETS, POLL_INTERVAL_MS, PRICE_SCALE_DECIMALS, MIN_SOURCES } from './config.js';
import { fetchAllSources } from './sources.js';

let cache = { prices: {}, fetchedAt: null, source: 'multi-source-median', method: 'median' };
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

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Poll every source for every pair and aggregate.
export async function pollOnce() {
  const perPair = await fetchAllSources();
  const fetchedAt = new Date().toISOString();
  const prices = { ...cache.prices }; // carry forward last-good entries for stale pairs

  for (const a of ASSETS) {
    const { used, dropped } = perPair[a.pair] || { used: [], dropped: [] };
    const liveSourceCount = used.length;
    const sourceReports = used.map((u) => ({ name: u.name, price: toDecimalString(u.price), ts: u.ts }));
    const droppedSources = dropped.map((d) => ({ name: d.name, error: d.error, ts: d.ts }));

    if (liveSourceCount >= MIN_SOURCES) {
      const med = median(used.map((u) => u.price));
      const usedNames = used.map((u) => u.name); // already name-sorted -> deterministic
      prices[a.pair] = {
        pair: a.pair,
        symbol: a.symbol,
        price: toDecimalString(med),
        quoteCurrency: 'USD',
        priceScaled: toPriceScaled(med),
        priceScaleDecimals: PRICE_SCALE_DECIMALS,
        method: 'median',
        // `sources` is the canonical, signed provenance: ordered source names, comma-joined.
        sources: usedNames.join(','),
        sourceList: usedNames,
        sourceReports, // raw per-source values + timestamps (for /proof)
        droppedSources,
        liveSourceCount,
        stale: false,
        updatedAt: fetchedAt,
      };
    } else {
      // Not enough independent sources -> mark stale; keep the last good price if we have one.
      const prev = cache.prices[a.pair];
      if (prev && prev.price != null) {
        prices[a.pair] = {
          ...prev,
          stale: true,
          liveSourceCount,
          sourceReports, // this cycle's (insufficient) reports
          droppedSources,
          lastCheckedAt: fetchedAt,
          staleSince: prev.stale ? prev.staleSince : fetchedAt,
        };
      } else {
        // Never had a good price: nothing to publish.
        prices[a.pair] = {
          pair: a.pair,
          symbol: a.symbol,
          price: null,
          quoteCurrency: 'USD',
          priceScaled: null,
          priceScaleDecimals: PRICE_SCALE_DECIMALS,
          method: 'median',
          sources: '',
          sourceList: [],
          sourceReports,
          droppedSources,
          liveSourceCount,
          stale: true,
          updatedAt: null,
          lastCheckedAt: fetchedAt,
        };
      }
    }
  }

  cache = { prices, fetchedAt, source: 'multi-source-median', method: 'median' };
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
