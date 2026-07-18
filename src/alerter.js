// Internal monitoring + alerting for the price oracle. ADDITIVE — it only observes; it never
// touches signing, aggregation, or publishing.
//
// Design:
//  - decideAlerts() is a PURE function: (health snapshot, prior alert state, now, cfg) -> { alerts,
//    state }. It fires on STATE TRANSITIONS only (once when a condition goes bad, once when it
//    recovers) with an optional reminder after a cooldown, so a persistent problem never spams.
//  - sendAlert() posts a Discord-format message ({ content }) to ALERT_WEBHOOK_URL. If the URL is
//    unset, alerting is disabled and the message is logged locally. Every send is wrapped in
//    try/catch + a short abort timeout — a webhook failure can NEVER crash or block the oracle.
//  - runAlertCycle() glues them: decide against module-held state, send each alert, persist state.
//
// Run directly to fire a one-off TEST alert (confirms webhook delivery):
//   ALERT_WEBHOOK_URL=<url> node src/alerter.js        (or:  npm run alert:test)
import { fileURLToPath } from 'url';
import {
  ALERT_WEBHOOK_URL,
  ALERT_MIN_SOURCES,
  ALERT_DISAGREEMENT_PCT,
  ALERT_REALERT_MINUTES,
  VERSION,
} from './config.js';

const TAG = '[keeta-price-oracle testnet]';
const SEND_TIMEOUT_MS = 5000;

// ── Pure decision core ───────────────────────────────────────────────────────────────────────────
// `health`  : { liveSourceCount:number, pairs:{ [pair]:{ stale:bool, confidencePct:number|null } },
//               publishOk:boolean|null }   (publishOk null = unknown yet -> publish condition skipped)
// `prior`   : { [key]: { status:'ok'|'bad', since:number, lastAlertAt:number } }
// `cfg`     : { minSources, disagreementPct, realertMs }
// Returns   : { alerts:[{ key, transition:'bad'|'recover'|'reminder', severity, message }], state }
// Never mutates `prior`.
export function decideAlerts(health, prior = {}, now = Date.now(), cfg = liveCfg()) {
  const state = { ...prior };
  const alerts = [];

  // Evaluate one keyed condition against its prior status and emit a transition alert if warranted.
  const evalCond = (key, isBad, severity, badMsg, recoverMsg) => {
    const prev = state[key] || { status: 'ok', since: 0, lastAlertAt: 0 };
    if (isBad) {
      if (prev.status !== 'bad') {
        alerts.push({ key, transition: 'bad', severity, message: badMsg });
        state[key] = { status: 'bad', since: now, lastAlertAt: now };
      } else if (cfg.realertMs > 0 && now - prev.lastAlertAt >= cfg.realertMs) {
        alerts.push({ key, transition: 'reminder', severity, message: `⏰ STILL: ${badMsg}` });
        state[key] = { ...prev, lastAlertAt: now };
      } else {
        state[key] = prev; // stays bad, within cooldown -> no alert
      }
    } else if (prev.status === 'bad') {
      alerts.push({ key, transition: 'recover', severity: 'ok', message: recoverMsg });
      state[key] = { status: 'ok', since: now, lastAlertAt: now };
    } else {
      state[key] = prev;
    }
  };

  // (2a) Global live-source floor.
  evalCond(
    'sources',
    Number(health.liveSourceCount) < cfg.minSources,
    'critical',
    `🔴 liveSourceCount ${health.liveSourceCount} is below the floor of ${cfg.minSources}`,
    `🟢 sources recovered: liveSourceCount ${health.liveSourceCount} >= ${cfg.minSources}`,
  );

  // (2b) On-chain publish health (only once we have a known outcome).
  if (health.publishOk != null) {
    evalCond(
      'publish',
      health.publishOk === false,
      'critical',
      `🔴 on-chain publish is FAILING (publisher exhausted self-heal retries)`,
      `🟢 on-chain publish recovered (a snapshot landed again)`,
    );
  }

  // (2c) Per-pair stale + high-disagreement.
  for (const [pair, p] of Object.entries(health.pairs || {})) {
    evalCond(
      `stale:${pair}`,
      !!p.stale,
      'critical',
      `🔴 ${pair} is STALE (below MIN_SOURCES / no fresh update)`,
      `🟢 ${pair} recovered (fresh price again)`,
    );
    const disagree = p.confidencePct != null && Number(p.confidencePct) > cfg.disagreementPct;
    evalCond(
      `disagree:${pair}`,
      disagree,
      'warning',
      `🟠 ${pair} high disagreement: confidencePct ${p.confidencePct}% > ${cfg.disagreementPct}%`,
      `🟢 ${pair} source agreement back to normal (confidencePct <= ${cfg.disagreementPct}%)`,
    );
  }

  return { alerts, state };
}

