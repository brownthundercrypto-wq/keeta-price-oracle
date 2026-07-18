#!/usr/bin/env node
/**
 * Independent, READ-ONLY proof of the oracle-priced swap. Reads parties A and B chains directly from
 * the Keeta testnet ledger and prints the actual swap blocks (per-account BLOCK hashes + the KTA/BTC
 * transfers between A and B). No seeds, no writes — anyone can run it.
 *
 * Why this and not the staple hash: an atomic swap settles as a vote STAPLE, whose `blocksHash` is
 * an internal aggregate identifier that block explorers do NOT index. What IS resolvable is each
 * account's own BLOCK (by hash) and each account's history — which is exactly what this prints.
 *
 * Usage:
 *   node examples/verify-swap-onchain.mjs [addressA] [addressB]
 *   # defaults to the demo swap accounts.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const KeetaNet = require('@keetanetwork/keetanet-client');
const { Account, Block } = KeetaNet.lib;
const { UserClient } = KeetaNet;

const KTA = 'keeta_anyiff4v34alvumupagmdyosydeq24lc4def5mrpmmyhx3j6vj2uucckeqn52';
const BTC = 'keeta_ao47xyunmfh5jcdkm7mgrfaaddp7a2nt2xvwrph6cgurvbeixh77qkfsglgms';
const EXPLORER = 'https://explorer.test.keeta.com';
const A = process.argv[2] || 'keeta_aabbbwy54rc4po5xksmmkwvbl2pcmiidly7563dy6aj2u6fs7tkehwbk5etuuia';
const B = process.argv[3] || 'keeta_aabvhlabhl5yuqgwtyqmbdupvahz7siavg76cabqoyd6fhn72h6ytcn6qgddc2y';

const tokenName = (id) => (id === KTA ? 'KTA' : id === BTC ? 'BTC' : (id ? id.slice(0, 12) + '…' : '?'));
const pk = (x) => x?.publicKeyString?.get?.() ?? x?.toString?.() ?? null;

// Return the blocks on `addr`'s chain that move KTA or BTC, with their per-account block hash + ops.
async function swapBlocks(addr) {
  const acct = Account.fromPublicKeyString(addr);
  const client = UserClient.fromNetwork('test', null, { account: acct }); // null signer => READ-ONLY
  const blocks = await client.chain(); // this account's chain, most-recent-first
  const out = [];
  for (const b of blocks) {
    const ops = b.operations || (typeof b.toJSON === 'function' ? b.toJSON().operations : []) || [];
    const rel = ops
      .map((o) => ({ type: Block.OperationType?.[o.type] ?? `op${o.type}`, token: pk(o.token), amount: o.amount?.toString?.(), to: pk(o.to), from: pk(o.from) }))
      .filter((o) => o.token === KTA || o.token === BTC);
    if (rel.length) out.push({ hash: b.hash.toString(), ops: rel });
  }
  return out;
}

function printAccount(label, addr, blocks) {
  console.log(`\n${label}: ${addr}`);
  console.log(`  explorer: ${EXPLORER}/account/${addr}`);
  for (const blk of blocks) {
    console.log(`  block ${blk.hash}`);
    console.log(`     ${EXPLORER}/block/${blk.hash}`);
    for (const o of blk.ops) {
      const dir = o.type === 'SEND' ? `SEND ${o.amount} ${tokenName(o.token)} -> ${o.to?.slice(0, 16)}…`
        : o.type === 'RECEIVE' ? `RECEIVE ${o.amount} ${tokenName(o.token)} <- ${o.from?.slice(0, 16)}…`
        : `${o.type} ${o.amount ?? ''} ${tokenName(o.token)}`;
      console.log(`       · ${dir}`);
    }
  }
}

const aBlocks = await swapBlocks(A);
const bBlocks = await swapBlocks(B);
console.log('READ-ONLY on-chain proof of the oracle-priced KTA<->BTC swap (independent of the HTTP oracle):');
printAccount('Party A', A, aBlocks);
printAccount('Party B', B, bBlocks);
console.log('\nWhat to check: A has a block that SENDs KTA to B and RECEIVEs BTC from B; B has a block');
console.log('that SENDs the matching BTC to A. Both settled in one atomic staple (all-or-nothing).');
process.exit(0);
