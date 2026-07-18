// Keeta on-chain integration for the price oracle.
//
// Interop gotchas respected:
//  - keetanet-client is CommonJS -> loaded with createRequire(require).
//  - @keetanetwork/anchor is ESM-only -> loaded with dynamic import().
//  - account.publicKeyString.get() is a getter, not a property.
//  - Attestations use anchor's SignData(); raw signatures use (await account.sign(buf)).toString('hex').
//  - Client is created with UserClient.fromNetwork (never new Client()).
//
// SPEC CORRECTION (necessary for it to actually run):
//  The spec asked for fromNetwork('test', null, { account }). A null signer yields a READ-ONLY
//  client that throws "May not construct blocks with a read-only UserClient" when publishing
//  SET_INFO blocks. We therefore pass the account itself as the signer:
//  fromNetwork('test', account, { account }). The account still comes from APP_SEED.
//  (Also: the account head is `currentHeadBlock`, not `state.head`.)

import { createRequire } from 'module';
import { NETWORK, PAIRS, PUBLIC_URL, MIN_SOURCES, VERSION } from './config.js';
import { SOURCE_NAMES } from './sources.js';

const require = createRequire(import.meta.url);
const KeetaNet = require('@keetanetwork/keetanet-client');

const OP_SET_INFO = 2; // KeetaNet.lib.Block.OperationType.SET_INFO

let account = null;
let client = null;
let SignData = null;

