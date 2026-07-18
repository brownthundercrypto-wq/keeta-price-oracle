# price-oracle-anchor (Keeta, TESTNET ONLY)

A price-feed oracle anchor built on the AnchorFactory FX-anchor pattern. It pulls USD prices
from the CoinGecko free API, caches them in memory, publishes signed price snapshots on-chain as
`SET_INFO` blocks on the anchor's own chain, and serves signed (attested) quotes over HTTP.

> **TESTNET ONLY.** The process hard-fails (exits) if the network is anything other than `test`.

## What it does (v2 scope)

- **Multi-source data** — for every pair, prices are fetched from **up to six independent sources**
  and the **median** is published (even counts average the two middle values). USD-quoted:
  **CoinGecko, Coinbase, Kraken, CoinPaprika**. USDT-quoted (treated as a 1:1 USD proxy — the median
  rejects any USDT-depeg outlier): **MEXC, Bitmart**. Not every venue lists every pair (e.g. MEXC has
  no EURC); a source that doesn't list a pair is skipped, not counted as dropped. Each source's raw
  value + fetch timestamp is recorded. **≥ 2 live sources are required to publish**; if fewer respond,
  the pair is marked **stale** rather than serving a single-source number. Polled every **60s**.
  - **`COINGECKO_API_KEY`** (optional): when set, CoinGecko requests send the `x-cg-demo-api-key`
    header so they aren't rate-limited (HTTP 429) from datacenter IPs. Unset → anonymous CoinGecko.
    The keyless sources already keep the live instance at ≥ 3 without a key.
- **Signed provenance** — the attestation covers the aggregation `method` (`"median"`) and the
  ordered `sources` list, so consumers verify *which sources and method* produced the price, not
  just the number.
- **Identity** — derived from `APP_SEED` (hex) via `KeetaNet.lib.Account.fromSeed(seed, 0)`.
- **On-chain publishing** — every **5 minutes** the current snapshot is published as a `SET_INFO`
  block (base64-encoded JSON in the `metadata` field), chained off the account's current head.
  A `generateFeeBlock` callback is passed to the publish call.
- **Discovery** — a second `SET_INFO` publishes discovery metadata under a custom
  `services.oracle` key (non-standard category, by design). It also declares a **volume-only fee
  schedule** (free = 100 queries/day with full signed attestation, spot price, and full history;
  paid = higher/unlimited volume) marked `beta: currently free`. This is **declared only and NOT
  enforced** by the server.
- **Serialized publishing** — every `SET_INFO` publish (startup discovery, startup snapshot, and
  the 5-minute timer) goes through a single in-process async mutex, and `currentHeadBlock` is
  re-read fresh inside the critical section before each publish. This prevents two publishes from
  overlapping and forking the account head (`LEDGER_SUCCESSOR_VOTE_EXISTS`).
- **Signed responses** — every price payload is signed with anchor `SignData` over the full
  canonical tuple `[pair, quoteCurrency, price, priceScaled, priceScaleDecimals, method, sources,
  timestamp]`, so both the value and its provenance are attested.

## Endpoints

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET  | `/health`          | —                     | version, uptime, lastPriceUpdate, liveSourceCount, per-pair status |
| POST | `/getPrice`        | `{ "pair": "KTA-USD" }` | latest median price + signed (provenance-attested) quote |
| POST | `/proof`           | `{ "pair": "KTA-USD" }` | per-source raw values + timestamps, used vs dropped, method, median, attestation |
| POST | `/getPriceHistory` | `{ "pair": "KTA-USD", "limit": 10 }` | last N on-chain snapshots |

`pair` accepts the pair (`KTA-USD`), symbol (`KTA`), or CoinGecko id (`keeta`), case-insensitive.
Supported pairs: `KTA-USD, BTC-USD, ETH-USD, USDC-USD, EURC-USD`. (There is intentionally **no**
`subscribe` endpoint.)

`/getPriceHistory` **normalizes on read**: on-chain history is never rewritten, but any pre-fix
snapshot (which stored token `decimals` + numeric `priceUsd`) is mapped to the current shape
(`price` string + `quoteCurrency` + derived `priceScaled`) and tagged `legacyShape: true`, so
consumers always get one consistent format. New blocks are `legacyShape: false`.

