// Express HTTP surface for the price oracle.
import express from 'express';
import { getCache, toDecimalString, toPriceScaled } from './priceFeed.js';
import { attest, getAddress, getOnChainHistory } from './keetaOracle.js';
import { ASSETS, PRICE_SCALE_DECIMALS, MIN_SOURCES, VERSION, PUBLIC_URL, OUTLIER_THRESHOLD } from './config.js';
import { SOURCE_NAMES } from './sources.js';

const START_TIME = new Date().toISOString();
const REPO_URL = 'https://github.com/brownthundercrypto-wq/keeta-price-oracle';
const VERIFY_URL = `${REPO_URL}/blob/main/verify-attestation.mjs`;

// Self-contained landing page (no framework, inline CSS) served at GET /.
function landingPage() {
  const pairs = ASSETS.map((a) => a.pair);
  const pairChips = pairs.map((p) => `<code class="pair">${p}</code>`).join(' ');
  const base = PUBLIC_URL || '$BASE'; // real host when deployed; placeholder only in local dev
  const baseNote = PUBLIC_URL
    ? `Requests above are copy-paste-ready against <code>${PUBLIC_URL}</code>.`
    : `Replace <code>$BASE</code> with this host.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Keeta Price Oracle (testnet)</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: #0f1115; color: #e6e6e6; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 40px 20px 64px; }
  h1 { font-size: 1.7rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 32px 0 10px; border-bottom: 1px solid #262a33; padding-bottom: 6px; }
  .tag { color: #8b93a7; margin: 0 0 20px; }
  a { color: #7aa2f7; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .pair { background: #1a1e27; border: 1px solid #262a33; border-radius: 6px; padding: 2px 8px; margin-right: 4px; display: inline-block; }
  .badge { display: inline-block; background: #16351f; color: #7ee2a8; border: 1px solid #1f5132; border-radius: 999px; padding: 2px 10px; font-size: 0.8rem; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  td, th { text-align: left; padding: 8px 10px; border-bottom: 1px solid #23272f; vertical-align: top; }
  th { color: #8b93a7; font-weight: 600; }
  pre { background: #1a1e27; border: 1px solid #262a33; border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
  .muted { color: #8b93a7; }
  footer { margin-top: 40px; color: #8b93a7; font-size: 0.85rem; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Keeta Price Oracle <span class="muted">v${VERSION}</span></h1>
  <p class="tag">A multi-source, median-aggregated USD price feed on the <strong>Keeta testnet</strong>.
     Every quote is <strong>cryptographically signed</strong> and independently verifiable.</p>
  <p><span class="badge">testnet</span> &nbsp; <span class="badge">signed &amp; verifiable</span> &nbsp; <span class="badge">median of up to ${SOURCE_NAMES.length} sources</span></p>

  <h2>What this is</h2>
  <p>Prices are fetched from multiple independent sources (CoinGecko, Coinbase, Kraken, CoinPaprika,
     MEXC, Bitmart), aggregated by <strong>median</strong> (≥2 live sources required, else the pair is
     marked stale), cached, and published on-chain as signed <code>SET_INFO</code> snapshots.
     The oracle account is <code>${getAddress()}</code>.</p>

  <h2>Pairs</h2>
  <p>${pairChips}</p>

  <h2>Endpoints</h2>
  <table>
    <tr><th>Endpoint</th><th>Example</th></tr>
    <tr><td><code>GET /health</code></td><td><code>curl ${base}/health</code></td></tr>
    <tr><td><code>POST /getPrice</code></td><td><code>curl -X POST ${base}/getPrice -H 'content-type: application/json' -d '{"pair":"KTA-USD"}'</code></td></tr>
    <tr><td><code>POST /proof</code></td><td><code>curl -X POST ${base}/proof -H 'content-type: application/json' -d '{"pair":"KTA-USD"}'</code></td></tr>
    <tr><td><code>POST /getPriceHistory</code></td><td><code>curl -X POST ${base}/getPriceHistory -H 'content-type: application/json' -d '{"pair":"KTA-USD","limit":10}'</code></td></tr>
  </table>
  <p class="muted">${baseNote} <code>pair</code> accepts the pair, symbol, or CoinGecko id.</p>

  <h2>Signed &amp; verifiable</h2>
  <p>Every <code>/getPrice</code> response includes a <code>signedFields</code> list and an
     <code>attestation</code>. Anyone can verify it against the oracle's public key with
     <a href="${VERIFY_URL}">verify-attestation.mjs</a> — a clean-room verifier that imports none of
     this server's code. Tampering with any signed field (price, scaled integer, or the source list)
     fails verification.</p>

  <h2>Source</h2>
  <p><a href="${REPO_URL}">${REPO_URL}</a></p>

  <footer>Keeta testnet · no real value · prices for development use only.</footer>
</div>
</body>
</html>`;
}

