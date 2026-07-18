# keeta-price-oracle-client

One-line client for the [Keeta testnet price oracle](https://github.com/brownthundercrypto-wq/keeta-price-oracle),
with **signature verification built in and ON by default**. You get a price only if its cryptographic
attestation checks out against the oracle's public key — verification is the whole point.

> **Testnet.** Prices are for development use only, no real value.

## Install

```bash
npm install keeta-price-oracle-client
```

Requires Node ≥ 18 (global `fetch`). Pulls in `@keetanetwork/keetanet-client` and `@keetanetwork/anchor`
(needed to verify signatures), pinned to the versions the oracle signs with.

## Quickstart (verified price in ~3 lines)

```js
import { createClient } from 'keeta-price-oracle-client';

const oracle = createClient();                 // defaults to the live testnet oracle
const q = await oracle.getPrice('KTA-USD');     // signature VERIFIED by default — throws if it fails
console.log(`${q.pair} = ${q.price} ${q.quoteCurrency}`);
```

If the signature doesn't verify, `getPrice` throws `OracleError` with `code === 'VERIFICATION_FAILED'` —
you never get an unverified number by accident.

Point it at any instance:

```js
const oracle = createClient({ baseUrl: 'https://my-oracle.example.com' });
```

## Verification is ON by default (that's the point)

`getPrice` verifies the attestation before returning. It's **clean-room**: it rebuilds the oracle account
from only the response's `oracle` pubkey, builds the signed-values array from the response's own
`signedFields` (in order), and checks it with anchor's `VerifySignedData`. Nothing trusts the server
beyond its public key. Opt out explicitly (not recommended) with `{ verify: false }`.

## API

### `createClient(options?) → OracleClient`
| Option | Default | Purpose |
|---|---|---|
| `baseUrl` | live oracle URL | HTTP base URL of the oracle instance |
| `fetch` | global `fetch` | inject a `fetch` implementation (e.g. to mock in tests) |
| `oracle` | live oracle account | oracle pubkey for `readLatestOnChain` |
| `network` | `'test'` | Keeta network for `readLatestOnChain` |

### `client.getPrice(pair, { verify = true }) → Promise<PriceResponse>`
Fetches `/getPrice`. Verifies the signature by default; throws `OracleError('VERIFICATION_FAILED')` on
mismatch. Returns the typed, signed price (exact decimal `price` string, `priceScaled`, confidence,
`twap1h`/`twap24h`, `sources`, `signedFields`, `attestation`, …).

### `client.getProof(pair) → Promise<ProofResponse>`
Where the price came from: each source's raw value, `sourcesUnreachable` vs `sourcesOutliers` (with
deviation %), and the attestation.

### `client.getTwap(pair, window = '1h') → Promise<TwapResponse>`
Signed time-weighted average for `'1h'` or `'24h'` (value string or `"building"`).

### `client.getHistory(pair, limit = 10) → Promise<HistoryResponse>`
The last N on-chain snapshots for a pair (from the push feed).

### `client.readLatestOnChain(pair?) → Promise<OnChainEntry | OnChainSnapshot | null>`
Reads the **latest published snapshot straight from the ledger — no HTTP API**. Builds a **read-only**
client (never publishes), so it can't fork the oracle's head. Authenticity comes from the data living on
the oracle account's own chain (only the oracle key can write there). Returns the pair's entry (with
`blockHash`/`timestamp`) when `pair` is given, the whole snapshot when omitted, or `null` if none.

```js
const onchain = await oracle.readLatestOnChain('BTC-USD');
console.log(onchain.price, onchain.blockHash);
```

### `verify(response) → Promise<boolean>`  (also `client.verify`)
Standalone clean-room verification of any signed response. Returns `true`/`false` (never throws for a
well-formed-but-invalid payload).

```js
import { verify } from 'keeta-price-oracle-client';
const q = await oracle.getPrice('KTA-USD', { verify: false });
if (!(await verify(q))) throw new Error('bad signature');
```

### Errors — `OracleError`
Every failure is an `OracleError` with a typed `code`:

| `code` | When | Extra |
|---|---|---|
| `VERIFICATION_FAILED` | signature didn't verify | `.response` |
| `RATE_LIMITED` | HTTP 429 from the oracle | `.status`, `.retryAfter` (seconds) |
| `STALE` | HTTP 503 — pair stale, no usable price | `.status`, `.response` |
| `NOT_FOUND` | HTTP 404 — unknown pair | `.status`, `.response` |
| `HTTP_ERROR` | other non-2xx / `{ok:false}` | `.status`, `.response` |
| `NETWORK` | fetch threw (DNS/connection) | — |
| `BAD_RESPONSE` | non-JSON body | `.status` |

```js
import { OracleError } from 'keeta-price-oracle-client';
try {
  await oracle.getPrice('KTA-USD');
} catch (e) {
  if (e instanceof OracleError && e.code === 'RATE_LIMITED') {
    console.log(`slow down, retry after ${e.retryAfter}s`);
  } else throw e;
}
```

## TypeScript

Ships `index.d.ts`. `PriceResponse`, `ProofResponse`, `TwapResponse`, `HistoryResponse`,
`OnChainEntry`, `ClientOptions`, `OracleError`, and `ErrorCode` are all exported.

## Tests

```bash
npm test        # node --test — hermetic: fetch is mocked, payloads signed with a throwaway keypair
```
Proves `getPrice` verifies a genuine payload and **rejects a tampered one**, and that 429 / stale /
not-found / network map to typed errors. (In this monorepo the suite also runs from the repo root's
`npm test`, and CI runs it on every push/PR.)

## Publishing (maintainer)

This package is publish-ready but **not yet published**. To publish under your own npm scope:

```bash
# 1. (optional) rename to your scope in package.json, e.g. "@yourname/keeta-price-oracle-client"
cd sdk
npm login
npm publish --access public      # --access public is required for a scoped name (already set in publishConfig)
```

`package.json` already sets `"publishConfig": { "access": "public" }` and a `files` allowlist
(`index.js`, `index.d.ts`, `README.md`) so only the package artifacts are published. Bump `version`
before each publish (`npm version patch|minor|major`).

## License

MIT