### `/getPrice` response

```json
{
  "ok": true,
  "oracle": "keeta_aab...",
  "pair": "KTA-USD",
  "symbol": "KTA",
  "price": "0.1173",             // authoritative: exact decimal STRING (median of live sources)
  "quoteCurrency": "USD",
  "priceScaled": "11730000",     // optional integer form for on-chain consumers
  "priceScaleDecimals": 8,       // PRICE precision only — NOT any token's on-chain decimals
  "method": "median",            // SIGNED
  "sources": "bitmart,coinbase,coingecko,coinpaprika,kraken,mexc", // SIGNED: ordered provenance (survivors)
  "sourceList": ["bitmart", "coinbase", "coingecko", "coinpaprika", "kraken", "mexc"], // array (unsigned convenience)
  "confidenceBand": "0.0001012676", // SIGNED: absolute agreement band, USD price units (std-dev of survivors)
  "confidencePct": "0.087055",      // SIGNED: relative agreement %  (reject high values to skip low-confidence prices)
  "liveSourceCount": 6,
  "stale": false,
  "timestamp": "2026-07-18T03:20:59.346Z",
  "signedFields": ["pair", "quoteCurrency", "price", "priceScaled", "priceScaleDecimals", "method", "sources", "confidenceBand", "confidencePct", "timestamp"],
  "attestation": { "nonce": "...", "timestamp": "...", "signature": "..." }
}
```

