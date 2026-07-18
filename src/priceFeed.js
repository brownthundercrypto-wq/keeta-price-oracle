// Multi-source price poller + in-memory cache.
// For each pair: fetch all sources, take the MEDIAN as the published price, and record each
// source's raw value + fetch timestamp. Requires >= MIN_SOURCES live sources to publish a price;
// fewer -> the pair is marked stale (never publish a single-source number).
import { ASSETS, POLL_INTERVAL_MS, PRICE_SCALE_DECIMALS, MIN_SOURCES, OUTLIER_THRESHOLD } from './config.js';
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

// Population standard deviation (agreement measure over the surviving sources).
function stddev(nums) {
  const n = nums.length;
  if (!n) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
}

// Round-then-stringify so a stable, deterministic string is signed (computed once per poll, cached).
const fixed = (n, dp) => toDecimalString(Math.round(n * 10 ** dp) / 10 ** dp);

// Poll every source for every pair and aggregate.
export async function pollOnce() {
  const perPair = await fetchAllSources();
  const fetchedAt = new Date().toISOString();
  const prices = { ...cache.prices }; // carry forward last-good entries for stale pairs

  for (const a of ASSETS) {
    const { used, dropped } = perPair[a.pair] || { used: [], dropped: [] };
    // Unreachable = fetch failed this cycle (distinct from outlier drops below).
    const unreachable = dropped.map((d) => ({ name: d.name, quote: d.quote, error: d.error, ts: d.ts, type: 'unreachable' }));

    const markStale = (thisReports, thisDropped) => {
      const prev = cache.prices[a.pair];
      if (prev && prev.price != null) {
        prices[a.pair] = { ...prev, stale: true, liveSourceCount: used.length, sourceReports: thisReports, droppedSources: thisDropped, lastCheckedAt: fetchedAt, staleSince: prev.stale ? prev.staleSince : fetchedAt };
      } else {
        prices[a.pair] = {
          pair: a.pair, symbol: a.symbol, price: null, quoteCurrency: 'USD', priceScaled: null,
          priceScaleDecimals: PRICE_SCALE_DECIMALS, method: 'median', sources: '', sourceList: [],
          sourceReports: thisReports, droppedSources: thisDropped, confidenceBand: null, confidencePct: null,
          liveSourceCount: used.length, stale: true, updatedAt: null, lastCheckedAt: fetchedAt,
        };
      }
    };

    if (used.length < MIN_SOURCES) {
      markStale(
        used.map((u) => ({ name: u.name, price: toDecimalString(u.price), ts: u.ts, quote: u.quote })),
        unreachable,
      );
      continue;
    }

    // Deviation guard: drop any live source more than OUTLIER_THRESHOLD from the median center.
    const center = median(used.map((u) => u.price));
    const survivors = [];
    const outliers = [];
    for (const u of used) {
      const dev = center > 0 ? Math.abs(u.price - center) / center : 0;
      if (dev > OUTLIER_THRESHOLD) {
        outliers.push({ name: u.name, price: toDecimalString(u.price), ts: u.ts, quote: u.quote, type: 'outlier', deviationPct: fixed(dev * 100, 4) });
      } else {
        survivors.push(u);
      }
    }

    const survivorReports = survivors.map((u) => ({ name: u.name, price: toDecimalString(u.price), ts: u.ts, quote: u.quote }));
    const droppedSources = [...unreachable, ...outliers];

    if (survivors.length < MIN_SOURCES) {
      // Removing outliers would leave too few sources -> don't publish a shaky number.
      markStale(survivorReports, droppedSources);
      continue;
    }

    // Recompute the median over survivors; derive confidence from their agreement.
    const survPrices = survivors.map((u) => u.price);
    const med = median(survPrices);
    const band = stddev(survPrices); // absolute, price units
    const pct = med > 0 ? (band / med) * 100 : 0; // relative %
    const usedNames = survivors.map((u) => u.name); // already name-sorted -> deterministic

    prices[a.pair] = {
      pair: a.pair,
      symbol: a.symbol,
      price: toDecimalString(med),
      quoteCurrency: 'USD',
      priceScaled: toPriceScaled(med),
      priceScaleDecimals: PRICE_SCALE_DECIMALS,
      method: 'median',
      sources: usedNames.join(','), // canonical, signed provenance = survivors
      sourceList: usedNames,
      sourceReports: survivorReports, // survivors used for the median (with native quote)
      droppedSources, // unreachable + outliers (each tagged type; outliers carry deviationPct)
      confidenceBand: fixed(band, PRICE_SCALE_DECIMALS + 2), // absolute agreement band (signed)
      confidencePct: fixed(pct, 6), // relative agreement % (signed)
      liveSourceCount: usedNames.length,
      stale: false,
      updatedAt: fetchedAt,
    };
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
