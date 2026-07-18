// keeta-price-oracle-client — one-line client for the Keeta testnet price oracle, with
// signature verification built in (ON by default — that's the point).
//
// Verification is clean-room: it rebuilds the oracle account from ONLY the response's `oracle`
// pubkey, builds the signed-values array from the response's own `signedFields` (in order), and
// checks it with anchor's VerifySignedData. Nothing trusts the server beyond its public key.
//
// Uses only the two public Keeta packages (same versions the oracle signs with):
//   - @keetanetwork/keetanet-client  (CommonJS -> createRequire): Account, UserClient
//   - @keetanetwork/anchor           (ESM):                       VerifySignedData
import { createRequire } from 'module';
import { VerifySignedData } from '@keetanetwork/anchor/lib/utils/signing.js';

const require = createRequire(import.meta.url);
const KeetaNet = require('@keetanetwork/keetanet-client');
const { Account } = KeetaNet.lib;
const { UserClient } = KeetaNet;

const OP_SET_INFO = 2; // KeetaNet.lib.Block.OperationType.SET_INFO

/** The live public testnet oracle. Override via createClient({ baseUrl }) for any instance. */
export const DEFAULT_BASE_URL = 'https://keeta-price-oracle-production.up.railway.app';
/** The live testnet oracle account (used by readLatestOnChain; override via createClient({ oracle })). */
export const DEFAULT_ORACLE = 'keeta_aaba7633k7zfn3hhavs7xh2yd27qdmbtspi5npnkvcvz7ticezcxmv6h3375hly';

/** Typed error for every failure mode: verification, rate-limit, stale, HTTP, network, not-found. */
export class OracleError extends Error {
  constructor(message, { code, status, retryAfter, response } = {}) {
    super(message);
    this.name = 'OracleError';
    this.code = code; // 'VERIFICATION_FAILED'|'RATE_LIMITED'|'STALE'|'HTTP_ERROR'|'NETWORK'|'NOT_FOUND'|'BAD_RESPONSE'
    if (status !== undefined) this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
    if (response !== undefined) this.response = response;
  }
}

/**
 * Standalone clean-room verification of a signed oracle response (e.g. from /getPrice or /twap).
 * Rebuilds the account from response.oracle, maps response.signedFields -> values, VerifySignedData.
 * Returns true/false; never throws for a well-formed-but-invalid payload.
 */
export async function verify(response) {
  if (!response || typeof response !== 'object') return false;
  if (!response.oracle || !Array.isArray(response.signedFields) || !response.attestation) return false;
  let account;
  try {
    account = Account.fromPublicKeyString(response.oracle);
  } catch {
    return false;
  }
  const values = response.signedFields.map((f) => response[f]);
  return await VerifySignedData(account, values, response.attestation);
}

/**
 * Create a client bound to one oracle instance.
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]  HTTP base URL (default: the live oracle).
 * @param {Function} [opts.fetch]  fetch implementation (default: global fetch) — inject to test/mock.
 * @param {string} [opts.oracle]   oracle account pubkey for readLatestOnChain (default: the live one).
 * @param {string} [opts.network]  Keeta network for readLatestOnChain (default: 'test').
 */
