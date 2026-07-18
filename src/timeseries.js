// Persisted price time-series (SQLite via better-sqlite3) + TWAP computation.
// Records each poll's published median per pair; survives restarts so the TWAP window isn't lost.
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { DB_PATH, TWAP_RETENTION_MS } from './config.js';

let db = null;
let stmtInsert, stmtSince, stmtCarry, stmtOldest, stmtPrune;

export function initTimeseries(path = DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS prices (pair TEXT NOT NULL, ts INTEGER NOT NULL, price REAL NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_prices_pair_ts ON prices(pair, ts)');
  stmtInsert = db.prepare('INSERT INTO prices (pair, ts, price) VALUES (?, ?, ?)');
  stmtSince = db.prepare('SELECT ts, price FROM prices WHERE pair = ? AND ts > ? ORDER BY ts ASC');
  stmtCarry = db.prepare('SELECT ts, price FROM prices WHERE pair = ? AND ts <= ? ORDER BY ts DESC LIMIT 1');
  stmtOldest = db.prepare('SELECT MIN(ts) AS ts FROM prices WHERE pair = ?');
  stmtPrune = db.prepare('DELETE FROM prices WHERE ts < ?');
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