// One-line Discord message from an alert record.
export function formatAlert(a) {
  return `${TAG} ${a.message}`;
}

// ── Impure send / orchestration ──────────────────────────────────────────────────────────────────
let webhookUrl = ALERT_WEBHOOK_URL;
let alertCfg = liveCfg();
let alertState = {};

function liveCfg() {
  return {
    minSources: ALERT_MIN_SOURCES,
    disagreementPct: ALERT_DISAGREEMENT_PCT,
    realertMs: ALERT_REALERT_MINUTES * 60_000,
  };
}

// Initialize from env (or overrides for tests). Resets transition state. Returns { enabled, cfg }.
export function initAlerter(overrides = {}) {
  webhookUrl = overrides.url ?? ALERT_WEBHOOK_URL;
  alertCfg = {
    minSources: overrides.minSources ?? ALERT_MIN_SOURCES,
    disagreementPct: overrides.disagreementPct ?? ALERT_DISAGREEMENT_PCT,
    realertMs: (overrides.realertMinutes ?? ALERT_REALERT_MINUTES) * 60_000,
  };
  alertState = {};
  return { enabled: !!webhookUrl, cfg: alertCfg };
}

// Post a message to the webhook. NEVER throws, NEVER blocks beyond the timeout. Disabled (log-only)
// when no webhook URL is configured.
export async function sendAlert(content, opts = {}) {
  const url = opts.url ?? webhookUrl;
  if (!url) {
    console.log(`[alert] (disabled — no ALERT_WEBHOOK_URL) ${content}`);
    return { sent: false, reason: 'no-webhook' };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? SEND_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }), // Discord-format payload
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[alert] webhook HTTP ${res.status} — dropping alert (not fatal)`);
      return { sent: false, reason: `http-${res.status}` };
    }
    console.log(`[alert] sent: ${content}`);
    return { sent: true };
  } catch (e) {
    console.warn(`[alert] webhook send failed (not fatal): ${e.message}`);
    return { sent: false, reason: e.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

// Evaluate the current health against the persisted transition state and send any fired alerts.
// Safe to call fire-and-forget on a timer. Returns the alerts that fired (for logging/tests).
export async function runAlertCycle(health, now = Date.now()) {
  let alerts = [];
  try {
    const decision = decideAlerts(health, alertState, now, alertCfg);
    alertState = decision.state; // persist synchronously before any awaits
    alerts = decision.alerts;
    for (const a of alerts) await sendAlert(formatAlert(a));
  } catch (e) {
    console.warn(`[alert] cycle failed (not fatal): ${e.message}`);
  }
  return alerts;
}

// Startup / restart notice so operator sees restarts. One-shot (not a transition condition).
export async function sendStartupAlert(version, liveSourceCount) {
  return sendAlert(`${TAG} 🔵 started: v${version}, ${liveSourceCount} live sources`);
}

// Direct-run: fire a one-off TEST alert to confirm delivery, then exit with the send result.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  initAlerter();
  const stamp = new Date().toISOString();
  const msg = `${TAG} ✅ TEST alert — if you can read this, ALERT_WEBHOOK_URL delivery works (v${VERSION}, ${stamp})`;
  sendAlert(msg).then((r) => {
    console.log('[alert] test result:', JSON.stringify(r));
    process.exit(r.sent ? 0 : 1);
  });
}
