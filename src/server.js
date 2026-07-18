// Express HTTP surface for the price oracle.
import express from 'express';
import { getCache, toDecimalString, toPriceScaled } from './priceFeed.js';
import { attest, getAddress, getOnChainHistory } from './keetaOracle.js';
import { ASSETS, PRICE_SCALE_DECIMALS, MIN_SOURCES, VERSION } from './config.js';

const START_TIME = new Date().toISOString();

// Canonical, attested payload. Provenance (`method` + ordered `sources`) is SIGNED, not just shown,
// so a consumer verifies which sources and aggregation produced the price. `sources` is the ordered
// comma-joined source-name list; `timestamp` is the observation time (when the aggregation ran).
const SIGNED_FIELDS = ['pair', 'quoteCurrency', 'price', 'priceScaled', 'priceScaleDecimals', 'method', 'sources', 'timestamp'];

async function buildAttestation(entry) {
  const canonical = {
    pair: entry.pair,
    quoteCurrency: entry.quoteCurrency,
    price: entry.price,
    priceScaled: entry.priceScaled,
    priceScaleDecimals: entry.priceScaleDecimals,
    method: entry.method,
    sources: entry.sources, // canonical ordered, comma-joined provenance string
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
      const response = {
        ok: true,
        oracle: getAddress(),
        pair: entry.pair,
        symbol: entry.symbol,
        aggregation: {
          method: entry.method, // "median"
          liveSourceCount: entry.liveSourceCount ?? 0,
          minSourcesRequired: MIN_SOURCES,
          sourcesUsed: entry.sourceList ?? [],
        },
        sources: entry.sourceReports ?? [], // [{ name, price, ts }] raw per-source values used
        sourcesDropped: entry.droppedSources ?? [], // [{ name, error, ts }] not counted this cycle
        finalPrice: entry.price, // the published median
        priceScaled: entry.priceScaled,
        priceScaleDecimals: entry.priceScaleDecimals,
        quoteCurrency: entry.quoteCurrency,
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
