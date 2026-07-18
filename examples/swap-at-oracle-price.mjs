#!/usr/bin/env node
/**
 * End-to-end demo: a REAL atomic on-chain KTA<->BTC swap on Keeta TESTNET that settles at the
 * ORACLE's signed price, with a verifiable proof bundle.
 *
 * What it does:
 *   STEP 1 — RATE:   fetch KTA-USD + BTC-USD from the live oracle, VERIFY both signatures, compute
 *                    the cross rate (KTA per BTC).
 *   STEP 2 — ACQUIRE: confirm party B holds BTC-token units (pre-loaded — see honest framing below).
 *   STEP 3 — SWAP:   ONE atomic staple — A sends X KTA to B, B sends Y BTC to A, with X/Y equal to
 *                    the oracle cross rate. Both legs settle atomically or neither does.
 *   STEP 4 — PROOF:  print + save the signed oracle prices (verified), the rate, the atomic staple
 *                    block hashes (explorer-verifiable), and a settled-amounts-vs-rate check.
 *
 * HONEST FRAMING: both accounts (A and B) are controlled by the same operator (this script holds
 * both seeds). This demonstrates the MECHANISM — a signed oracle price driving a real, atomic
 * on-chain settlement between two Keeta accounts — NOT a third-party trade or a price discovery.
 * The "BTC" is a real Keeta testnet token (name "BTC", 8 dp); B was pre-loaded with it, standing in
 * for an FX-anchor acquisition.
 *
 * SAFETY: uses two FRESH throwaway seeds (A, B) from env (SWAP_SEED_A / SWAP_SEED_B) — NEVER the
 * oracle's APP_SEED (reusing it would fork the live oracle chain). Seeds never committed. It never
 * touches the oracle account; A and B are independent accounts, so the single-writer rule is not
 * involved.
 *
 * Run:
 *   SWAP_SEED_A=<hexA> SWAP_SEED_B=<hexB> node examples/swap-at-oracle-price.mjs [ktaAmount]
 *   # default ktaAmount = 10 (KTA that A sends). Optional env: BTC_TOKEN, KTA_TOKEN, ORACLE_URL.
 */
import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import { createClient } from '../sdk/index.js';

const require = createRequire(import.meta.url);
const KeetaNet = require('@keetanetwork/keetanet-client');
const { Account } = KeetaNet.lib;
const { UserClient } = KeetaNet;

// ── Config (tokens verified on testnet; override via env) ────────────────────────────────────────
const KTA_TOKEN = process.env.KTA_TOKEN || 'keeta_anyiff4v34alvumupagmdyosydeq24lc4def5mrpmmyhx3j6vj2uucckeqn52'; // 9 dp
const BTC_TOKEN = process.env.BTC_TOKEN || 'keeta_ao47xyunmfh5jcdkm7mgrfaaddp7a2nt2xvwrph6cgurvbeixh77qkfsglgms'; // 8 dp
const EXPLORER = 'https://explorer.test.keeta.com';
const KTA_DP = 9n;
const BTC_DP = 8n;
const KTA_SCALE = 10n ** KTA_DP; // 1e9
const BTC_SCALE = 10n ** BTC_DP; // 1e8
const KTA_TO_SEND = process.argv[2] || process.env.KTA_AMOUNT || '10'; // KTA amount A sends

function must(v, name) {
  if (!v) { console.error(`Missing required env ${name}. See the file header for usage.`); process.exit(1); }
  return v;
}
const seedA = must(process.env.SWAP_SEED_A, 'SWAP_SEED_A');
const seedB = must(process.env.SWAP_SEED_B, 'SWAP_SEED_B');
if (process.env.APP_SEED && (seedA === process.env.APP_SEED || seedB === process.env.APP_SEED)) {
  console.error('REFUSING TO RUN: a swap seed equals the oracle APP_SEED — that would fork the live oracle chain.');
  process.exit(1);
}

const A = Account.fromSeed(seedA, 0);
const B = Account.fromSeed(seedB, 0);
const ktaTokenAcct = Account.fromPublicKeyString(KTA_TOKEN);
const btcTokenAcct = Account.fromPublicKeyString(BTC_TOKEN);
const clientA = UserClient.fromNetwork('test', A, { account: A });
const clientB = UserClient.fromNetwork('test', B, { account: B });