**Outlier guard.** Before publishing, sources more than a configurable threshold (default **2%**,
`OUTLIER_THRESHOLD_PCT`) from the median center are dropped as likely-bad prints and the median is
recomputed over the survivors; if that leaves fewer than 2, the pair is marked **stale**. `/proof`
distinguishes `sourcesUnreachable` (fetch failed) from `sourcesOutliers` (rejected, with each
source's `deviationPct`), and labels each source's native `quote` (USD vs USDT).

`/proof` returns the same attestation plus the full breakdown — every source's raw value and fetch
timestamp, which sources were used vs dropped, the aggregation method, and the final median. It is
the "show exactly where the price came from" endpoint.

## Integrate in 5 minutes

Fetch a price and **verify its signature** before trusting it — using only the two public packages,
no oracle code. A runnable version is in [`examples/client.mjs`](examples/client.mjs).

```js
// npm i @keetanetwork/keetanet-client @keetanetwork/anchor
import { createRequire } from 'module';
import { VerifySignedData } from '@keetanetwork/anchor/lib/utils/signing.js';
const require = createRequire(import.meta.url);
const { Account } = require('@keetanetwork/keetanet-client').lib;

const BASE = 'https://keeta-price-oracle-production.up.railway.app';
const q = await (await fetch(`${BASE}/getPrice`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pair: 'KTA-USD' }),
})).json();

const account = Account.fromPublicKeyString(q.oracle);
const values = q.signedFields.map((f) => q[f]);          // exact signed values, in order
if (!(await VerifySignedData(account, values, q.attestation))) throw new Error('invalid signature');

console.log(`${q.pair} = ${q.price} ${q.quoteCurrency}`); // only trust it once verified
```

```bash
node examples/client.mjs                 # KTA-USD from the live endpoint
node examples/client.mjs BTC-USD         # any supported pair
```

> **Decimals note.** This oracle reports a USD **price**, never a token amount, so it deliberately
> does **not** emit any token's on-chain decimals (e.g. testnet KTA = 9 dp) — conflating the two is a
> scaling footgun. `priceScaleDecimals` is *price* fixed-point precision, unrelated to token decimals.

### Verifying an attestation
The attestation covers the **full canonical representation** — the value, its scaled integer form,
**its provenance** (`method` + ordered `sources`), **and its confidence** (`confidenceBand` +
`confidencePct`) — so `signedFields` is
`[pair, quoteCurrency, price, priceScaled, priceScaleDecimals, method, sources, timestamp]`, signed
in that exact order and with those exact types (`priceScaleDecimals` is a number; `sources` is the
ordered comma-joined source-name string). Verify with:

```js
import { VerifySignedData } from '@keetanetwork/anchor/lib/utils/signing.js';
const data = signedFields.map(f => response[f]); // exact returned values, in order
const ok = await VerifySignedData(oracleAccount, data, attestation);
// ok === true; tampering ANY signed field (e.g. priceScaled alone) -> false
```

### Standalone verifier: `verify-attestation.mjs`

A **clean-room, consumer-side** proof that any third party can run. It imports **none** of this
oracle's own code — only `@keetanetwork/keetanet-client` (`Account.fromPublicKeyString`) and
`@keetanetwork/anchor` (`VerifySignedData`), exactly as an external integrator would. It fetches a
fresh `/getPrice` from the live endpoint, rebuilds the oracle account from only the response's
`oracle` pubkey, maps the response's own `signedFields` to values in order, verifies the
attestation, and runs two tamper tests (mutating `price` alone and `priceScaled` alone — both must
fail).

```bash
npm install                       # once, to fetch the two public packages
node verify-attestation.mjs       # defaults to KTA-USD on the live Railway endpoint
node verify-attestation.mjs BTC-USD https://your-host   # optional: pair + base URL
```

Expected output (live):

```
LIVE_URL=https://keeta-price-oracle-production.up.railway.app/getPrice
PUBKEY=keeta_aaba7633k7...6h3375hly
SIGNED_FIELDS=["pair","quoteCurrency","price","priceScaled","priceScaleDecimals","method","sources","confidenceBand","confidencePct","timestamp"]
SIGNED_VALUES=["KTA-USD","USD","0.1163255","11632550",8,"median","bitmart,coinbase,coingecko,coinpaprika,kraken,mexc","0.0001012676","0.087055","2026-07-18T03:20:59.346Z"]
VERIFY=true
VERIFY_TAMPERED_PRICE=false
VERIFY_TAMPERED_SCALED=false
VERIFY_TAMPERED_SOURCES=false
VERIFY_TAMPERED_CONFIDENCE=false
```

## Run

```bash
# from repo root (this project lives inside the keeta-anchor-builder repo and resolves
# @keetanetwork/* from the repo's node_modules)
cd price-oracle-anchor
npm install                 # installs express; keeta packages come from the parent repo
APP_SEED=<hex-seed> PORT=9010 npm start
```

Then:
```bash
curl -s -X POST http://localhost:9010/getPrice \
  -H 'Content-Type: application/json' -d '{"pair":"KTA-USD"}'
```

Env vars: `APP_SEED` (required, hex seed), `PORT` (default 9010), `KEETA_NETWORK`
(default `test`; any other value → immediate exit).

## Decimals

On-chain token precision is reported per pair so consumers scale correctly. Note **testnet KTA is
9 decimals** (not 18): `KTA=9, BTC=8, ETH=18, USDC=6, EURC=6`.

## Implementation notes / gotchas respected

- `keetanet-client` is CommonJS — loaded via `createRequire`. `@keetanetwork/anchor` is ESM-only —
  loaded via dynamic `import()`.
- `account.publicKeyString.get()` is a getter (called, not read as a property).
- Raw signatures use `(await account.sign(buf)).toString('hex')` (never
  `Buffer.from(...).toString('hex')`, which yields silent all-zero signatures).
- Client created with `UserClient.fromNetwork`, never `new Client()`.

### Two deliberate corrections to the original spec (required for it to run)

1. **Signer, not null.** The spec's `UserClient.fromNetwork('test', null, { account })` produces a
   **read-only** client that throws `"May not construct blocks with a read-only UserClient"` when
   publishing. We pass the account as the signer: `fromNetwork('test', account, { account })`. The
   identity still derives from `APP_SEED`.
2. **Head field name.** The account head is `getAccountInfo().currentHeadBlock`, not `state.head`.
   In practice the builder chains each `SET_INFO` off the current head automatically (equivalent to
   `previous = currentHeadBlock ?? Block.NO_PREVIOUS`).

Both are noted inline in `src/keetaOracle.js`.
