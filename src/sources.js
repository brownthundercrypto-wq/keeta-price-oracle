// Independent, keyless price sources. Each returns a USD price per pair.
// Probed live and confirmed to return KTA/USD (and BTC/ETH/USDC/EURC): CoinGecko, Coinbase, Kraken.
import { COINGECKO_URL, ASSETS } from './config.js';

const TIMEOUT_MS = 8000;

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// --- CoinGecko: one batch call for all ids (efficient). Returns { pair: price }. ---
async function coingeckoBatch() {
  const ids = ASSETS.map((a) => a.id).join(',');
  const data = await getJson(`${COINGECKO_URL}?ids=${ids}&vs_currencies=usd`);
  const out = {};
  for (const a of ASSETS) {
    const v = data?.[a.id]?.usd;
    if (typeof v === 'number' && Number.isFinite(v)) out[a.pair] = v;
  }
  return out;
}

// --- Coinbase: per-pair spot price in real USD. ---
async function coinbasePair(pair) {
  const d = await getJson(`https://api.coinbase.com/v2/prices/${pair}/spot`);
  const n = Number(d?.data?.amount);
  if (!Number.isFinite(n)) throw new Error('no amount');
  return n;
}

// --- Kraken: per-pair last-trade price. Kraken normalizes pair keys (XBTUSD -> XXBTZUSD),
//     so read the first result entry rather than assuming the queried name. ---
const KRAKEN_SYM = {
  'KTA-USD': 'KTAUSD',
  'BTC-USD': 'XBTUSD',
  'ETH-USD': 'ETHUSD',
  'USDC-USD': 'USDCUSD',
  'EURC-USD': 'EURCUSD',
};
async function krakenPair(pair) {
  const sym = KRAKEN_SYM[pair];
  if (!sym) throw new Error('unsupported pair');
  const d = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${sym}`);
  if (Array.isArray(d?.error) && d.error.length) throw new Error(d.error.join(';'));
  const first = d?.result && Object.values(d.result)[0];
  const n = Number(first?.c?.[0]); // c = last trade closed [price, lot volume]
  if (!Number.isFinite(n)) throw new Error('no last price');
  return n;
}

// Ordered source registry. CoinGecko is batch; the others are per-pair.
export const SOURCE_NAMES = ['coinbase', 'coingecko', 'kraken'];
const PER_PAIR = [
  ['coinbase', coinbasePair],
  ['kraken', krakenPair],
];

// Fetch every source for every pair. Returns:
//   { [pair]: { used: [{name, price, ts}], dropped: [{name, error, ts}] } }
// `used` and `dropped` are sorted by source name for deterministic provenance ordering.
export async function fetchAllSources() {
  const nowIso = () => new Date().toISOString();

  // CoinGecko batch (single call). If it fails entirely, all pairs drop coingecko.
  let cg = {};
  let cgErr = null;
  try {
    cg = await coingeckoBatch();
  } catch (e) {
    cgErr = e.message || String(e);
  }

  const result = {};
  await Promise.all(
    ASSETS.map(async (a) => {
      const pair = a.pair;
      const used = [];
      const dropped = [];

      // coingecko (from batch)
      if (cgErr) dropped.push({ name: 'coingecko', error: cgErr, ts: nowIso() });
      else if (typeof cg[pair] === 'number') used.push({ name: 'coingecko', price: cg[pair], ts: nowIso() });
      else dropped.push({ name: 'coingecko', error: 'no price for pair', ts: nowIso() });

      // per-pair sources in parallel
      await Promise.all(
        PER_PAIR.map(async ([name, fn]) => {
          try {
            const price = await fn(pair);
            used.push({ name, price, ts: nowIso() });
          } catch (e) {
            dropped.push({ name, error: e.message || String(e), ts: nowIso() });
          }
        }),
      );

      used.sort((x, y) => x.name.localeCompare(y.name));
      dropped.sort((x, y) => x.name.localeCompare(y.name));
      result[pair] = { used, dropped };
    }),
  );
  return result;
}
