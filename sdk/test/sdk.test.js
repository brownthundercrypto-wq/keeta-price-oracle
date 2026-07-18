// keeta-price-oracle-client — hermetic tests. NO network, NO chain: fetch is mocked and the signed
// payload is produced with a LOCAL throwaway keypair (never a real seed). Proves the SDK verifies a
// genuine payload, REJECTS a tampered one, and surfaces 429 / stale / network as typed errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { SignData } from '@keetanetwork/anchor/lib/utils/signing.js';
import { createClient, verify, OracleError, DEFAULT_BASE_URL } from '../index.js';

const require = createRequire(import.meta.url);
const KeetaNet = require('@keetanetwork/keetanet-client');
const { Account } = KeetaNet.lib;

const SIGNED_FIELDS = ['pair', 'quoteCurrency', 'price', 'priceScaled', 'priceScaleDecimals', 'method', 'sources', 'confidenceBand', 'confidencePct', 'twap1h', 'twap24h', 'timestamp'];

// Build a genuine, signed /getPrice response with a fresh local keypair (mirrors the server).
async function makeSignedResponse(overrides = {}) {
  const account = Account.fromSeed(randomBytes(32).toString('hex'), 0);
  const canonical = {
    pair: 'KTA-USD', quoteCurrency: 'USD', price: '0.1165', priceScaled: '11650000', priceScaleDecimals: 8,
    method: 'median', sources: 'bitmart,coinbase,kraken', confidenceBand: '0.0004', confidencePct: '0.34',
    twap1h: '0.1162', twap24h: 'building', timestamp: '2026-07-18T20:00:00.000Z', ...overrides,
  };
  const attestation = await SignData(account, SIGNED_FIELDS.map((f) => canonical[f]));
  return {
    ok: true, oracle: account.publicKeyString.get(), ...canonical,
    sourceList: ['bitmart', 'coinbase', 'kraken'], liveSourceCount: 3, stale: false,
    signedFields: SIGNED_FIELDS, attestation,
  };
}

// A mock fetch that returns a fixed status + JSON body (and optional headers.get).
function mockFetch({ status = 200, body, headers = {} }) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (h) => headers[String(h).toLowerCase()] ?? null },
  });
}

test('getPrice verifies a genuine payload by default and returns it', async () => {
  const body = await makeSignedResponse();
  const client = createClient({ baseUrl: 'http://mock', fetch: mockFetch({ body }) });
  const q = await client.getPrice('KTA-USD');
  assert.equal(q.pair, 'KTA-USD');
  assert.equal(q.price, '0.1165');
});

test('getPrice REJECTS a tampered payload (verification on by default)', async () => {
  const body = await makeSignedResponse();
  body.price = '9.9999'; // tamper a signed field after signing
  const client = createClient({ baseUrl: 'http://mock', fetch: mockFetch({ body }) });
  await assert.rejects(
    () => client.getPrice('KTA-USD'),
    (e) => e instanceof OracleError && e.code === 'VERIFICATION_FAILED',
  );
});

test('getPrice({ verify: false }) skips verification (returns even a tampered payload)', async () => {
  const body = await makeSignedResponse();
  body.price = '9.9999';
  const client = createClient({ baseUrl: 'http://mock', fetch: mockFetch({ body }) });
  const q = await client.getPrice('KTA-USD', { verify: false });
  assert.equal(q.price, '9.9999'); // returned unverified because the caller opted out
});

test('standalone verify() returns true for genuine, false for tampered', async () => {
  const good = await makeSignedResponse();
  assert.equal(await verify(good), true);
  const bad = await makeSignedResponse();
  bad.sources = bad.sources + ',evil';
  assert.equal(await verify(bad), false);
  assert.equal(await verify({}), false); // malformed -> false, not a throw
});

test('a DIFFERENT oracle pubkey cannot pass verification (impersonation rejected)', async () => {
  const body = await makeSignedResponse();
  body.oracle = Account.fromSeed(randomBytes(32).toString('hex'), 0).publicKeyString.get(); // wrong key
  const client = createClient({ baseUrl: 'http://mock', fetch: mockFetch({ body }) });
  await assert.rejects(() => client.getPrice('KTA-USD'), (e) => e.code === 'VERIFICATION_FAILED');
});

test('429 surfaces as a typed RATE_LIMITED error with retryAfter', async () => {
  const client = createClient({
    baseUrl: 'http://mock',
    fetch: mockFetch({ status: 429, body: { ok: false, error: 'rate limited', retryAfter: 7 }, headers: { 'retry-after': '7' } }),
  });
  await assert.rejects(
    () => client.getPrice('KTA-USD'),
    (e) => e instanceof OracleError && e.code === 'RATE_LIMITED' && e.status === 429 && e.retryAfter === 7,
  );
});

test('503 surfaces as a typed STALE error', async () => {
  const client = createClient({
    baseUrl: 'http://mock',
    fetch: mockFetch({ status: 503, body: { ok: false, stale: true, error: 'no price: fewer than 2 live sources' } }),
  });
  await assert.rejects(() => client.getPrice('KTA-USD'), (e) => e.code === 'STALE' && e.status === 503);
});

test('404 surfaces as a typed NOT_FOUND error', async () => {
  const client = createClient({
    baseUrl: 'http://mock',
    fetch: mockFetch({ status: 404, body: { ok: false, error: 'Unknown or unavailable pair: WAT' } }),
  });
  await assert.rejects(() => client.getPrice('WAT'), (e) => e.code === 'NOT_FOUND' && e.status === 404);
});

test('a network failure surfaces as a typed NETWORK error', async () => {
  const client = createClient({
    baseUrl: 'http://mock',
    fetch: async () => { throw new Error('ECONNREFUSED'); },
  });
  await assert.rejects(() => client.getPrice('KTA-USD'), (e) => e instanceof OracleError && e.code === 'NETWORK');
});

test('getTwap / getProof / getHistory hit the right routes and pass through', async () => {
  const calls = [];
  const fetchSpy = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, url }), headers: { get: () => null } };
  };
  const client = createClient({ baseUrl: 'http://mock', fetch: fetchSpy });
  await client.getTwap('KTA-USD', '24h');
  await client.getProof('BTC-USD');
  await client.getHistory('ETH-USD', 5);
  assert.deepEqual(calls[0], { url: 'http://mock/twap', body: { pair: 'KTA-USD', window: '24h' } });
  assert.deepEqual(calls[1], { url: 'http://mock/proof', body: { pair: 'BTC-USD' } });
  assert.deepEqual(calls[2], { url: 'http://mock/getPriceHistory', body: { pair: 'ETH-USD', limit: 5 } });
});

test('default baseUrl is the live oracle and is overridable', () => {
  assert.equal(createClient().baseUrl, DEFAULT_BASE_URL);
  assert.equal(createClient({ baseUrl: 'https://example.com/' }).baseUrl, 'https://example.com');
});
