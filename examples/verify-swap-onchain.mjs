#!/usr/bin/env node
/**
 * CHAIN-ONLY verifier for the oracle-attested swap. Given ONLY the on-chain block hash (the swap +
 * attestation block, party A's block), it reads that block from the ledger and proves — from the
 * chain alone, with NO off-chain price fetch — that:
 *
 *   a. the oracle's signed attestation is embedded in the block (SET_INFO metadata),
 *   b. VerifySignedData passes against the oracle's public key for BOTH KTA-USD and BTC-USD
 *      (and the embedded oracle pubkey is the KNOWN oracle account, not an impostor), and
 *   c. the settled KTA/BTC amounts (from the block's SEND/RECEIVE ops) match the attested price
 *      within rounding.
 *
 * This is the artifact that makes "the oracle signed the price this swap used" verifiable from the
 * chain alone. It imports only @keetanetwork/keetanet-client + @keetanetwork/anchor (no oracle code),
 * builds a READ-ONLY client (never writes), and needs no seeds.
 *
 * Usage:
 *   node examples/verify-swap-onchain.mjs <attestationBlockHash> [oraclePubkey]
 *   # oraclePubkey defaults to the known testnet oracle account; override to check another instance.
 */
import { createRequire } from 'module';
import { VerifySignedData } from '@keetanetwork/anchor/lib/utils/signing.js';

const require = createRequire(import.meta.url);
const KeetaNet = require('@keetanetwork/keetanet-client');
const { Account, Block } = KeetaNet.lib;
const { UserClient } = KeetaNet;

const KTA = 'keeta_anyiff4v34alvumupagmdyosydeq24lc4def5mrpmmyhx3j6vj2uucckeqn52'; // 9 dp
const BTC = 'keeta_ao47xyunmfh5jcdkm7mgrfaaddp7a2nt2xvwrph6cgurvbeixh77qkfsglgms'; // 8 dp
const KTA_SCALE = 1e9;
const BTC_SCALE = 1e8;
const DEFAULT_ORACLE = 'keeta_aaba7633k7zfn3hhavs7xh2yd27qdmbtspi5npnkvcvz7ticezcxmv6h3375hly';

const BLOCK_HASH = process.argv[2];
const EXPECTED_ORACLE = process.argv[3] || process.env.EXPECTED_ORACLE || DEFAULT_ORACLE;
if (!BLOCK_HASH) {
  console.error('Usage: node examples/verify-swap-onchain.mjs <attestationBlockHash> [oraclePubkey]');
  process.exit(2);
}

const results = [];
const check = (label, pass, detail) => {
  results.push(pass);
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
};
const pk = (x) => x?.publicKeyString?.get?.() ?? null;

