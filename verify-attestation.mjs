#!/usr/bin/env node
/**
 * Clean-room, consumer-side attestation verifier for the Keeta price oracle.
 *
 * Any third party can run this against the live service. It deliberately does NOT import a single
 * line of the oracle's own server/signing code — it uses only the two public packages an external
 * integrator would install:
 *
 *   - @keetanetwork/keetanet-client  -> Account.fromPublicKeyString   (CommonJS, loaded via createRequire)
 *   - @keetanetwork/anchor           -> VerifySignedData              (ESM, imported directly)
 *
 * What it proves:
 *   1. Fetch a FRESH signed price from the live public endpoint.
 *   2. Rebuild the oracle account from ONLY the response's `oracle` pubkey string.
 *   3. Build the signed-values array by mapping the response's own `signedFields` -> values, in order.
 *   4. VerifySignedData(account, values, attestation) === true.
 *   5. Tamper tests: mutating `price` alone, or `priceScaled` alone, both flip verification to false —
 *      i.e. the attestation covers the full canonical payload, not just some of it.
 *
 * Usage:
 *   npm install            # once, to get the two packages
 *   node verify-attestation.mjs [pair] [baseUrl]
 *   # defaults: pair=KTA-USD, baseUrl=https://keeta-price-oracle-production.up.railway.app
 */
import { createRequire } from 'module';
import { VerifySignedData } from '@keetanetwork/anchor/lib/utils/signing.js';

const require = createRequire(import.meta.url);
const KeetaNet = require('@keetanetwork/keetanet-client');
const { Account } = KeetaNet.lib;

const PAIR = process.argv[2] || 'KTA-USD';
const BASE_URL = (process.argv[3] || 'https://keeta-price-oracle-production.up.railway.app').replace(/\/+$/, '');
const LIVE = `${BASE_URL}/getPrice`;

// Flip one digit of a numeric string (last digit, +1 mod 10): stays numeric but is guaranteed different.
function flipOneDigit(value) {
  const s = String(value);
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] >= '0' && s[i] <= '9') {
      return s.slice(0, i) + String((Number(s[i]) + 1) % 10) + s.slice(i + 1);
    }
  }
  return s + '1';
}

async function main() {
  console.log('LIVE_URL=' + LIVE);

  // 1. Fetch a FRESH signed price.
  const res = await fetch(LIVE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ pair: PAIR }),
  });
  const resp = await res.json();
  if (!resp || resp.ok !== true) {
    console.log('FETCH_FAILED=' + JSON.stringify(resp));
    process.exit(1);
  }

  // 2. Reconstruct the oracle account from ONLY the response's pubkey string (no private key needed).
  const account = Account.fromPublicKeyString(resp.oracle);
  console.log('PUBKEY=' + resp.oracle);

  // 3. Build the signed-values array from the response's own signedFields, in that exact order.
  const values = resp.signedFields.map((field) => resp[field]);
  console.log('SIGNED_FIELDS=' + JSON.stringify(resp.signedFields));
  console.log('SIGNED_VALUES=' + JSON.stringify(values));

  // 4. Verify the genuine payload.
  const ok = await VerifySignedData(account, values, resp.attestation);
  console.log('VERIFY=' + ok);

  // 5a. Tamper `price` alone -> must be false.
  const iPrice = resp.signedFields.indexOf('price');
  const tamperedPrice = values.slice();
  tamperedPrice[iPrice] = flipOneDigit(tamperedPrice[iPrice]);
  console.log(`TAMPER_PRICE: "${values[iPrice]}" -> "${tamperedPrice[iPrice]}"`);
  console.log('VERIFY_TAMPERED_PRICE=' + (await VerifySignedData(account, tamperedPrice, resp.attestation)));

  // 5b. Tamper `priceScaled` alone -> must be false.
  const iScaled = resp.signedFields.indexOf('priceScaled');
  const tamperedScaled = values.slice();
  tamperedScaled[iScaled] = flipOneDigit(tamperedScaled[iScaled]);
  console.log(`TAMPER_SCALED: "${values[iScaled]}" -> "${tamperedScaled[iScaled]}"`);
  console.log('VERIFY_TAMPERED_SCALED=' + (await VerifySignedData(account, tamperedScaled, resp.attestation)));

  // 5c. Tamper signed provenance `sources` alone (if present) -> must be false.
  //     Proves the source list + aggregation method are attested, not merely displayed.
  const iSources = resp.signedFields.indexOf('sources');
  if (iSources !== -1) {
    const tamperedSources = values.slice();
    const orig = String(tamperedSources[iSources]);
    // Drop the last source from the canonical comma-joined list (a real provenance change).
    tamperedSources[iSources] = orig.includes(',') ? orig.slice(0, orig.lastIndexOf(',')) : orig + '_x';
    console.log(`TAMPER_SOURCES: "${orig}" -> "${tamperedSources[iSources]}"`);
    console.log('VERIFY_TAMPERED_SOURCES=' + (await VerifySignedData(account, tamperedSources, resp.attestation)));
  }

  // 5d. Tamper signed `confidencePct` alone (if present) -> must be false.
  //     Proves the confidence measure is attested, so a consumer can't be fed a faked confidence.
  const iConf = resp.signedFields.indexOf('confidencePct');
  if (iConf !== -1) {
    const tamperedConf = values.slice();
    tamperedConf[iConf] = flipOneDigit(tamperedConf[iConf]);
    console.log(`TAMPER_CONFIDENCE: "${values[iConf]}" -> "${tamperedConf[iConf]}"`);
    console.log('VERIFY_TAMPERED_CONFIDENCE=' + (await VerifySignedData(account, tamperedConf, resp.attestation)));
  }

  // 5e. Tamper signed `twap1h` alone (if present) -> must be false.
  //     Proves the TWAP is attested like spot (works whether it's a value or "building").
  const iTwap = resp.signedFields.indexOf('twap1h');
  if (iTwap !== -1) {
    const tamperedTwap = values.slice();
    tamperedTwap[iTwap] = flipOneDigit(tamperedTwap[iTwap]); // appends a char if non-numeric ("building")
    console.log(`TAMPER_TWAP1H: "${values[iTwap]}" -> "${tamperedTwap[iTwap]}"`);
    console.log('VERIFY_TAMPERED_TWAP1H=' + (await VerifySignedData(account, tamperedTwap, resp.attestation)));
  }
}

main().catch((e) => {
  console.error('ERROR ' + (e && e.message ? e.message : e));
  process.exit(1);
});