// Serialize ALL SET_INFO publishes to the oracle account through a single async mutex, so two
// publishes can never overlap and fork the head (LEDGER_SUCCESSOR_VOTE_EXISTS). Every publish —
// startup discovery, startup snapshot, and the 5-minute timer — routes through this.
let publishMutex = Promise.resolve();
function serialize(fn) {
  const run = publishMutex.then(fn, fn);
  // Keep the chain alive even if a publish rejects (don't wedge the queue on one failure).
  publishMutex = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function initOracle() {
  if (NETWORK !== 'test') {
    throw new Error(`Refusing to run on network '${NETWORK}'. This oracle is TESTNET ONLY.`);
  }
  const seed = process.env.APP_SEED;
  if (!seed) throw new Error('APP_SEED environment variable is required (hex seed).');

  account = KeetaNet.lib.Account.fromSeed(seed, 0);
  // Hard-fail: pass 'test' literally; a non-test network can never be reached here.
  client = KeetaNet.UserClient.fromNetwork('test', account, { account });

  const signing = await import('@keetanetwork/anchor/lib/utils/signing.js');
  SignData = signing.SignData;

  return { address: getAddress() };
}

export function getAddress() {
  return account.publicKeyString.get();
}

// Sign a price payload so consumers get an attested quote.
// `canonicalFields` is the exact ordered array of values to sign (must match the response's
// `signedFields` order and types). Returns { nonce, timestamp, signature }.
export async function attest(canonicalFields) {
  return await SignData(account, canonicalFields);
}

// Publish a SET_INFO block carrying base64-encoded JSON in the metadata field.
// Runs inside the serialize() mutex so publishes can never overlap. Immediately before building,
// currentHeadBlock is re-read fresh inside the critical section; the builder then chains the block
// off that head (equivalent to previous = currentHeadBlock ?? Block.NO_PREVIOUS). The
// generateFeeBlock callback is passed to the publish (transmit) call.
// Returns { blockHash, previous, headBefore } for chaining proof.
function publishSetInfo(name, description, obj) {
  return serialize(async () => {
    // Fresh head read inside the serialized critical section.
    const state = await client.client.getAccountInfo(getAddress());
    const headBefore = state.currentHeadBlock ?? KeetaNet.lib.Block.NO_PREVIOUS;

    const metadata = Buffer.from(JSON.stringify(obj)).toString('base64');
    const builder = client.initBuilder();
    builder.setInfo({ name, description, metadata });
    const computed = await builder.computeBlocks();
    const block = computed.blocks[0];
    const blockHash = block.hash.toString();
    const previous =
      (typeof block.toJSON === 'function' ? block.toJSON().previous : block.previous)?.toString?.() ??
      String(headBefore);

    await client.transmit(computed.blocks, {
      generateFeeBlock: (staple) => builder.computeFeeBlock(staple),
    });
    return { blockHash, previous, headBefore: String(headBefore) };
  });
}

// Publish the current price snapshot as an on-chain SET_INFO block, with compact provenance
// (median price + per-source raw values/timestamps) so the on-chain record shows how each
// price was derived.
export async function publishSnapshot(prices) {
  const compact = {};
  for (const [pair, e] of Object.entries(prices)) {
    compact[pair] = {
      pair: e.pair,
      symbol: e.symbol,
      price: e.price,
      priceScaled: e.priceScaled,
      priceScaleDecimals: e.priceScaleDecimals,
      quoteCurrency: e.quoteCurrency,
      method: e.method,
      sources: e.sources, // ordered, comma-joined provenance
      liveSourceCount: e.liveSourceCount,
      stale: !!e.stale,
      updatedAt: e.updatedAt,
      // Compact on-chain provenance: name+price only, to stay within the SET_INFO metadata size
      // limit. Full per-source detail (ts, native quote, outliers) is served off-chain by /proof.
      sourceReports: (e.sourceReports || []).map((r) => ({ name: r.name, price: r.price })),
    };
  }
  const snapshot = {
    type: 'price-snapshot',
    oracle: getAddress(),
    network: 'test',
    base: 'usd',
    aggregation: 'median',
    timestamp: new Date().toISOString(),
    prices: compact,
  };
  return await publishSetInfo('PRICE_ORACLE', 'Keeta testnet price oracle', snapshot);
}

// Publish discovery metadata via a second SET_INFO using a custom "oracle" key under services.
// ("oracle" is not a standard anchor service category — that is expected.)
export async function publishDiscovery() {
  const base = PUBLIC_URL; // '' in local dev -> endpoints stay relative
  const abs = (p) => (base ? base + p : p);
  const discovery = {
    type: 'service-discovery',
    services: {
      oracle: {
        version: VERSION,
        network: 'test',
        description: 'Multi-source (median) signed USD price feed for KTA/BTC/ETH/USDC/EURC',
        pairs: PAIRS,
        // Multi-source aggregation: independent keyless sources, median-aggregated, min-2 to publish.
        aggregation: {
          method: 'median',
          minSources: MIN_SOURCES,
          sources: SOURCE_NAMES,
        },
        attestation:
          'anchor SignData over [pair, quoteCurrency, price, priceScaled, priceScaleDecimals, method, sources, timestamp] (provenance signed)',
        // Live public base URL (set on the deployed host); absent in local dev.
        baseUrl: base || undefined,
        endpoints: {
          health: `GET ${abs('/health')}`,
          getPrice: `POST ${abs('/getPrice')} { pair }`,
          getPriceHistory: `POST ${abs('/getPriceHistory')} { pair, limit }`,
          proof: `POST ${abs('/proof')} { pair }`,
        },
        // Declared only — NOT enforced by this server. Volume-only tiers.
        feeSchedule: {
          beta: 'currently free',
          enforced: false,
          model: 'volume-only',
          tiers: {
            free: {
              queriesPerDay: 100,
              signedAttestation: true,
              spotPrice: true,
              history: 'full',
            },
            paid: {
              queriesPerDay: 'higher / unlimited',
              signedAttestation: true,
              spotPrice: true,
              history: 'full',
            },
          },
        },
      },
    },
  };
  return await publishSetInfo('PRICE_ORACLE', 'Keeta testnet price oracle (discovery)', discovery);
}

// Return recent {hash, previous} links from the account's chain (most-recent-first).
// Used to prove publishes serialize into a single linear chain (no fork).
export async function getChainLinks(limit = 20) {
  const blocks = await client.chain();
  return blocks.slice(0, limit).map((b) => ({
    hash: b.hash.toString(),
    previous:
      (typeof b.toJSON === 'function' ? b.toJSON().previous : b.previous)?.toString?.() ?? null,
  }));
}

// Read the last N on-chain price snapshots from the account's own chain of SET_INFO blocks.
export async function getOnChainHistory(limit) {
  const blocks = await client.chain(); // most-recent-first
  const out = [];
  for (const block of blocks) {
    const ops = block.operations || (typeof block.toJSON === 'function' ? block.toJSON().operations : []) || [];
    for (const op of ops) {
      const type = op.type;
      const metadata = op.metadata ?? (typeof op.toJSON === 'function' ? op.toJSON().metadata : undefined);
      if (type === OP_SET_INFO && metadata) {
        try {
          const decoded = JSON.parse(Buffer.from(metadata, 'base64').toString('utf8'));
          if (decoded && decoded.type === 'price-snapshot') {
            out.push({ blockHash: block.hash.toString(), timestamp: decoded.timestamp, prices: decoded.prices });
          }
        } catch {
          /* not our JSON metadata — skip */
        }
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}
