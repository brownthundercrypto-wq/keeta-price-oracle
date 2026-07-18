// Independent price sources. Each returns a USD price per pair. Probed live for KTA/USD.
//
// USD-quoted sources: coingecko, coinbase, kraken, coinpaprika.
// USDT-quoted sources: mexc, bitmart. USDT is treated as a 1:1 USD proxy (standard for crypto
//   price oracles); the median naturally rejects any USDT-depeg outlier. Testnet only.
//
// A per-pair source returns:
//   - a number  -> live price for that pair
//   - null      -> source does not list that pair (skipped; NOT counted as dropped)
//   - throws    -> fetch/parse error (counted as dropped, with the reason)
import { COINGECKO_URL, ASSETS } from './config.js';

const TIMEOUT_MS = 8000;

async function getJson(url, extraHeaders) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', ...extraHeaders } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// --- CoinGecko (USD): one batch call. Optional demo API key lifts datacenter-IP rate limits. ---
async function coingeckoBatch() {
  const ids = ASSETS.map((a) => a.id).join(',');
  const key = process.env.COINGECKO_API_KEY;
  const headers = key ? { 'x-cg-demo-api-key': key } : undefined;
  const data = await getJson(`${COINGECKO_URL}?ids=${ids}&vs_currencies=usd`, headers);
  const out = {};
  for (const a of ASSETS) {
    const v = data?.[a.id]?.usd;
    if (typeof v === 'number' && Number.isFinite(v)) out[a.pair] = v;
  }
  return out;
}

// --- Coinbase (USD): per-pair spot. ---
async function coinbasePair(pair) {
  const d = await getJson(`https://api.coinbase.com/v2/prices/${pair}/spot`);
  const n = Number(d?.data?.amount);
  if (!Number.isFinite(n)) throw new Error('no amount');
  return n;
}

// --- Kraken (USD): per-pair last trade. Kraken normalizes keys (XBTUSD -> XXBTZUSD). ---
const KRAKEN_SYM = { 'KTA-USD': 'KTAUSD', 'BTC-USD': 'XBTUSD', 'ETH-USD': 'ETHUSD', 'USDC-USD': 'USDCUSD', 'EURC-USD': 'EURCUSD' };
async function krakenPair(pair) {
  const sym = KRAKEN_SYM[pair];
  if (!sym) return null;
  const d = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${sym}`);
  if (Array.isArray(d?.error) && d.error.length) throw new Error(d.error.join(';'));
  const first = d?.result && Object.values(d.result)[0];
  const n = Number(first?.c?.[0]);
  if (!Number.isFinite(n)) throw new Error('no last price');
  return n;
}

// --- CoinPaprika (USD aggregator): per-coin ticker. ---
const PAPRIKA_ID = { 'KTA-USD': 'kta-keeta', 'BTC-USD': 'btc-bitcoin', 'ETH-USD': 'eth-ethereum', 'USDC-USD': 'usdc-usd-coin', 'EURC-USD': 'eurc-euro-coin' };
async function coinpaprikaPair(pair) {
  const id = PAPRIKA_ID[pair];
  if (!id) return null;
  const d = await getJson(`https://api.coinpaprika.com/v1/tickers/${id}`);
  const n = Number(d?.quotes?.USD?.price);
  if (!Number.isFinite(n)) throw new Error('no USD quote');
  return n;
}

// --- MEXC (USDT proxy): per-pair ticker price. No EURC pair. ---
const MEXC_SYM = { 'KTA-USD': 'KTAUSDT', 'BTC-USD': 'BTCUSDT', 'ETH-USD': 'ETHUSDT', 'USDC-USD': 'USDCUSDT' };
async function mexcPair(pair) {
  const sym = MEXC_SYM[pair];
  if (!sym) return null;
  const d = await getJson(`https://api.mexc.com/api/v3/ticker/price?symbol=${sym}`);
  const n = Number(d?.price);
  if (!Number.isFinite(n)) throw new Error('no price');
  return n;
}

// --- Bitmart (USDT proxy): per-pair ticker (data.last). ---
const BITMART_SYM = { 'KTA-USD': 'KTA_USDT', 'BTC-USD': 'BTC_USDT', 'ETH-USD': 'ETH_USDT', 'USDC-USD': 'USDC_USDT', 'EURC-USD': 'EURC_USDT' };
async function bitmartPair(pair) {
  const sym = BITMART_SYM[pair];
  if (!sym) return null;
  const d = await getJson(`https://api-cloud.bitmart.com/spot/quotation/v3/ticker?symbol=${sym}`);
  const n = Number(d?.data?.last);
  if (!Number.isFinite(n)) throw new Error('no last price');
  return n;
}

// Native quote asset per source (USDT venues are treated as a 1:1 USD proxy; surfaced in /proof).
export const SOURCE_QUOTE = {
  coingecko: 'USD',
  coinbase: 'USD',
  kraken: 'USD',
  coinpaprika: 'USD',
  mexc: 'USDT',
  bitmart: 'USDT',
};

// Ordered source registry (alphabetical for deterministic provenance).
export const SOURCE_NAMES = ['bitmart', 'coinbase', 'coingecko', 'coinpaprika', 'kraken', 'mexc'];
const PER_PAIR = [
  ['bitmart', bitmartPair],
  ['coinbase', coinbasePair],
  ['coinpaprika', coinpaprikaPair],
  ['kraken', krakenPair],
  ['mexc', mexcPair],
];

// Fetch every source for every pair. Returns:
//   { [pair]: { used: [{name, price, ts}], dropped: [{name, error, ts}] } }
// sorted by source name for deterministic provenance ordering.
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
      if (cgErr) dropped.push({ name: 'coingecko', quote: SOURCE_QUOTE.coingecko, error: cgErr, ts: nowIso() });
      else if (typeof cg[pair] === 'number') used.push({ name: 'coingecko', quote: SOURCE_QUOTE.coingecko, price: cg[pair], ts: nowIso() });
      else dropped.push({ name: 'coingecko', quote: SOURCE_QUOTE.coingecko, error: 'no price for pair', ts: nowIso() });

      // per-pair sources in parallel
      await Promise.all(
        PER_PAIR.map(async ([name, fn]) => {
          let price;
          try {
            price = await fn(pair);
          } catch (e) {
            dropped.push({ name, quote: SOURCE_QUOTE[name], error: e.message || String(e), ts: nowIso() });
            return;
          }
          if (price == null) return; // source doesn't list this pair -> skip (not a drop)
          used.push({ name, quote: SOURCE_QUOTE[name], price, ts: nowIso() });
        }),
      );

      used.sort((x, y) => x.name.localeCompare(y.name));
      dropped.sort((x, y) => x.name.localeCompare(y.name));
      result[pair] = { used, dropped };
    }),
  );
  return result;
}
