// Express HTTP surface for the price oracle.
import express from 'express';
import { getCache, toDecimalString, toPriceScaled } from './priceFeed.js';
import { attest, getAddress, getOnChainHistory } from './keetaOracle.js';
import { ASSETS, PRICE_SCALE_DECIMALS, MIN_SOURCES, VERSION, PUBLIC_URL, OUTLIER_THRESHOLD, TWAP_WINDOWS } from './config.js';
import { SOURCE_NAMES } from './sources.js';
import { computeTwap, recentHistory } from './timeseries.js';
import { createRateLimiter } from './rateLimit.js';
import { getLastPublish } from './pushFeed.js';
import { buildDashboardData, dashboardPage } from './dashboard.js';

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
     Every quote — spot <em>and</em> TWAP — is <strong>cryptographically signed</strong> and independently verifiable.</p>
  <p><span class="badge">testnet</span> &nbsp; <span class="badge">signed &amp; verifiable</span> &nbsp; <span class="badge">median of up to ${SOURCE_NAMES.length} sources</span> &nbsp; <span class="badge">1h / 24h TWAP</span> &nbsp; <span class="badge">push feed on-chain</span></p>

  <p><a href="/dashboard"><strong>→ Live transparency dashboard</strong></a> — see every pair's median,
     confidence, TWAP, and the exact per-source breakdown (including sources dropped as outliers),
     auto-refreshing.</p>

  <h2>What this is</h2>
  <p>Prices are fetched from multiple independent sources (CoinGecko, Coinbase, Kraken, CoinPaprika,
     MEXC, Bitmart), aggregated by <strong>median</strong> (≥2 live sources required, else the pair is
     marked stale), and published on-chain as signed <code>SET_INFO</code> snapshots.
     The oracle account is <code>${getAddress()}</code>.</p>

  <h2>Manipulation-resistant pricing</h2>
  <p>Two complementary, independently signed measures per pair: a <strong>median spot price</strong>
     across independent venues (single-venue prints and depeg outliers are dropped before the median),
     and proper <strong>time-weighted average prices (TWAP)</strong> over <strong>1h</strong> and
     <strong>24h</strong> windows — each price weighted by how long it was current, not a naive sample
     average. A window without enough history reads <code>"building"</code> (also signed) rather than a
     <em>misleading partial number</em>. The TWAP/history time-series is <strong>persisted in SQLite on
     a mounted volume, so it survives restarts and redeploys</strong>; the 60s spot cache is in-memory
     and repopulates on the next poll.</p>

  <h2>On-chain push feed</h2>
  <p>On-chain snapshots are not on a fixed timer. A fresh signed snapshot of all pairs is published
     when <strong>either</strong> a heartbeat interval elapses <strong>or</strong> a pair's median moves
     past a deviation threshold versus its last on-chain price — bounded by a minimum interval and a
     per-hour cap so fees stay predictable. Read them back via <code>/getPriceHistory</code>.</p>

  <h2>Pairs</h2>
  <p>${pairChips}</p>

  <h2>Endpoints</h2>
  <table>
    <tr><th>Endpoint</th><th>Example</th></tr>
    <tr><td><code>GET /health</code></td><td><code>curl ${base}/health</code></td></tr>
    <tr><td><code>POST /getPrice</code></td><td><code>curl -X POST ${base}/getPrice -H 'content-type: application/json' -d '{"pair":"KTA-USD"}'</code></td></tr>
    <tr><td><code>POST /twap</code></td><td><code>curl -X POST ${base}/twap -H 'content-type: application/json' -d '{"pair":"KTA-USD","window":"1h"}'</code></td></tr>
    <tr><td><code>POST /proof</code></td><td><code>curl -X POST ${base}/proof -H 'content-type: application/json' -d '{"pair":"KTA-USD"}'</code></td></tr>
    <tr><td><code>POST /getPriceHistory</code></td><td><code>curl -X POST ${base}/getPriceHistory -H 'content-type: application/json' -d '{"pair":"KTA-USD","limit":10}'</code></td></tr>
  </table>
  <p class="muted">${baseNote} <code>pair</code> accepts the pair, symbol, or CoinGecko id.
     <code>/getPrice</code> also returns signed <code>twap1h</code> and <code>twap24h</code> (each a
     value or <code>"building"</code> during cold start); <code>/twap</code> returns a single window
     (<code>1h</code> or <code>24h</code>) with its own signed attestation.</p>

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
const SIGNED_FIELDS = ['pair', 'quoteCurrency', 'price', 'priceScaled', 'priceScaleDecimals', 'method', 'sources', 'confidenceBand', 'confidencePct', 'twap1h', 'twap24h', 'timestamp'];
// /twap has its own (smaller) signed canonical.
const TWAP_SIGNED_FIELDS = ['pair', 'quoteCurrency', 'window', 'twap', 'timestamp'];

// Round-then-stringify so a stable decimal string is signed.
const fixed = (n, dp) => toDecimalString(Math.round(n * 10 ** dp) / 10 ** dp);

// Compute a single TWAP window. Returns { signed, detail }.
// `signed` is what goes into the signed payload: the value string, or "building" on cold start.
function twapField(pair, windowMs, nowMs) {
  const r = computeTwap(pair, windowMs, nowMs);
  const windowSeconds = Math.floor(windowMs / 1000);
  const haveSeconds = Math.floor((r.haveMs || 0) / 1000);
  if (r.status !== 'ready') {
    return { signed: 'building', detail: { status: 'building', value: null, haveSeconds, windowSeconds, samples: r.samples } };
  }
  const value = fixed(r.value, PRICE_SCALE_DECIMALS);
  return { signed: value, detail: { status: 'ready', value, haveSeconds, windowSeconds, samples: r.samples } };
}

