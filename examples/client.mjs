#!/usr/bin/env node
/**
 * Minimal consumer for the Keeta price oracle.
 *
 * Fetches /getPrice, VERIFIES the signature against the oracle's public key (using only the two
 * public packages — no oracle code), and prints the price ONLY if the attestation is valid.
 *
 * Usage:
 *   npm install
 *   node examples/client.mjs [pair] [baseUrl]
 *   # defaults: pair=KTA-USD, baseUrl=https://keeta-price-oracle-production.up.railway.app
 */
import { createRequire } from 'module';
import { VerifySignedData } from '@keetanetwork/anchor/lib/utils/signing.js';

const require = createRequire(import.meta.url);
const KeetaNet = require('@keetanetwork/keetanet-client');
const { Account } = KeetaNet.lib;

const PAIR = process.argv[2] || 'KTA-USD';
const BASE = (process.argv[3] || 'https://keeta-price-oracle-production.up.railway.app').replace(/\/+$/, '');

const res = await fetch(`${BASE}/getPrice`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pair: PAIR }),
});
const q = await res.json();
if (!q.ok) {
  console.error(`Request failed: ${q.error || JSON.stringify(q)}`);
  process.exit(1);
}

// Rebuild the oracle account from only the response pubkey, then verify the signed canonical payload.
const account = Account.fromPublicKeyString(q.oracle);
const signedValues = q.signedFields.map((f) => q[f]);
const valid = await VerifySignedData(account, signedValues, q.attestation);

if (!valid) {
  console.error('✗ SIGNATURE INVALID — refusing to use this price.');
  process.exit(1);
}

// Only reached when the attestation verifies.
console.log(`✓ ${q.pair} = ${q.price} ${q.quoteCurrency}`);
console.log(`  median of: ${q.sourceList.join(', ')} (${q.liveSourceCount} sources)`);
console.log(`  as of ${q.timestamp} · signed by ${q.oracle}`);