// Canonical, attested payload. Provenance (`method` + ordered `sources`) is SIGNED, not just shown,
// so a consumer verifies which sources and aggregation produced the price. `sources` is the ordered
// comma-joined source-name list; `timestamp` is the observation time (when the aggregation ran).
const SIGNED_FIELDS = ['pair', 'quoteCurrency', 'price', 'priceScaled', 'priceScaleDecimals', 'method', 'sources', 'confidenceBand', 'confidencePct', 'timestamp'];

async function buildAttestation(entry) {
  const canonical = {
    pair: entry.pair,
    quoteCurrency: entry.quoteCurrency,
    price: entry.price,
    priceScaled: entry.priceScaled,
    priceScaleDecimals: entry.priceScaleDecimals,
    method: entry.method,
    sources: entry.sources, // canonical ordered, comma-joined provenance string
    confidenceBand: entry.confidenceBand, // absolute agreement band (price units)
    confidencePct: entry.confidencePct, // relative agreement %
    timestamp: entry.updatedAt,
  };
  const values = SIGNED_FIELDS.map((f) => canonical[f]);
  const attestation = await attest(values);
  return { values, attestation };
}

// Normalize a historical on-chain price entry to ONE consistent shape.
// New-shape blocks pass through (legacyShape:false). Pre-fix blocks (which carried token `decimals`
// and a numeric `priceUsd`) are mapped to the new shape (exact `price` string + `quoteCurrency` +
// derived `priceScaled`) and tagged legacyShape:true. On-chain history itself is NOT rewritten.
function normalizeHistoricalPrice(e) {
  if (!e || typeof e !== 'object') return e;
  if (typeof e.price === 'string' && e.quoteCurrency) {
    return {
      pair: e.pair,
      symbol: e.symbol,
      coingeckoId: e.coingeckoId,
      price: e.price,
      quoteCurrency: e.quoteCurrency,
      source: e.source ?? 'coingecko',
      priceScaled: e.priceScaled,
      priceScaleDecimals: e.priceScaleDecimals,
      legacyShape: false,
    };
  }
  // Legacy pre-fix entry: { ..., decimals, priceUsd }
  const usd = e.priceUsd;
  return {
    pair: e.pair,
    symbol: e.symbol,
    coingeckoId: e.coingeckoId,
    price: usd !== undefined ? toDecimalString(usd) : null,
    quoteCurrency: 'USD',
    source: 'coingecko',
    priceScaled: usd !== undefined ? toPriceScaled(usd) : null,
    priceScaleDecimals: PRICE_SCALE_DECIMALS,
    legacyShape: true,
  };
}

// Resolve a caller-supplied identifier (pair "KTA-USD", symbol "KTA", or id "keeta") to a cached price.
function resolvePrice(input) {
  if (!input) return null;
  const key = String(input).toUpperCase();
  const cache = getCache();
  if (cache.prices[key]) return cache.prices[key];
  const asset = ASSETS.find(
    (a) => a.pair.toUpperCase() === key || a.symbol.toUpperCase() === key || a.id.toUpperCase() === key,
  );
  return asset ? cache.prices[asset.pair] ?? null : null;
}

