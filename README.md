# price-oracle-anchor (Keeta, TESTNET ONLY)

[![CI](https://github.com/brownthundercrypto-wq/keeta-price-oracle/actions/workflows/ci.yml/badge.svg)](https://github.com/brownthundercrypto-wq/keeta-price-oracle/actions/workflows/ci.yml)

A price-feed oracle anchor built on the AnchorFactory FX-anchor pattern. It pulls USD prices from
**up to six independent sources**, aggregates them by **median**, and serves signed (attested)
quotes over HTTP — both **spot** and **time-weighted (TWAP)**. The latest spot price is kept in an
**in-memory cache** (refreshed every 60s; it simply repopulates on the next poll), while the
**TWAP / history time-series is persisted in SQLite on a mounted volume, so it survives restarts and
redeploys**. Signed price snapshots are published on-chain as `SET_INFO` blocks on the anchor's own
chain via a **push feed** (heartbeat *and* deviation triggers — see below).

> **TESTNET ONLY.** The process hard-fails (exits) if the network is anything other than `test`.

## What it does (v3 scope)

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
- **Time-weighted average price (TWAP)** — for every pair, `/getPrice` returns signed **`twap1h`** and
  **`twap24h`**, and **`/twap`** returns a single window on its own signed attestation. TWAP is a
  *proper* time-weighted average — each recorded median is weighted by **how long it was the current
  price**, not a naive average of samples (carry-in is clipped to the window start). Until a window has
  enough history to cover its full span, the value is the string **`"building"`** (also signed) rather
  than a **misleading partial number**. TWAP is served off the persisted time-series and is **API-only —
  it is never added to the on-chain snapshot** (keeps the `SET_INFO` payload within its size limit).
- **Persisted time-series** — each published median is recorded in **SQLite (`better-sqlite3`)** at
  `DB_PATH`, which on the deployed host points at a **mounted volume so the TWAP window and history
  survive restarts/redeploys**. Old rows are pruned past the longest window + a carry-in buffer. (The
  60s spot cache is separate and in-memory — it just repopulates on the next poll.)
- **On-chain publishing (push feed)** — the snapshot is **not** on a fixed timer. A trigger evaluator
  publishes a fresh signed `SET_INFO` snapshot of all pairs (base64-encoded JSON in the `metadata`
  field, chained off the account's current head, with a `generateFeeBlock` callback) when **either**:
  - **heartbeat** — a heartbeat interval (`HEARTBEAT_SECONDS`, default **1800** = 30 min) has elapsed
    since the last on-chain publish, **or**
  - **deviation** — any pair's median has moved more than `DEVIATION_THRESHOLD_PCT` (default **0.5%**)
    versus that pair's **last-published-on-chain** price (baseline persisted in SQLite, so it survives
    restarts and only advances on a *successful* publish).

  Publish frequency is bounded to cap fees: a `MIN_PUBLISH_INTERVAL_SECONDS` floor (default **60**;
  deviation bursts are coalesced into one publish when the interval clears) and a
  `MAX_PUBLISHES_PER_HOUR` cap (default **30**). On the very first run with no baseline it publishes
  once to establish it.
- **Discovery** — a second `SET_INFO` publishes discovery metadata under a custom
  `services.oracle` key (non-standard category, by design). It also declares a **volume-only fee
  schedule** (free = 100 queries/day with full signed attestation, spot price, and full history;
  paid = higher/unlimited volume) marked `beta: currently free`. This is **declared only and NOT
  enforced** by the server.
- **Serialized publishing** — every `SET_INFO` publish (startup discovery and every push-feed
  snapshot) goes through a single in-process async mutex, and `currentHeadBlock` is re-read fresh
  inside the critical section before each publish; a wedged head self-heals via `recover()` + retry.
  This prevents two publishes from overlapping and forking the account head
  (`LEDGER_SUCCESSOR_VOTE_EXISTS`).
- **Signed responses** — every price payload is signed with anchor `SignData` over the full
  canonical tuple `[pair, quoteCurrency, price, priceScaled, priceScaleDecimals, method, sources,
  confidenceBand, confidencePct, twap1h, twap24h, timestamp]`, so the value, its provenance, its
  confidence, and its TWAPs are all attested. **Always build the signed-values array from the
  response's own `signedFields` list, in order — do not hardcode it, the set grows.**

## Endpoints

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET  | `/health`          | —                     | version, uptime, lastPriceUpdate, liveSourceCount, per-pair status |
| POST | `/getPrice`        | `{ "pair": "KTA-USD" }` | latest median price + signed (provenance-attested) quote, incl. signed `twap1h` / `twap24h` |
| POST | `/twap`            | `{ "pair": "KTA-USD", "window": "1h" }` | time-weighted average for a single window (`1h` or `24h`), with its own signed attestation (value or `"building"`) |
| POST | `/proof`           | `{ "pair": "KTA-USD" }` | per-source raw values + timestamps, used vs dropped, method, median, attestation |
| POST | `/getPriceHistory` | `{ "pair": "KTA-USD", "limit": 10 }` | last N on-chain snapshots (from the push feed) |

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
  "twap1h": "0.11701",           // SIGNED: 1h time-weighted average, or "building" until enough history
  "twap24h": "building",          // SIGNED: 24h TWAP (here still warming up)
  "twapDetail": { "1h": { "status": "ready", "haveSeconds": 5400, "windowSeconds": 3600 }, "24h": { "status": "building", "haveSeconds": 5400, "windowSeconds": 86400 } }, // unsigned detail
  "liveSourceCount": 6,
  "stale": false,
  "timestamp": "2026-07-18T03:20:59.346Z",
  "signedFields": ["pair", "quoteCurrency", "price", "priceScaled", "priceScaleDecimals", "method", "sources", "confidenceBand", "confidencePct", "twap1h", "twap24h", "timestamp"],
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

## Consume the feed

Two ways to consume the oracle — pick whichever fits your app. **Path A (HTTP)** gives a rich,
per-request signed quote (spot + confidence + TWAP). **Path B (on-chain)** reads the latest published
price set straight from the Keeta ledger with no HTTP dependency at all.

### Path A — HTTP API (signed, verified) — integrate in 5 minutes

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

### Path B — On-chain (read the ledger directly)

The payoff of the push feed: read the **latest published snapshot straight off the oracle account's
own chain** of `SET_INFO` blocks — **no HTTP API, no oracle code**, only `@keetanetwork/keetanet-client`.
A runnable reader is in [`examples/onchain-consumer.mjs`](examples/onchain-consumer.mjs).

```js
// npm i @keetanetwork/keetanet-client
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const KeetaNet = require('@keetanetwork/keetanet-client');
const { Account } = KeetaNet.lib;

const ORACLE = 'keeta_aaba7633k7zfn3hhavs7xh2yd27qdmbtspi5npnkvcvz7ticezcxmv6h3375hly';
const account = Account.fromPublicKeyString(ORACLE);
const client = KeetaNet.UserClient.fromNetwork('test', null, { account }); // null signer = READ-ONLY

const blocks = await client.chain();                       // the oracle account's blocks, newest first
for (const block of blocks) {
  const ops = block.operations || block.toJSON?.().operations || [];
  for (const op of ops) {
    const metadata = op.metadata ?? op.toJSON?.().metadata;
    if (op.type === 2 /* SET_INFO */ && metadata) {         // decode the base64 JSON metadata
      const snap = JSON.parse(Buffer.from(metadata, 'base64').toString('utf8'));
      if (snap.type === 'price-snapshot') {                 // the latest one wins (newest first)
        console.log(snap.timestamp, snap.prices['KTA-USD'].price, snap.prices['KTA-USD'].quoteCurrency);
        return;
      }
    }
  }
}
```

```bash
node examples/onchain-consumer.mjs                 # KTA-USD, live testnet oracle account
node examples/onchain-consumer.mjs BTC-USD         # any published pair
```

**Read-only + authenticity.** The reader builds a **read-only** client (`null` signer) — it never
constructs or publishes a block, so it can't fork the oracle's head (single-writer rule). Because the
snapshot lives on the **oracle account's own chain**, and only the oracle's key can write there,
reading it from that account is itself the provenance guarantee — the on-chain path needs no separate
signature check (the HTTP path carries an explicit attestation instead).

> **Decimals note.** This oracle reports a USD **price**, never a token amount, so it deliberately
> does **not** emit any token's on-chain decimals (e.g. testnet KTA = 9 dp) — conflating the two is a
> scaling footgun. `priceScaleDecimals` is *price* fixed-point precision, unrelated to token decimals.

## Demo: an atomic on-chain swap settled at the oracle price

[`examples/swap-at-oracle-price.mjs`](examples/swap-at-oracle-price.mjs) runs a **real, atomic
KTA↔BTC swap on Keeta testnet that settles at the oracle's signed price.** It's the end-to-end
payoff: a signed oracle number driving a real on-chain settlement.

**What it proves.** It fetches `KTA-USD` and `BTC-USD` from the live oracle, **verifies both
signatures**, computes the cross rate, then settles **one atomic vote staple** — party A sends *X*
KTA to B and B sends *Y* BTC to A, where *X/Y* equals the oracle cross rate — via Keeta's native
`createSwapRequest`/`acceptSwapRequest`. Both legs settle atomically or neither does. It saves a
proof bundle ([`examples/swap-proof.json`](examples/swap-proof.json)) with the verified signed
prices, the computed rate, the **per-account block hashes**, and a check that the settled amounts
match the oracle rate within rounding. A real run:

```
KTA-USD = 0.1172… (verified: true)   BTC-USD = 64771.53 (verified: true)   1 BTC = 545,795.04 KTA
swap: A sends 10 KTA  <->  B sends 0.00001832 BTC   (KTA 9dp, BTC 8dp, exact)
per-account blocks — A: 91AFCB9B…D8D3E2C7 (SEND 10 KTA + RECEIVE BTC),  B: 2CD93E15…B2CBFD1F (SEND BTC)
swap legs EXACT: true   implied BTC-USD 64778.24 vs oracle 64771.53 (error 0.0104%)
```

### Verify it yourself
An atomic swap settles as a vote **staple**, whose `blocksHash` is an internal aggregate identifier
that block explorers do **not** index. What *is* resolvable is each account's own **block** (by hash)
and its **history**. Two ways to check:

- **Read-only script (authoritative — no HTTP oracle, no seeds):**
  ```bash
  node examples/verify-swap-onchain.mjs <addressA> <addressB>
  ```
  It reads both accounts' chains directly from the ledger and prints the swap blocks: A's block that
  SENDs KTA to B and RECEIVEs BTC from B, and B's block that SENDs the matching BTC to A.
- **Explorer:** open the [testnet explorer](https://explorer.test.keeta.com) and paste an **account
  address** (or a **block hash**) — e.g. `https://explorer.test.keeta.com/account/<addressA>`. (Deep
  links return an HTTP 404 status but still serve the app, which resolves the address client-side via
  the same node API.)

**Honest framing.** Both accounts (A and B) are controlled by the **same operator** — the script
holds both throwaway seeds. This demonstrates the **mechanism** (a signed oracle price driving a real
atomic on-chain settlement between two Keeta accounts), **not** a third-party trade or price
discovery. The "BTC" is a real Keeta testnet token (name `BTC`, 8 dp); party B was pre-loaded with it
(standing in for an FX-anchor acquisition). The rounding error is the 8-dp quantization of the BTC leg.

**How to run** (never uses the oracle's seed — two fresh throwaway seeds from env):
```bash
# fund two fresh testnet accounts with KTA (https://faucet.test.keeta.com) and give B some BTC token
SWAP_SEED_A=<hexA> SWAP_SEED_B=<hexB> node examples/swap-at-oracle-price.mjs 10   # 10 = KTA A sends
# optional env: BTC_TOKEN, KTA_TOKEN, ORACLE_URL
```
It refuses to run if a swap seed equals `APP_SEED` (that would fork the live oracle chain), and it
never touches the oracle account — A and B are independent accounts, so the single-writer rule isn't
involved.

### Verifying an attestation
The attestation covers the **full canonical representation** — the value, its scaled integer form,
**its provenance** (`method` + ordered `sources`), **its confidence** (`confidenceBand` +
`confidencePct`), **and its TWAPs** (`twap1h` + `twap24h`) — so `signedFields` is
`[pair, quoteCurrency, price, priceScaled, priceScaleDecimals, method, sources, confidenceBand, confidencePct, twap1h, twap24h, timestamp]`,
signed in that exact order and with those exact types (`priceScaleDecimals` is a number; `sources` is
the ordered comma-joined source-name string; TWAP fields are a value string or `"building"`).

**Always build the signed-values array from the response's own `signedFields` list, in order — do
not hardcode it, the set grows.** Verify with:

```js
import { VerifySignedData } from '@keetanetwork/anchor/lib/utils/signing.js';
const data = response.signedFields.map(f => response[f]); // exact returned values, in order — never hardcode the list
const ok = await VerifySignedData(oracleAccount, data, response.attestation);
// ok === true; tampering ANY signed field (e.g. priceScaled or twap1h alone) -> false
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
SIGNED_FIELDS=["pair","quoteCurrency","price","priceScaled","priceScaleDecimals","method","sources","confidenceBand","confidencePct","twap1h","twap24h","timestamp"]
SIGNED_VALUES=["KTA-USD","USD","0.1163255","11632550",8,"median","bitmart,coinbase,coingecko,coinpaprika,kraken,mexc","0.0001012676","0.087055","building","building","2026-07-18T03:20:59.346Z"]
VERIFY=true
VERIFY_TAMPERED_PRICE=false
VERIFY_TAMPERED_SCALED=false
VERIFY_TAMPERED_SOURCES=false
VERIFY_TAMPERED_CONFIDENCE=false
VERIFY_TAMPERED_TWAP1H=false
```

## Tests & CI

A hermetic unit suite (Node's built-in runner — `node:test` + `node:assert`, no extra deps) covers
the core logic with **no network, no chain writes, and no real seed**: sources are represented by
plain arrays, the time-series uses an in-memory SQLite, and signing uses a throwaway keypair
generated in-test.

```bash
npm test        # node --test  -> runs everything under test/
```

Coverage (`test/`): median (odd/even/single/unsorted), decimal ↔ `priceScaled` round-trip, the
outlier guard + stale (never single-source) + confidence, TWAP time-weighting (uneven durations,
carry-in clipped to the window start, cold-start `"building"`), sign/verify with per-field tamper
tests, the on-chain snapshot size guard (`< 5000`), the push-feed trigger logic (deviation,
heartbeat, min-interval coalescing, per-hour cap, first-run baseline), the **alert decision logic**
(transition-only firing, no re-fire while bad, recovery, cooldown reminder), and the **rate limiter**
(allow under limit, block over, refill over time, per-IP isolation, global cap, and client-IP
resolution that trusts N proxy hops from the right so a spoofed leftmost XFF can't mint a fresh bucket).

**CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `npm ci && npm test` on Node
22.x for every push and pull request (see the badge at the top). No secrets, no deploy.

## Monitoring & alerts

The oracle self-monitors and posts to an optional **Discord webhook** so you know within ~60s when
it is **degraded** (not just down). It is purely observational — it never touches signing,
aggregation, or publishing. Alerts fire on **state transitions only** (once when a condition goes
bad, once when it recovers), with a single optional reminder after a cooldown, so a persistent
problem never spams the channel.

Conditions (evaluated every 30s and on each publish):

| Condition | Fires when |
|---|---|
| Pair stale | a pair drops below `MIN_SOURCES` / has no fresh update |
| Sources floor | distinct `liveSourceCount` across all pairs `< ALERT_MIN_SOURCES` |
| Publish failure | an on-chain publish exhausts the self-heal retries (recovers when one lands) |
| High disagreement | a pair's signed `confidencePct` `> ALERT_DISAGREEMENT_PCT` |
| Start / restart | one-shot `started: vX, N sources` notice so restarts are visible |

Individual source fetch errors (e.g. CoinGecko 429 from a datacenter IP) do **not** alert — only a
breach of the `liveSourceCount` floor does.

**Env (all optional; defaults in parentheses):**

| Var | Purpose |
|---|---|
| `ALERT_WEBHOOK_URL` | Discord webhook URL. **Secret — set on Railway only, never commit.** Unset → alerting disabled (conditions are logged locally instead). |
| `ALERT_MIN_SOURCES` | live-source floor (`3`) |
| `ALERT_DISAGREEMENT_PCT` | `confidencePct` above which a pair is flagged (`2`) |
| `ALERT_REALERT_MINUTES` | reminder cooldown while a condition stays bad (`60`; `0` disables reminders) |

### Receiving alerts (Discord)

1. In Discord: **Server Settings → Integrations → Webhooks → New Webhook**, pick a channel, **Copy
   Webhook URL** (looks like `https://discord.com/api/webhooks/<id>/<token>`).
2. Set it on Railway (never in the repo): `railway variables --set "ALERT_WEBHOOK_URL=<url>" --service keeta-price-oracle` (this redeploys). On the next start you'll get the `started: …` notice.
3. **Fire a one-off TEST alert** to confirm delivery — `npm run alert:test` (or `node src/alerter.js`) with `ALERT_WEBHOOK_URL` set:
   - locally: `ALERT_WEBHOOK_URL=<url> npm run alert:test`
   - on Railway (uses the service's env): `railway run npm run alert:test`

   The payload is Discord-format `{"content":"…"}`; a `[keeta-price-oracle testnet] ✅ TEST alert …`
   message appears in the channel.

## Rate limiting (abuse protection)

The POST API endpoints are rate-limited with a **token bucket** so the public endpoints can't be
hammered — without breaking the open "just curl it" experience. Defaults are generous: a human
curling, or a dashboard polling every few seconds, is **never** limited; only sustained hammering
gets `429`'d.

- **Per client IP** — sustained `RATE_LIMIT_PER_MIN` requests/min with bursts up to
  `RATE_LIMIT_BURST`. The client IP is derived from **`X-Forwarded-For`**, trusting
  `TRUST_PROXY_HOPS` hops **from the right** (`parts[len - 1 - hops]`) — i.e. the entry the trusted
  proxy appended, **not** the client-spoofable leftmost. Verified on the live service: Railway's edge
  rewrites XFF to `<real-client>, <one internal hop>` and discards client-supplied XFF, so the
  default `TRUST_PROXY_HOPS=1` resolves the real client and an injected leftmost entry can't mint a
  fresh bucket. A missing header falls back to the socket address safely.
- **Global** — an instance-wide cap of `RATE_LIMIT_GLOBAL_PER_MIN` requests/min across all clients,
  the backstop that bounds abuse even if per-IP keying is ever imperfect.
- **Applies to:** `POST /getPrice`, `/proof`, `/twap`, `/getPriceHistory`. **Exempt:** `GET /` and
  `GET /health` (so UptimeRobot + the internal monitor are never throttled).
- **On limit:** `HTTP 429` + a `Retry-After: <seconds>` header + a small JSON body
  `{ "ok": false, "error": "rate limited: …", "retryAfter": <seconds> }` (no internals leaked).

The limiter state is **in-memory**, which is correct for the current single-instance deploy
(`numReplicas: 1`). Fully-replenished buckets are pruned so memory can't grow unbounded. A
multi-instance deploy (Tier 3) would need **shared state (e.g. Redis)** to enforce limits across
replicas.

| Var | Purpose |
|---|---|
| `RATE_LIMIT_PER_MIN` | per-IP sustained requests/min (`60`) |
| `RATE_LIMIT_BURST` | per-IP burst allowance (`30`) |
| `RATE_LIMIT_GLOBAL_PER_MIN` | instance-wide cap across all clients (`600`) |
| `TRUST_PROXY_HOPS` | trusted proxy hops for client-IP resolution (`1`; Railway = 1, set `0` for direct/local) |

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
(default `test`; any other value → immediate exit), `DB_PATH` (persisted time-series location;
default `./data/prices.sqlite`, a mounted volume on the deployed host). Push-feed tuning (all
optional, with the defaults noted above): `HEARTBEAT_SECONDS`, `DEVIATION_THRESHOLD_PCT`,
`MIN_PUBLISH_INTERVAL_SECONDS`, `MAX_PUBLISHES_PER_HOUR`. `OUTLIER_THRESHOLD_PCT` (default `2`) and
`COINGECKO_API_KEY` (optional) are also honored. Monitoring/alerting (see **Monitoring & alerts**):
`ALERT_WEBHOOK_URL` (secret), `ALERT_MIN_SOURCES`, `ALERT_DISAGREEMENT_PCT`, `ALERT_REALERT_MINUTES`.
Rate limiting (see **Rate limiting**): `RATE_LIMIT_PER_MIN`, `RATE_LIMIT_BURST`,
`RATE_LIMIT_GLOBAL_PER_MIN`, `TRUST_PROXY_HOPS`.

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
