// (7) SIGNATURE — with a LOCAL throwaway keypair generated in-test (NOT the real APP_SEED):
// anchor SignData over the canonical fields verifies true; tampering ANY signed field flips
// VerifySignedData to false. Hermetic: no network, no chain, no real seed.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { SignData, VerifySignedData } from '@keetanetwork/anchor/lib/utils/signing.js';

const require = createRequire(import.meta.url);
const KeetaNet = require('@keetanetwork/keetanet-client');

// The authoritative signed-fields order (mirrors server.js SIGNED_FIELDS) and a representative value
// per field. priceScaleDecimals is signed as a NUMBER; every other field is a string.
const SIGNED_FIELDS = ['pair', 'quoteCurrency', 'price', 'priceScaled', 'priceScaleDecimals', 'method', 'sources', 'confidenceBand', 'confidencePct', 'twap1h', 'twap24h', 'timestamp'];
const CANONICAL = {
  pair: 'KTA-USD', quoteCurrency: 'USD', price: '0.11776071', priceScaled: '11776071', priceScaleDecimals: 8,
  method: 'median', sources: 'bitmart,coinbase,coinpaprika,kraken,mexc', confidenceBand: '0.0004001123',
  confidencePct: '0.339767', twap1h: '0.11823622', twap24h: 'building', timestamp: '2026-07-18T16:31:44.646Z',
};

let account;
let values;
let attestation;

before(async () => {
  // Fresh throwaway keypair per run — never the real operator seed.
  const seed = KeetaNet.lib.Account.generateRandomSeed({ asString: true });
  account = KeetaNet.lib.Account.fromSeed(seed, 0);
  values = SIGNED_FIELDS.map((f) => CANONICAL[f]);
  attestation = await SignData(account, values);
});

test('genuine canonical payload verifies true', async () => {
  assert.equal(await VerifySignedData(account, values, attestation), true);
});

test('attestation has the expected shape (nonce, timestamp, signature)', () => {
  assert.deepEqual(Object.keys(attestation).sort(), ['nonce', 'signature', 'timestamp']);
});

// Tamper EACH signed field in turn -> verification must fail. Covers price, priceScaled, sources,
// confidence (both), and TWAP (both), plus the rest for completeness.
for (const field of SIGNED_FIELDS) {
  test(`tampering signed field "${field}" flips verification to false`, async () => {
    const tampered = values.slice();
    const i = SIGNED_FIELDS.indexOf(field);
    tampered[i] = typeof tampered[i] === 'number' ? tampered[i] + 1 : `${tampered[i]}_x`;
    assert.equal(await VerifySignedData(account, tampered, attestation), false, `${field} tamper should fail`);
  });
}

test('a different keypair cannot verify this attestation', async () => {
  const otherSeed = KeetaNet.lib.Account.generateRandomSeed({ asString: true });
  const other = KeetaNet.lib.Account.fromSeed(otherSeed, 0);
  assert.equal(await VerifySignedData(other, values, attestation), false);
});