// Build the full signed spot+confidence+TWAP quote for an entry (used by /getPrice and /proof).
async function buildSignedQuote(entry) {
  const nowMs = Date.now();
  const t1h = twapField(entry.pair, TWAP_WINDOWS['1h'], nowMs);
  const t24h = twapField(entry.pair, TWAP_WINDOWS['24h'], nowMs);
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
    twap1h: t1h.signed, // TWAP value or "building" (SIGNED)
    twap24h: t24h.signed, // TWAP value or "building" (SIGNED)
    timestamp: entry.updatedAt,
  };
  const attestation = await attest(SIGNED_FIELDS.map((f) => canonical[f]));
  return { canonical, twapDetail: { '1h': t1h.detail, '24h': t24h.detail }, attestation };
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

  // Abuse protection: token-bucket rate limiter applied ONLY to the POST API endpoints below.
  // GET / and GET /health are deliberately NOT wrapped, so the landing page stays cheap and
  // UptimeRobot + the internal monitor are never throttled.
  const limit = createRateLimiter();

  // Landing page (human-facing) at root. Exempt from rate limiting.
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

  // GET /dashboard-data -> ONE read-only response with everything the dashboard needs for ALL pairs.
  // Deliberately a GET (exempt from the POST-only rate limiter, like /health) so the auto-refreshing
  // dashboard never hammers the signed POST routes.
  app.get('/dashboard-data', (_req, res) => {
    try {
      const cache = getCache();
      const nowMs = Date.now();
      const twapResolver = (pair) => ({
        twap1h: twapField(pair, TWAP_WINDOWS['1h'], nowMs).signed,
        twap24h: twapField(pair, TWAP_WINDOWS['24h'], nowMs).signed,
      });
      // ~last 1h of persisted median prices, downsampled to <=60 points (for the sparkline).
      const historyResolver = (pair) => recentHistory(pair, TWAP_WINDOWS['1h'], 60, nowMs);
      const data = buildDashboardData({
        prices: cache.prices,
        oracle: getAddress(),
        twapResolver,
        historyResolver,
        onchain: getLastPublish(),
        nowIso: new Date(nowMs).toISOString(),
      });
      res.json(data);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /dashboard -> self-contained transparency dashboard HTML (fetches /dashboard-data). Exempt.
  app.get('/dashboard', (_req, res) => {
    res.type('html').send(dashboardPage());
  });

  // POST /getPrice { pair } -> latest median price + signed (provenance-attested) quote
  app.post('/getPrice', limit, async (req, res) => {
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
      const { canonical, twapDetail, attestation } = await buildSignedQuote(entry);
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
        // TWAP over 1h / 24h windows (SIGNED). "building" until enough history exists.
        twap1h: canonical.twap1h,
        twap24h: canonical.twap24h,
        twapDetail, // per-window { status, value, haveSeconds, windowSeconds, samples } (unsigned detail)
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
  app.post('/proof', limit, async (req, res) => {
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
      // Attach the same signed quote /getPrice serves, when there is a signable price.
      if (entry.price != null) {
        const { canonical, twapDetail, attestation } = await buildSignedQuote(entry);
        response.twap1h = canonical.twap1h;
        response.twap24h = canonical.twap24h;
        response.twapDetail = twapDetail;
        response.signedFields = SIGNED_FIELDS;
        response.attestation = attestation;
      }
      res.json(response);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /twap { pair, window } -> time-weighted average price for a window (default 1h), signed.
  app.post('/twap', limit, async (req, res) => {
    try {
      const entry = resolvePrice(req.body?.pair);
      if (!entry) {
        return res.status(404).json({ ok: false, error: `Unknown or unavailable pair: ${req.body?.pair}` });
      }
      const window = String(req.body?.window || '1h');
      const windowMs = TWAP_WINDOWS[window];
      if (!windowMs) {
        return res.status(400).json({ ok: false, error: `Unsupported window: ${window}. Supported: ${Object.keys(TWAP_WINDOWS).join(', ')}` });
      }
      const nowMs = Date.now();
      const { signed, detail } = twapField(entry.pair, windowMs, nowMs);
      const timestamp = new Date(nowMs).toISOString();
      // Sign the TWAP value + window (+ pair, quoteCurrency, timestamp) so it's attested like spot.
      const canonical = { pair: entry.pair, quoteCurrency: entry.quoteCurrency, window, twap: signed, timestamp };
      const attestation = await attest(TWAP_SIGNED_FIELDS.map((f) => canonical[f]));
      res.json({
        ok: true,
        oracle: getAddress(),
        pair: entry.pair,
        symbol: entry.symbol,
        quoteCurrency: entry.quoteCurrency,
        window,
        twap: signed, // TWAP value string, or "building" (SIGNED)
        status: detail.status,
        haveSeconds: detail.haveSeconds,
        windowSeconds: detail.windowSeconds,
        samples: detail.samples,
        timestamp,
        signedFields: TWAP_SIGNED_FIELDS,
        attestation,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /getPriceHistory { pair, limit } -> last N on-chain snapshots
  app.post('/getPriceHistory', limit, async (req, res) => {
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