export function createServer() {
  const app = express();
  app.use(express.json());

  // Landing page (human-facing) at root.
  app.get('/', (_req, res) => {
    res.type('html').send(landingPage());
  });

  app.get('/health', (_req, res) => {
    const cache = getCache();
    const perPair = {};
    const liveSources = new Set();
    let lastPriceUpdate = null;
    for (const e of Object.values(cache.prices)) {
      perPair[e.pair] = {
        liveSourceCount: e.liveSourceCount ?? 0,
        stale: !!e.stale,
        updatedAt: e.updatedAt ?? null,
      };
      for (const r of e.sourceReports || []) liveSources.add(r.name);
      if (e.updatedAt && (!lastPriceUpdate || e.updatedAt > lastPriceUpdate)) lastPriceUpdate = e.updatedAt;
    }
    res.json({
      status: 'ok',
      version: VERSION,
      oracle: getAddress(),
      network: 'test',
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: START_TIME,
      lastFetch: cache.fetchedAt,
      lastPriceUpdate,
      aggregation: cache.method || 'median',
      minSourcesRequired: MIN_SOURCES,
      // Distinct sources that responded in the most recent poll (across all pairs).
      liveSourceCount: liveSources.size,
      sources: [...liveSources].sort(),
      pairs: perPair,
    });
  });

  // POST /getPrice { pair } -> latest median price + signed (provenance-attested) quote
  app.post('/getPrice', async (req, res) => {
    try {
      const entry = resolvePrice(req.body?.pair);
      if (!entry) {
        return res.status(404).json({ ok: false, error: `Unknown or unavailable pair: ${req.body?.pair}` });
      }
      // Stale with no usable last price -> refuse rather than serve a single-source number.
      if (entry.price == null) {
        return res.status(503).json({
          ok: false,
          stale: true,
          error: `No price for ${entry.pair}: fewer than ${MIN_SOURCES} live sources`,
          pair: entry.pair,
          liveSourceCount: entry.liveSourceCount ?? 0,
          droppedSources: entry.droppedSources ?? [],
        });
      }
      const { attestation } = await buildAttestation(entry);
      res.json({
        ok: true,
        oracle: getAddress(),
        pair: entry.pair,
        symbol: entry.symbol,
        price: entry.price, // median of live sources, exact decimal string
        quoteCurrency: entry.quoteCurrency, // "USD"
        priceScaled: entry.priceScaled,
        priceScaleDecimals: entry.priceScaleDecimals,
        method: entry.method, // "median" (SIGNED)
        sources: entry.sources, // ordered comma-joined provenance (SIGNED)
        sourceList: entry.sourceList, // same, as an array (convenience; unsigned)
        // Confidence from surviving-source agreement (both SIGNED). Lower = tighter agreement.
        confidenceBand: entry.confidenceBand, // absolute, in USD price units
        confidencePct: entry.confidencePct, // relative, percent
        liveSourceCount: entry.liveSourceCount,
        stale: !!entry.stale,
        timestamp: entry.updatedAt, // observation time (SIGNED)
        signedFields: SIGNED_FIELDS,
        attestation,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /proof { pair } -> exactly where the price came from: per-source raw values + timestamps,
  // which sources were used vs dropped, the aggregation method, the final median, + the attestation.
  app.post('/proof', async (req, res) => {
    try {
      const entry = resolvePrice(req.body?.pair);
      if (!entry) {
        return res.status(404).json({ ok: false, error: `Unknown or unavailable pair: ${req.body?.pair}` });
      }
      const dropped = entry.droppedSources ?? [];
      const response = {
        ok: true,
        oracle: getAddress(),
        pair: entry.pair,
        symbol: entry.symbol,
        aggregation: {
          method: entry.method, // "median"
          liveSourceCount: entry.liveSourceCount ?? 0,
          minSourcesRequired: MIN_SOURCES,
          outlierThresholdPct: OUTLIER_THRESHOLD * 100, // sources beyond this from the median are dropped
          sourcesUsed: entry.sourceList ?? [],
        },
        // Survivors used for the median. Each carries its native `quote` (USD vs USDT) for transparency.
        sources: entry.sourceReports ?? [], // [{ name, price, ts, quote }]
        // Split by reason so consumers see unreachable vs. rejected-as-outlier (with deviation %).
        sourcesDropped: dropped, // [{ name, ts, quote, type, error? , price?, deviationPct? }]
        sourcesUnreachable: dropped.filter((d) => d.type === 'unreachable'),
        sourcesOutliers: dropped.filter((d) => d.type === 'outlier'),
        finalPrice: entry.price, // the published median (over survivors)
        priceScaled: entry.priceScaled,
        priceScaleDecimals: entry.priceScaleDecimals,
        quoteCurrency: entry.quoteCurrency,
        // Confidence from surviving-source agreement (both are in the signed payload).
        confidenceBand: entry.confidenceBand ?? null,
        confidencePct: entry.confidencePct ?? null,
        stale: !!entry.stale,
        timestamp: entry.updatedAt,
      };
      // Attach the same attestation /getPrice serves, when there is a signable price.
      if (entry.price != null) {
        const { attestation } = await buildAttestation(entry);
        response.signedFields = SIGNED_FIELDS;
        response.attestation = attestation;
      }
      res.json(response);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /getPriceHistory { pair, limit } -> last N on-chain snapshots
  app.post('/getPriceHistory', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(50, parseInt(req.body?.limit ?? 10, 10)));
      const pairInput = req.body?.pair;
      const snapshots = await getOnChainHistory(pairInput ? limit + 20 : limit);

      let history;
      let pairLabel = 'ALL';
      if (pairInput) {
        const resolved = resolvePrice(pairInput);
        const pairKey = resolved ? resolved.pair : String(pairInput).toUpperCase();
        pairLabel = pairKey;
        history = snapshots
          .filter((s) => s.prices?.[pairKey] !== undefined)
          .map((s) => ({ blockHash: s.blockHash, timestamp: s.timestamp, price: normalizeHistoricalPrice(s.prices[pairKey]) }));
      } else {
        // ALL pairs: normalize every entry so consumers get one consistent shape.
        history = snapshots.map((s) => {
          const prices = {};
          for (const [k, v] of Object.entries(s.prices || {})) prices[k] = normalizeHistoricalPrice(v);
          return { blockHash: s.blockHash, timestamp: s.timestamp, prices };
        });
      }
      history = history.slice(0, limit);
      res.json({ ok: true, oracle: getAddress(), pair: pairLabel, count: history.length, history });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return app;
}
