# price-oracle-anchor (Keeta, TESTNET ONLY)

A price-feed oracle anchor built on the AnchorFactory FX-anchor pattern. It pulls USD prices
from the CoinGecko free API, caches them in memory, publishes signed price snapshots on-chain as
`SET_INFO` blocks on the anchor's own chain, and serves signed (attested) quotes over HTTP.

> **TESTNET ONLY.** The process hard-fails (exits) if the network is anything other than `test`.

## What it does (v1 scope)

- **Data source** — one call to CoinGecko `/api/v3/simple/price` for ids `keeta, bitcoin, ethereum,
  usd-coin, euro-coin` priced in `usd`. Polled every **60s**, cached in memory.
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
- **Signed responses** — every price payload is signed with anchor `SignData(account,
  [pair, price, timestamp])`, so consumers get an attested quote.

## Endpoints

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET  | `/health`          | —                     | status, oracle address, cached pairs |
| POST | `/getPrice`        | `{ "pair": "KTA-USD" }` | latest cached price + signed attestation |
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
  "price": "0.121054",          // authoritative: exact decimal STRING
  "quoteCurrency": "USD",
  "source": "coingecko",
  "priceScaled": "12105400",     // optional integer form for on-chain consumers
  "priceScaleDecimals": 8,       // PRICE precision only — NOT any token's on-chain decimals
  "timestamp": "2026-07-17T23:06:51.242Z",
  "signedFields": ["pair", "quoteCurrency", "price", "priceScaled", "priceScaleDecimals", "timestamp"],
  "attestation": { "nonce": "...", "timestamp": "...", "signature": "..." }
}
```

> **Decimals note.** This oracle reports a USD **price**, never a token amount, so it deliberately
> does **not** emit any token's on-chain decimals (e.g. testnet KTA = 9 dp) — conflating the two is a
> scaling footgun. `priceScaleDecimals` is *price* fixed-point precision, unrelated to token decimals.

### Verifying an attestation
The attestation covers the **full canonical representation** — every field an integer/on-chain
consumer might trust, including `priceScaled` — so `signedFields` is
`[pair, quoteCurrency, price, priceScaled, priceScaleDecimals, timestamp]`, signed in that exact
order and with those exact types (`priceScaleDecimals` is a number). Verify with:

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
SIGNED_FIELDS=["pair","quoteCurrency","price","priceScaled","priceScaleDecimals","timestamp"]
SIGNED_VALUES=["KTA-USD","USD","0.118981","11898100",8,"2026-07-18T01:55:47.143Z"]
VERIFY=true
VERIFY_TAMPERED_PRICE=false
VERIFY_TAMPERED_SCALED=false
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