const dec = (base, scale) => (Number(base) / Number(scale)).toString();
// Each client is bound to its own account (A or B), so balance(token) returns that account's balance.
const bal = async (client, token) => {
  try { return await client.balance(token); } catch { return null; }
};

async function main() {
  const proof = { demo: 'KTA<->BTC atomic swap at oracle price', network: 'test' };

  // ── STEP 1 — RATE (verified oracle prices) ─────────────────────────────────────────────────────
  console.log('=== STEP 1 — RATE (verified oracle prices) ===');
  const oracle = createClient({ baseUrl: process.env.ORACLE_URL });
  const ktaQ = await oracle.getPrice('KTA-USD'); // verified by default
  const btcQ = await oracle.getPrice('BTC-USD');
  const ktaVerified = await oracle.verify(ktaQ);
  const btcVerified = await oracle.verify(btcQ);
  const ktaUsd = Number(ktaQ.price);
  const btcUsd = Number(btcQ.price);
  const ktaPerBtc = btcUsd / ktaUsd; // cross rate: KTA per 1 BTC
  console.log(`  KTA-USD = ${ktaQ.price}  (verified: ${ktaVerified})`);
  console.log(`  BTC-USD = ${btcQ.price}  (verified: ${btcVerified})`);
  console.log(`  cross rate: 1 BTC = ${ktaPerBtc.toFixed(6)} KTA  (X_KTA / Y_BTC)`);
  if (!ktaVerified || !btcVerified) { console.error('  ORACLE SIGNATURE INVALID — aborting.'); process.exit(1); }
  proof.oracle = {
    account: ktaQ.oracle,
    ktaUsd: { price: ktaQ.price, timestamp: ktaQ.timestamp, verified: ktaVerified, signedFields: ktaQ.signedFields, attestation: ktaQ.attestation },
    btcUsd: { price: btcQ.price, timestamp: btcQ.timestamp, verified: btcVerified, signedFields: btcQ.signedFields, attestation: btcQ.attestation },
    crossRate_KTA_per_BTC: ktaPerBtc,
  };

  // ── Compute exact swap amounts (integer base units) ────────────────────────────────────────────
  // USD-value equivalence: X_KTA * ktaUsd == Y_BTC * btcUsd. With base units:
  //   Ybase = round( Xbase * ktaUsd / (btcUsd * (KTA_SCALE/BTC_SCALE)) )
  const Xbase = BigInt(Math.round(Number(KTA_TO_SEND) * Number(KTA_SCALE))); // KTA base units A sends
  const YbaseFloat = (Number(Xbase) * ktaUsd) / (btcUsd * (Number(KTA_SCALE) / Number(BTC_SCALE)));
  const Ybase = BigInt(Math.round(YbaseFloat)); // BTC base units B sends
  if (Ybase <= 0n) { console.error('  Computed BTC amount rounds to 0 — increase ktaAmount.'); process.exit(1); }
  console.log(`  swap: A sends ${dec(Xbase, KTA_SCALE)} KTA  <->  B sends ${dec(Ybase, BTC_SCALE)} BTC`);
  console.log(`        (Xbase=${Xbase} @9dp, Ybase=${Ybase} @8dp)`);
  proof.swapAmounts = { ktaSent: dec(Xbase, KTA_SCALE), btcSent: dec(Ybase, BTC_SCALE), ktaBaseUnits: Xbase.toString(), btcBaseUnits: Ybase.toString(), ktaDecimals: 9, btcDecimals: 8 };

  // ── STEP 2 — ACQUIRE (confirm B holds BTC; pre-loaded) ─────────────────────────────────────────
  console.log('\n=== STEP 2 — ACQUIRE (party B holds BTC-token units) ===');
  const A_kta0 = await bal(clientA, ktaTokenAcct);
  const A_btc0 = await bal(clientA, btcTokenAcct);
  const B_kta0 = await bal(clientB, ktaTokenAcct);
  const B_btc0 = await bal(clientB, btcTokenAcct);
  console.log(`  A before:  KTA=${dec(A_kta0, KTA_SCALE)}  BTC=${dec(A_btc0 ?? 0n, BTC_SCALE)}`);
  console.log(`  B before:  KTA=${dec(B_kta0, KTA_SCALE)}  BTC=${dec(B_btc0 ?? 0n, BTC_SCALE)}`);
  if ((B_btc0 ?? 0n) < Ybase) { console.error(`  B holds insufficient BTC (${B_btc0} < ${Ybase}). Pre-load B with the BTC token.`); process.exit(1); }
  if ((A_kta0 ?? 0n) < Xbase) { console.error(`  A holds insufficient KTA (${A_kta0} < ${Xbase}). Fund A from the faucet.`); process.exit(1); }
  proof.balancesBefore = { A: { kta: dec(A_kta0, KTA_SCALE), btc: dec(A_btc0 ?? 0n, BTC_SCALE) }, B: { kta: dec(B_kta0, KTA_SCALE), btc: dec(B_btc0 ?? 0n, BTC_SCALE) } };

  // ── STEP 3 — SWAP (one atomic staple) ──────────────────────────────────────────────────────────
  console.log('\n=== STEP 3 — SWAP (atomic staple: A KTA <-> B BTC) ===');
  // A initiates: send X KTA to B, and require to receive exactly Y BTC from B.
  const swapBlock = await clientA.createSwapRequest({
    from: { account: A, token: ktaTokenAcct, amount: Xbase },
    to: { account: B, token: btcTokenAcct, amount: Ybase, exact: true },
  });
  console.log(`  A created swap request block: ${swapBlock.hash.toString()}`);

  // B accepts: validate what it receives (X KTA) and sends (Y BTC), producing the settlement blocks.
  const builderB = clientB.initBuilder({ account: B });
  const blocks = await UserClient.acceptSwapRequest(
    { block: swapBlock, expected: { receive: { token: ktaTokenAcct, amount: Xbase }, send: { token: btcTokenAcct, amount: Ybase } } },
    builderB,
  );
  console.log(`  B accepted; staple has ${blocks.length} blocks. Transmitting atomically…`);

  // Transmit both blocks as ONE atomic vote staple (both settle or neither does).
  const txResult = await clientB.transmit(blocks, { generateFeeBlock: (s) => builderB.computeFeeBlock(s) });
  const voteStaple = txResult?.voteStaple;
  const stapleHash = voteStaple?.blocksHash?.toString?.() ?? null;
  const A_addr = A.publicKeyString.get();
  const B_addr = B.publicKeyString.get();
  // The per-account BLOCKS are the explorer-resolvable identifiers (the staple blocksHash is an
  // internal aggregate that explorers do NOT index).
  const perAccountBlocks = (voteStaple?.blocks ?? blocks).map((b) => {
    const acct = b.account?.publicKeyString?.get?.() ?? null;
    return { party: acct === A_addr ? 'A' : acct === B_addr ? 'B' : '?', account: acct, hash: b.hash.toString(), explorer: `${EXPLORER}/block/${b.hash.toString()}` };
  });
  console.log(`  ✓ ATOMIC STAPLE PUBLISHED (published: ${txResult?.publish})`);
  console.log(`    staple blocksHash (internal aggregate — NOT explorer-indexed): ${stapleHash}`);
  console.log(`    per-account blocks (these resolve on the explorer / SDK):`);
  for (const sb of perAccountBlocks) console.log(`      ${sb.party} ${sb.hash}`);
  proof.atomicStaple = {
    stapleBlocksHash: stapleHash,
    stapleBlocksHashNote: 'Vote-staple aggregate identifier — block explorers index per-account BLOCKS + ACCOUNTS, not this. Verify via perAccountBlocks / explorer.accounts below.',
    published: !!txResult?.publish,
    perAccountBlocks,
    swapRequestBlock: swapBlock.hash.toString(),
  };

  // ── STEP 4 — PROOF (settled balances match the oracle rate within rounding) ────────────────────
  console.log('\n=== STEP 4 — PROOF (settled amounts vs oracle rate) ===');
  const A_kta1 = await bal(clientA, ktaTokenAcct);
  const A_btc1 = await bal(clientA, btcTokenAcct);
  const B_kta1 = await bal(clientB, ktaTokenAcct);
  const B_btc1 = await bal(clientB, btcTokenAcct);
  console.log(`  A after:   KTA=${dec(A_kta1, KTA_SCALE)}  BTC=${dec(A_btc1 ?? 0n, BTC_SCALE)}`);
  console.log(`  B after:   KTA=${dec(B_kta1, KTA_SCALE)}  BTC=${dec(B_btc1 ?? 0n, BTC_SCALE)}`);

  // Deltas. The two SWAP legs must be exact; the staple fee is paid separately by the transmitter (B)
  // in KTA, so B's net KTA gain = X minus that fee (not a swap-leg discrepancy).
  const A_kta_delta = (A_kta1 ?? 0n) - (A_kta0 ?? 0n); // negative: A sent KTA
  const A_btc_delta = (A_btc1 ?? 0n) - (A_btc0 ?? 0n); // positive: A received BTC
  const B_kta_delta = (B_kta1 ?? 0n) - (B_kta0 ?? 0n); // positive: B received KTA (minus the fee B paid)
  const B_btc_delta = (B_btc1 ?? 0n) - (B_btc0 ?? 0n); // negative: B sent BTC
  const ktaLegExact = -A_kta_delta === Xbase;                          // A sent exactly X KTA
  const btcLegExact = A_btc_delta === Ybase && -B_btc_delta === Ybase; // A received / B sent exactly Y BTC
  const exactSwap = ktaLegExact && btcLegExact;
  const feeBase = Xbase - B_kta_delta;                                 // KTA staple fee B paid
  const impliedBtcUsd = (Number(Xbase) / Number(KTA_SCALE) * ktaUsd) / (Number(A_btc_delta) / Number(BTC_SCALE));
  const rateErrorPct = Math.abs(impliedBtcUsd - btcUsd) / btcUsd * 100;
  console.log(`  A sent ${dec(Xbase, KTA_SCALE)} KTA, received ${dec(A_btc_delta, BTC_SCALE)} BTC (base ${A_btc_delta})`);
  console.log(`  B sent ${dec(-B_btc_delta, BTC_SCALE)} BTC, received ${dec(B_kta_delta, KTA_SCALE)} KTA net (staple fee ${dec(feeBase, KTA_SCALE)} KTA)`);
  console.log(`  swap legs EXACT (A sent X KTA, A got Y BTC, B sent Y BTC): ${exactSwap}`);
  console.log(`  implied BTC-USD from settled amounts: ${impliedBtcUsd.toFixed(2)}  vs oracle ${btcUsd}  (error ${rateErrorPct.toFixed(4)}%)`);
  proof.balancesAfter = { A: { kta: dec(A_kta1, KTA_SCALE), btc: dec(A_btc1 ?? 0n, BTC_SCALE) }, B: { kta: dec(B_kta1, KTA_SCALE), btc: dec(B_btc1 ?? 0n, BTC_SCALE) } };
  proof.settlementCheck = {
    A_sent_KTA_base: (-A_kta_delta).toString(), A_received_BTC_base: A_btc_delta.toString(),
    B_sent_BTC_base: (-B_btc_delta).toString(), B_received_KTA_net_base: B_kta_delta.toString(),
    stapleFee_KTA_base: feeBase.toString(),
    swapLegsExact: exactSwap, impliedBtcUsd, oracleBtcUsd: btcUsd, rateErrorPct,
  };
  proof.explorer = {
    base: EXPLORER,
    accounts: { A: `${EXPLORER}/account/${A.publicKeyString.get()}`, B: `${EXPLORER}/account/${B.publicKeyString.get()}` },
  };
  proof.verification = {
    readOnlyScript: `node examples/verify-swap-onchain.mjs ${A.publicKeyString.get()} ${B.publicKeyString.get()}`,
    note: 'Authoritative, no-guess path: reads both accounts\' chains directly (no HTTP oracle, no seeds). Explorer account links load the SPA (soft-404 status but serves the app) and resolve client-side via the same node API.',
  };
  proof.framing = 'Both accounts are one operator; this proves the mechanism (signed oracle price -> real atomic settlement), not a third-party trade.';

  const outPath = new URL('./swap-proof.json', import.meta.url);
  writeFileSync(outPath, JSON.stringify(proof, null, 2));
  console.log(`\n=== PROOF BUNDLE saved to examples/swap-proof.json ===`);
  console.log(JSON.stringify({ crossRate_KTA_per_BTC: proof.oracle.crossRate_KTA_per_BTC, swapAmounts: proof.swapAmounts, stapleHash, swapLegsExact: exactSwap, rateErrorPct }, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error('SWAP DEMO FAILED:', e?.message || e); process.exit(1); });