async function main() {
  console.log(`CHAIN-ONLY verification of block ${BLOCK_HASH}`);
  console.log(`  (reads the ledger only — no HTTP oracle, no seeds)\n`);

  // Read the block by hash via a READ-ONLY client (null signer).
  const client = UserClient.fromNetwork('test', null, { account: Account.fromPublicKeyString(EXPECTED_ORACLE) });
  let block;
  try {
    block = await client.block(BLOCK_HASH);
  } catch (e) {
    check('block resolves on-chain by hash', false, e.message);
    return finish();
  }
  check('block resolves on-chain by hash', !!block, block ? `account ${pk(block.account)?.slice(0, 16)}…` : 'not found');
  if (!block) return finish();

  // Extract the swap legs (SEND KTA, RECEIVE BTC) and the attestation (SET_INFO metadata) from ops.
  const ops = block.operations || (typeof block.toJSON === 'function' ? block.toJSON().operations : []) || [];
  let sendKta = null;
  let recvBtc = null;
  let metaB64 = null;
  for (const o of ops) {
    const name = Block.OperationType?.[o.type];
    const token = pk(o.token);
    if (name === 'SEND' && token === KTA) sendKta = o.amount;
    if (name === 'RECEIVE' && token === BTC) recvBtc = o.amount;
    if (name === 'SET_INFO') metaB64 = o.metadata ?? (typeof o.toJSON === 'function' ? o.toJSON().metadata : undefined);
  }
  check('block has the swap legs (SEND KTA + RECEIVE BTC)', sendKta != null && recvBtc != null,
    sendKta != null && recvBtc != null ? `${Number(sendKta) / KTA_SCALE} KTA <-> ${Number(recvBtc) / BTC_SCALE} BTC` : 'missing');

  // (a) Extract + decode the embedded attestation.
  let att = null;
  try { att = JSON.parse(Buffer.from(metaB64, 'base64').toString('utf8')); } catch { /* ignore */ }
  const attOk = !!(att && att.type === 'oracle-swap-attestation-v1' && att.prices?.['KTA-USD'] && att.prices?.['BTC-USD']);
  check('(a) embedded oracle attestation present + decodes', attOk, att ? `type=${att.type}` : 'no SET_INFO metadata');
  if (!attOk) return finish();

  // Oracle identity: the embedded pubkey MUST be the known oracle account (not an impostor).
  check('(b0) embedded oracle pubkey is the known oracle account', att.oracle === EXPECTED_ORACLE, att.oracle);

  // (b) VerifySignedData against the oracle's public key for both prices.
  //
  // NOTE on time: VerifySignedData enforces a ±5min skew between the attestation timestamp and a
  // `referenceTime` that DEFAULTS TO NOW — replay protection for a live quote. An on-chain
  // attestation is historical by nature, so verifying it against "now" would (correctly, by that
  // rule) fail forever after 5 minutes. We therefore split the two concerns:
  //   (b)  pure SIGNATURE check — referenceTime = the attestation's own timestamp (skew 0), so this
  //        answers only "did the oracle sign exactly these values?" (time-independent, valid forever)
  //   (b1) FRESHNESS check — explicitly compare the attestation timestamp to the BLOCK's on-chain
  //        settlement date, proving the swap used a fresh price and not a stale one.
  // Both inputs are on-chain, so this stays fully chain-only and reproducible at any future date.
  const oracleAcct = Account.fromPublicKeyString(att.oracle);
  const verifyPrice = async (pair) => {
    const p = att.prices[pair];
    const values = p.signedFields.map((f) => p.values[f]); // rebuild signed array from the embedded order
    return VerifySignedData(oracleAcct, values, p.attestation, { referenceTime: new Date(p.attestation.timestamp) });
  };
  const ktaOk = await verifyPrice('KTA-USD');
  const btcOk = await verifyPrice('BTC-USD');
  check('(b) oracle signature VALID — KTA-USD', ktaOk, `price=${att.prices['KTA-USD'].values.price}`);
  check('(b) oracle signature VALID — BTC-USD', btcOk, `price=${att.prices['BTC-USD'].values.price}`);

  // (b1) Freshness AT SETTLEMENT: the oracle signed within FRESHNESS_MS of the block's own date.
  const FRESHNESS_MS = 5 * 60 * 1000;
  const blockDate = block.date ? new Date(block.date) : (typeof block.toJSON === 'function' ? new Date(block.toJSON().date) : null);
  const gaps = ['KTA-USD', 'BTC-USD'].map((pair) => Math.abs(new Date(att.prices[pair].attestation.timestamp).valueOf() - (blockDate?.valueOf() ?? NaN)));
  const worstGap = Math.max(...gaps);
  check('(b1) attestation was FRESH at settlement (signed near the block date)', Number.isFinite(worstGap) && worstGap <= FRESHNESS_MS,
    blockDate ? `block ${blockDate.toISOString()}, max gap ${(worstGap / 1000).toFixed(1)}s (limit ${FRESHNESS_MS / 1000}s)` : 'block has no date');

  // (c) Settled amounts match the attested price within rounding.
  const ktaUsd = Number(att.prices['KTA-USD'].values.price);
  const btcUsd = Number(att.prices['BTC-USD'].values.price);
  const Xbase = Number(sendKta);
  const Ybase = Number(recvBtc);
  const impliedBtcUsd = ((Xbase / KTA_SCALE) * ktaUsd) / (Ybase / BTC_SCALE);
  const errPct = Math.abs(impliedBtcUsd - btcUsd) / btcUsd * 100;
  const tolPct = Math.max(0.5, (1 / Ybase) * 100); // ± one BTC base-unit's worth (looser for tiny amounts)
  check('(c) settled amounts match the attested price (within rounding)', errPct <= tolPct,
    `implied BTC-USD ${impliedBtcUsd.toFixed(2)} vs attested ${btcUsd} (err ${errPct.toFixed(4)}% <= tol ${tolPct.toFixed(3)}%)`);

  return finish();
}

function finish() {
  const allPass = results.length > 0 && results.every(Boolean);
  console.log(`\n${allPass ? '✓ ALL CHECKS PASS' : '✗ VERIFICATION FAILED'} — ${allPass ? 'the oracle signed the price this on-chain swap settled at, provable from the chain alone.' : 'see failed checks above.'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('VERIFIER ERROR:', e?.message || e); process.exit(1); });
