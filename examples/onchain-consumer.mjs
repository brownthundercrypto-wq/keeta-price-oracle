#!/usr/bin/env node
/**
 * On-chain consumer for the Keeta price oracle — reads the LATEST published price snapshot DIRECTLY
 * from the ledger, with NO dependency on the oracle's HTTP API and no oracle code.
 *
 * This is the payoff of the on-chain push feed: a Keeta app can read a coherent, signed-by-provenance
 * price set straight from the oracle account's own chain of `SET_INFO` blocks.
 *
 * Dependency-light: it imports only `@keetanetwork/keetanet-client` (the package any Keeta app already
 * has). It builds a READ-ONLY client (null signer) — it never constructs or publishes a block, so it
 * cannot fork the oracle's head (respects the single-writer rule).
 *
 * Authenticity: the snapshot lives on the ORACLE ACCOUNT's own chain, and only the oracle's key can
 * write to that account (single-writer). So reading it from that account is itself the provenance
 * guarantee — no separate signature check is needed for the on-chain path. (For the HTTP path, prices
 * carry an explicit attestation — see examples/client.mjs.)
 *
 * Usage:
 *   npm install
 *   node examples/onchain-consumer.mjs [pair] [oraclePubkey] [network]
 *   # defaults: pair=KTA-USD, oracle=<live testnet oracle account>, network=test
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const KeetaNet = require('@keetanetwork/keetanet-client');
const { Account } = KeetaNet.lib;
const { UserClient } = KeetaNet;

const OP_SET_INFO = 2; // KeetaNet.lib.Block.OperationType.SET_INFO
const DEFAULT_ORACLE = 'keeta_aaba7633k7zfn3hhavs7xh2yd27qdmbtspi5npnkvcvz7ticezcxmv6h3375hly';

const PAIR = (process.argv[2] || 'KTA-USD').toUpperCase();
const ORACLE = process.argv[3] || DEFAULT_ORACLE;
const NETWORK = process.argv[4] || 'test';

/**
 * Read the latest on-chain price snapshot from the oracle account's chain. READ-ONLY.
 * Returns { blockHash, timestamp, oracle, prices } (prices keyed by pair) or null if none found.
 */
export async function readLatestSnapshot(oraclePubkey, network = 'test') {
  const account = Account.fromPublicKeyString(oraclePubkey);
  const client = UserClient.fromNetwork(network, null, { account }); // null signer => READ-ONLY
  const blocks = await client.chain(); // the account's blocks, most-recent-first

  for (const block of blocks) {
    const ops = block.operations || (typeof block.toJSON === 'function' ? block.toJSON().operations : []) || [];
    for (const op of ops) {
      const metadata = op.metadata ?? (typeof op.toJSON === 'function' ? op.toJSON().metadata : undefined);
      if (op.type === OP_SET_INFO && metadata) {
        try {
          const decoded = JSON.parse(Buffer.from(metadata, 'base64').toString('utf8'));
          if (decoded && decoded.type === 'price-snapshot') {
            return { blockHash: block.hash.toString(), timestamp: decoded.timestamp, oracle: decoded.oracle, prices: decoded.prices };
          }
        } catch {
          /* not our JSON metadata — skip */
        }
      }
    }
  }
  return null;
}

const snap = await readLatestSnapshot(ORACLE, NETWORK);
if (!snap) {
  console.error(`No on-chain price snapshot found on account ${ORACLE} (network ${NETWORK}).`);
  process.exit(1);
}

console.log('On-chain price snapshot read directly from the Keeta ledger (no HTTP API):');
console.log(`  oracle account : ${ORACLE}`);
console.log(`  block hash     : ${snap.blockHash}`);
console.log(`  snapshot time  : ${snap.timestamp}`);
console.log('');

const entry = snap.prices?.[PAIR];
if (!entry) {
  console.error(`  pair ${PAIR} not in snapshot. Available: ${Object.keys(snap.prices || {}).join(', ')}`);
  process.exit(1);
}
console.log(`  ${PAIR} = ${entry.price} ${entry.quoteCurrency}   (priceScaled ${entry.priceScaled}, ${entry.priceScaleDecimals} dp)`);
console.log(`  method=${entry.method}  sources=${entry.sources}  stale=${!!entry.stale}`);
console.log('');
console.log('  all pairs in this snapshot:');
for (const [p, e] of Object.entries(snap.prices)) {
  console.log(`    ${p.padEnd(9)} ${String(e.price).padEnd(14)} ${e.quoteCurrency}${e.stale ? '  (stale)' : ''}`);
}
console.log('');
console.log('Authenticity: this data lives on the ORACLE ACCOUNT\'s own chain — only the oracle key can');
console.log('write there (single-writer), so reading it from that account IS the provenance guarantee.');

// The Keeta client keeps a network handle open; exit explicitly so this CLI example returns promptly.
process.exit(0);
