// Type declarations for keeta-price-oracle-client.

/** The live public testnet oracle base URL. */
export declare const DEFAULT_BASE_URL: string;
/** The live testnet oracle account pubkey (used by readLatestOnChain). */
export declare const DEFAULT_ORACLE: string;

export type ErrorCode =
  | 'VERIFICATION_FAILED'
  | 'RATE_LIMITED'
  | 'STALE'
  | 'HTTP_ERROR'
  | 'NETWORK'
  | 'NOT_FOUND'
  | 'BAD_RESPONSE';

/** Typed error thrown for every failure mode. Inspect `code` (and `status`/`retryAfter`). */
export declare class OracleError extends Error {
  name: 'OracleError';
  code: ErrorCode;
  /** HTTP status, when the failure came from an HTTP response. */
  status?: number;
  /** Seconds to wait, present when `code === 'RATE_LIMITED'`. */
  retryAfter?: number;
  /** The parsed response body, when available. */
  response?: unknown;
}

export interface Attestation {
  nonce: string;
  timestamp: string;
  signature: string;
}

/** A signed /getPrice response. `signedFields` lists the exact fields (in order) covered by `attestation`. */
export interface PriceResponse {
  ok: boolean;
  oracle: string;
  pair: string;
  symbol: string;
  /** Authoritative price as an exact decimal STRING (median of live sources). */
  price: string;
  quoteCurrency: string;
  /** Optional integer form at `priceScaleDecimals` precision. */
  priceScaled: string;
  /** PRICE fixed-point precision (NOT any token's on-chain decimals). */
  priceScaleDecimals: number;
  method: string;
  /** Ordered, comma-joined provenance (signed). */
  sources: string;
  sourceList: string[];
  confidenceBand: string;
  confidencePct: string;
  /** 1h TWAP value string, or "building" during cold start. */
  twap1h: string;
  /** 24h TWAP value string, or "building" during cold start. */
  twap24h: string;
  twapDetail?: unknown;
  liveSourceCount: number;
  stale: boolean;
  timestamp: string;
  /** The exact fields (in order) covered by `attestation` — build the signed array from this. */
  signedFields: string[];
  attestation: Attestation;
}

export interface ProofResponse {
  ok: boolean;
  oracle: string;
  pair: string;
  symbol: string;
  aggregation: Record<string, unknown>;
  sources: Array<{ name: string; price: string; ts?: string; quote?: string }>;
  sourcesUnreachable: Array<Record<string, unknown>>;
  sourcesOutliers: Array<Record<string, unknown>>;
  finalPrice: string | null;
  [k: string]: unknown;
}

export interface TwapResponse {
  ok: boolean;
  oracle: string;
  pair: string;
  quoteCurrency: string;
  window: '1h' | '24h' | string;
  /** TWAP value string, or "building" (signed). */
  twap: string;
  status: 'ready' | 'building';
  signedFields: string[];
  attestation: Attestation;
  [k: string]: unknown;
}

export interface HistoryResponse {
  ok: boolean;
  oracle: string;
  pair: string;
  count: number;
  history: Array<{ blockHash: string; timestamp: string; [k: string]: unknown }>;
}

/** A per-pair entry decoded from the latest on-chain snapshot. */
export interface OnChainEntry {
  pair: string;
  symbol?: string;
  price: string;
  quoteCurrency?: string;
  priceScaled?: string;
  priceScaleDecimals?: number;
  method?: string;
  sources?: string;
  stale?: boolean;
  updatedAt?: string;
  blockHash: string;
  timestamp: string;
  oracle: string;
  [k: string]: unknown;
}

export interface OnChainSnapshot {
  type: 'price-snapshot';
  oracle: string;
  network: string;
  timestamp: string;
  prices: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

export interface GetPriceOptions {
  /** Verify the signature before returning (default: true). */
  verify?: boolean;
}

export interface ClientOptions {
  /** HTTP base URL of the oracle instance (default: the live oracle). */
  baseUrl?: string;
  /** fetch implementation (default: global fetch). Inject to mock in tests. */
  fetch?: typeof fetch;
  /** Oracle account pubkey for readLatestOnChain (default: the live oracle). */
  oracle?: string;
  /** Keeta network for readLatestOnChain (default: 'test'). */
  network?: string;
}

export interface OracleClient {
  readonly baseUrl: string;
  /** Fetch a signed price. Verifies the signature by default; throws OracleError('VERIFICATION_FAILED') on mismatch. */
  getPrice(pair: string, opts?: GetPriceOptions): Promise<PriceResponse>;
  getProof(pair: string): Promise<ProofResponse>;
  getTwap(pair: string, window?: '1h' | '24h' | string): Promise<TwapResponse>;
  getHistory(pair: string, limit?: number): Promise<HistoryResponse>;
  /** Standalone clean-room verification of a signed response. */
  verify(response: unknown): Promise<boolean>;
  /** Read the latest snapshot straight from the ledger (no HTTP). Entry for `pair`, whole snapshot if omitted, or null. */
  readLatestOnChain(pair?: string): Promise<OnChainEntry | OnChainSnapshot | null>;
}

/** Standalone clean-room verification of a signed oracle response. */
export declare function verify(response: unknown): Promise<boolean>;

/** Create a client bound to one oracle instance. */
export declare function createClient(opts?: ClientOptions): OracleClient;

declare const _default: {
  createClient: typeof createClient;
  verify: typeof verify;
  OracleError: typeof OracleError;
  DEFAULT_BASE_URL: typeof DEFAULT_BASE_URL;
  DEFAULT_ORACLE: typeof DEFAULT_ORACLE;
};
export default _default;