export function createClient(opts = {}) {
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = opts.fetch || globalThis.fetch;
  const oraclePubkey = opts.oracle || DEFAULT_ORACLE;
  const network = opts.network || 'test';

  if (typeof doFetch !== 'function') {
    throw new OracleError('no fetch implementation available (Node >= 18, or pass { fetch })', { code: 'NETWORK' });
  }

  async function request(method, path, body) {
    let res;
    try {
      res = await doFetch(baseUrl + path, {
        method,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new OracleError(`network error contacting ${baseUrl}${path}: ${e.message || e}`, { code: 'NETWORK' });
    }

    // Rate limited — surface Retry-After.
    if (res.status === 429) {
      let response = null;
      try { response = await res.json(); } catch { /* ignore */ }
      const ra = Number(res.headers?.get?.('retry-after'));
      throw new OracleError('rate limited by the oracle — slow down and retry after the cooldown', {
        code: 'RATE_LIMITED', status: 429, retryAfter: Number.isFinite(ra) ? ra : response?.retryAfter, response,
      });
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new OracleError(`invalid JSON from ${path} (HTTP ${res.status})`, { code: 'BAD_RESPONSE', status: res.status });
    }

    if (res.status === 404) throw new OracleError(data?.error || `unknown pair / not found: ${path}`, { code: 'NOT_FOUND', status: 404, response: data });
    // 503 => pair stale with no usable last price (insufficient live sources).
    if (res.status === 503) throw new OracleError(data?.error || 'pair is stale — insufficient live sources for a price', { code: 'STALE', status: 503, response: data });
    if (!res.ok || data?.ok === false) throw new OracleError(data?.error || `HTTP ${res.status} from ${path}`, { code: 'HTTP_ERROR', status: res.status, response: data });
    return data;
  }

  /**
   * Fetch a signed price for `pair`. By DEFAULT the signature is verified before returning; a
   * verification failure throws OracleError('VERIFICATION_FAILED'). Pass { verify: false } to skip.
   */
  async function getPrice(pair, { verify: doVerify = true } = {}) {
    const data = await request('POST', '/getPrice', { pair });
    if (doVerify) {
      const ok = await verify(data);
      if (!ok) {
        throw new OracleError(
          `signature verification FAILED for ${data?.pair || pair} — refusing to return an unverified price`,
          { code: 'VERIFICATION_FAILED', response: data },
        );
      }
    }
    return data;
  }

  /** Where a price came from: per-source raw values, used vs dropped (outlier/unreachable), attestation. */
  async function getProof(pair) {
    return request('POST', '/proof', { pair });
  }

  /** Signed time-weighted average price for a window ('1h' | '24h'). */
  async function getTwap(pair, window = '1h') {
    return request('POST', '/twap', { pair, window });
  }

  /** Last N on-chain snapshots for a pair (from the push feed). */
  async function getHistory(pair, limit = 10) {
    return request('POST', '/getPriceHistory', { pair, limit });
  }

  /**
   * Read the LATEST published snapshot straight from the ledger (no HTTP API). Builds a READ-ONLY
   * client (null signer) so it never publishes / can't fork the oracle head. Authenticity comes from
   * the data living on the oracle account's own chain (single-writer). Returns the pair's entry
   * (+ blockHash/timestamp) when `pair` is given, the whole snapshot when omitted, or null if none.
   */
  async function readLatestOnChain(pair) {
    const account = Account.fromPublicKeyString(oraclePubkey);
    const client = UserClient.fromNetwork(network, null, { account }); // null signer => READ-ONLY
    const blocks = await client.chain(); // most-recent-first
    for (const block of blocks) {
      const ops = block.operations || (typeof block.toJSON === 'function' ? block.toJSON().operations : []) || [];
      for (const op of ops) {
        const metadata = op.metadata ?? (typeof op.toJSON === 'function' ? op.toJSON().metadata : undefined);
        if (op.type === OP_SET_INFO && metadata) {
          let snap;
          try {
            snap = JSON.parse(Buffer.from(metadata, 'base64').toString('utf8'));
          } catch {
            continue;
          }
          if (snap?.type !== 'price-snapshot') continue;
          if (!pair) return snap;
          const key = String(pair).toUpperCase();
          const entry = snap.prices?.[key];
          if (!entry) throw new OracleError(`pair ${key} not in the latest on-chain snapshot`, { code: 'NOT_FOUND', response: snap });
          return { pair: key, ...entry, blockHash: block.hash.toString(), timestamp: snap.timestamp, oracle: snap.oracle };
        }
      }
    }
    return null;
  }

  return { baseUrl, getPrice, getProof, getTwap, getHistory, verify, readLatestOnChain };
}

export default { createClient, verify, OracleError, DEFAULT_BASE_URL, DEFAULT_ORACLE };
