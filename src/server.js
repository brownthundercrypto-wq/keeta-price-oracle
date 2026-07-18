// Express HTTP surface for the price oracle.
import express from 'express';
import { getCache, toDecimalString, toPriceScaled } from './priceFeed.js';
import { attest, getAddress, getOnChainHistory } from './keetaOracle.js';
import { ASSETS, PRICE_SCALE_DECIMALS } from './config.js';

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
    res.json({
      status: 'ok',
      oracle: getAddress(),
      network: 'test',
      lastFetch: cache.fetchedAt,
      source: cache.source,
      pairs: Object.keys(cache.prices),
    });
  });

  // POST /getPrice { pair } -> latest cached price + signed attestation
  app.post('/getPrice', async (req, res) => {
    try {
      const price = resolvePrice(req.body?.pair);
      if (!price) {
        return res.status(404).json({ ok: false, error: `Unknown or unavailable pair: ${req.body?.pair}` });
      }
      const timestamp = new Date().toISOString();
      // The attestation covers the FULL canonical representation (including the scaled integer),
      // so an on-chain/integer consumer that trusts `priceScaled` is verifying a signed value.
      const signedFields = ['pair', 'quoteCurrency', 'price', 'priceScaled', 'priceScaleDecimals', 'timestamp'];
      const body = {
        ok: true,
        oracle: getAddress(),
        pair: price.pair,
        symbol: price.symbol,
        // Authoritative price: exact decimal string, quoted in USD.
        price: price.price,
        quoteCurrency: price.quoteCurrency, // "USD"
        source: price.source, // "coingecko"
        // Optional integer form for on-chain consumers. PRICE precision only — NOT any token's
        // on-chain decimals. Now covered by the attestation.
        priceScaled: price.priceScaled,
        priceScaleDecimals: price.priceScaleDecimals,
        timestamp,
      };
      // Sign EXACTLY the values returned, in signedFields order and types.
      const signedData = signedFields.map((f) => body[f]);
      body.signedFields = signedFields;
      body.attestation = await attest(signedData);
      res.json(body);
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
