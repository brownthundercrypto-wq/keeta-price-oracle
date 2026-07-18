// Persisted price time-series (SQLite via better-sqlite3) + TWAP computation.
// Records each poll's published median per pair; survives restarts so the TWAP window isn't lost.
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { DB_PATH, TWAP_RETENTION_MS } from './config.js';

let db = null;
let stmtInsert, stmtSince, stmtCarry, stmtOldest, stmtPrune;
// Push-feed state (baseline per pair + global meta). See getLastPublished/setLastPublished below.
let stmtLastGet, stmtLastAll, stmtLastUpsert, stmtMetaGet, stmtMetaSet;

export function initTimeseries(path = DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS prices (pair TEXT NOT NULL, ts INTEGER NOT NULL, price REAL NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_prices_pair_ts ON prices(pair, ts)');
  // On-chain PUSH feed: per-pair last-published-on-chain price + timestamp (the deviation baseline).
  // Persisted here (on the /data volume) so deviation triggers survive restarts.
  db.exec('CREATE TABLE IF NOT EXISTS last_published (pair TEXT PRIMARY KEY, price REAL NOT NULL, ts INTEGER NOT NULL)');
  // Small key/value store for global push-feed state (e.g. last_publish_ts for heartbeat/min-interval).
  db.exec('CREATE TABLE IF NOT EXISTS oracle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  stmtInsert = db.prepare('INSERT INTO prices (pair, ts, price) VALUES (?, ?, ?)');
  stmtSince = db.prepare('SELECT ts, price FROM prices WHERE pair = ? AND ts > ? ORDER BY ts ASC');
  stmtCarry = db.prepare('SELECT ts, price FROM prices WHERE pair = ? AND ts <= ? ORDER BY ts DESC LIMIT 1');
  stmtOldest = db.prepare('SELECT MIN(ts) AS ts FROM prices WHERE pair = ?');
  stmtPrune = db.prepare('DELETE FROM prices WHERE ts < ?');
  stmtLastGet = db.prepare('SELECT pair, price, ts FROM last_published WHERE pair = ?');
  stmtLastAll = db.prepare('SELECT pair, price, ts FROM last_published');
  stmtLastUpsert = db.prepare(
    'INSERT INTO last_published (pair, price, ts) VALUES (?, ?, ?) ' +
      'ON CONFLICT(pair) DO UPDATE SET price = excluded.price, ts = excluded.ts',
  );
  stmtMetaGet = db.prepare('SELECT value FROM oracle_meta WHERE key = ?');
  stmtMetaSet = db.prepare(
    'INSERT INTO oracle_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  return { path };
}

export function recordPrice(pair, price, tsMs) {
  if (!db || !Number.isFinite(price)) return;
  stmtInsert.run(pair, Math.floor(tsMs), price);
}

// Delete anything older than the retention horizon (longest window + carry-in buffer).
export function pruneOld(nowMs = Date.now()) {
  if (!db) return 0;
  return stmtPrune.run(nowMs - TWAP_RETENTION_MS).changes;
}

// Time-weighted average price over [nowMs - windowMs, nowMs]: each price is weighted by the
// duration it was the current price (not a naive average of samples).
// Returns { status:'ready'|'building', value, haveMs, windowMs, samples }.
// On cold start (no sample at/ before the window start -> we can't cover the whole window),
// returns status 'building' with value null and how much history exists (haveMs).
export function computeTwap(pair, windowMs, nowMs = Date.now()) {
  const empty = (haveMs = 0, samples = 0) => ({ status: 'building', value: null, haveMs, windowMs, samples });
  if (!db) return empty();

  const oldest = stmtOldest.get(pair)?.ts ?? null;
  if (oldest == null) return empty();
  const haveMs = nowMs - oldest;

  const windowStart = nowMs - windowMs;
  const carry = stmtCarry.get(pair, windowStart); // last known price at/before the window start
  if (!carry) return empty(haveMs); // no coverage back to window start -> not enough history

  const inWindow = stmtSince.all(pair, windowStart);
  // Effective step-function points, clipped so the first point sits exactly at the window start.
  const points = [{ ts: windowStart, price: carry.price }, ...inWindow.map((r) => ({ ts: r.ts, price: r.price }))];

  let weighted = 0;
  let dur = 0;
  for (let i = 0; i < points.length; i++) {
    const segStart = points[i].ts;
    const segEnd = i + 1 < points.length ? points[i + 1].ts : nowMs;
    const d = segEnd - segStart;
    if (d <= 0) continue;
    weighted += points[i].price * d;
    dur += d;
  }
  const value = dur > 0 ? weighted / dur : carry.price;
  return { status: 'ready', value, haveMs, windowMs, samples: inWindow.length + 1 };
}

// ── On-chain PUSH feed: last-published-on-chain baseline (per pair) + global meta ────────────────
// The deviation trigger compares each pair's CURRENT median against the price we LAST published
// on-chain for that pair. These are updated ONLY after a successful publish, so a failed publish
// never advances the baseline (the pair stays "due" until it actually lands on-chain).

// Latest on-chain price + ts for one pair, or null if never published.
export function getLastPublished(pair) {
  if (!db) return null;
  const row = stmtLastGet.get(pair);
  return row ? { pair: row.pair, price: row.price, ts: row.ts } : null;
}

// All per-pair baselines as { [pair]: { price, ts } }. Empty on the very first run (no baseline yet).
export function getAllLastPublished() {
  if (!db) return {};
  const out = {};
  for (const row of stmtLastAll.all()) out[row.pair] = { price: row.price, ts: row.ts };
  return out;
}

// Upsert one pair's baseline. Call inside setLastPublishedBatch after a successful on-chain publish.
export function setLastPublished(pair, price, tsMs) {
  if (!db || !Number.isFinite(price)) return;
  stmtLastUpsert.run(pair, price, Math.floor(tsMs));
}

// Atomically update baselines for every published pair (all-or-nothing).
export function setLastPublishedBatch(entries, tsMs) {
  if (!db) return;
  const ts = Math.floor(tsMs);
  const tx = db.transaction((rows) => {
    for (const [pair, price] of rows) {
      if (Number.isFinite(price)) stmtLastUpsert.run(pair, price, ts);
    }
  });
  tx(entries);
}

// Global key/value meta (used for last_publish_ts: heartbeat + min-interval baseline).
export function getMeta(key) {
  if (!db) return null;
  return stmtMetaGet.get(key)?.value ?? null;
}

export function setMeta(key, value) {
  if (!db) return;
  stmtMetaSet.run(key, String(value));
}
