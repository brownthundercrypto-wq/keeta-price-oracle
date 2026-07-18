// Live transparency dashboard — a read-only aggregate view of the oracle's inner workings.
// ADDITIVE: assembles data already in the cache; does not touch signing / aggregation / publishing.
//
// buildDashboardData() is PURE (cache prices + injected twap/onchain/oracle -> one all-pairs object)
// so it is unit-testable. dashboardPage() returns a self-contained HTML page (inline CSS/JS, no
// framework) that fetches /dashboard-data and auto-refreshes.
import { MIN_SOURCES, OUTLIER_THRESHOLD, VERSION } from './config.js';

const REPO_URL = 'https://github.com/brownthundercrypto-wq/keeta-price-oracle';
const VERIFY_URL = `${REPO_URL}/blob/main/verify-attestation.mjs`;

// Assemble the all-pairs dashboard payload. `twapResolver(pair)` -> { twap1h, twap24h } (value or
// "building"); `onchain` = latest publish { blockHash, publishedAt, trigger, reason } | null.
export function buildDashboardData({ prices = {}, oracle, twapResolver, onchain = null, nowIso }) {
  const pairs = [];
  const liveSources = new Set();
  let lastPriceUpdate = null;

  for (const e of Object.values(prices)) {
    for (const r of e.sourceReports || []) liveSources.add(r.name);
    if (e.updatedAt && (!lastPriceUpdate || e.updatedAt > lastPriceUpdate)) lastPriceUpdate = e.updatedAt;

    // Per-source breakdown: survivors used for the median + everything dropped (outlier / unreachable).
    const used = (e.sourceReports || []).map((r) => ({
      name: r.name, price: r.price ?? null, quote: r.quote ?? null, status: 'used', deviationPct: null, error: null,
    }));
    const dropped = (e.droppedSources || []).map((d) => ({
      name: d.name,
      price: d.price ?? null,
      quote: d.quote ?? null,
      status: d.type === 'outlier' ? 'outlier' : 'unreachable',
      deviationPct: d.deviationPct ?? null,
      error: d.error ?? null,
    }));
    const sources = [...used, ...dropped].sort((a, b) => a.name.localeCompare(b.name));

    const twap = twapResolver ? twapResolver(e.pair) : { twap1h: null, twap24h: null };
    pairs.push({
      pair: e.pair,
      symbol: e.symbol,
      price: e.price ?? null,
      priceScaled: e.priceScaled ?? null,
      priceScaleDecimals: e.priceScaleDecimals ?? null,
      quoteCurrency: e.quoteCurrency ?? 'USD',
      method: e.method ?? 'median',
      stale: !!e.stale,
      liveSourceCount: e.liveSourceCount ?? 0,
      confidenceBand: e.confidenceBand ?? null,
      confidencePct: e.confidencePct ?? null,
      twap1h: twap.twap1h ?? null,
      twap24h: twap.twap24h ?? null,
      updatedAt: e.updatedAt ?? null,
      sources,
    });
  }

  return {
    ok: true,
    oracle,
    network: 'test',
    version: VERSION,
    aggregation: 'median',
    minSourcesRequired: MIN_SOURCES,
    outlierThresholdPct: OUTLIER_THRESHOLD * 100,
    liveSourceCount: liveSources.size,
    sources: [...liveSources].sort(),
    lastPriceUpdate,
    onchain,
    generatedAt: nowIso,
    pairs,
  };
}

// Self-contained dashboard HTML (inline CSS/JS). Fetches /dashboard-data and auto-refreshes ~15s.
export function dashboardPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Keeta Price Oracle — Live Dashboard (testnet)</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: #0f1115; color: #e6e6e6; }
  a { color: #7aa2f7; }
  .wrap { max-width: 1000px; margin: 0 auto; padding: 28px 18px 64px; }
  header.top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 14px; margin-bottom: 6px; }
  h1 { font-size: 1.5rem; margin: 0; }
  .muted { color: #8b93a7; }
  .sub { color: #8b93a7; margin: 0 0 18px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .statbar { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 18px; }
  .stat { background: #161a22; border: 1px solid #262a33; border-radius: 10px; padding: 10px 14px; flex: 1 1 auto; min-width: 150px; }
  .stat .k { color: #8b93a7; font-size: 0.72rem; text-transform: uppercase; letter-spacing: .04em; }
  .stat .v { font-size: 1.02rem; margin-top: 2px; word-break: break-all; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #7ee2a8; margin-right: 6px; vertical-align: middle; }
  .dot.refreshing { background: #f7c86b; animation: pulse .8s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
  .card { background: #161a22; border: 1px solid #262a33; border-radius: 12px; padding: 14px 16px; }
  .card h2 { font-size: 1.05rem; margin: 0 0 2px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .price { font-size: 1.7rem; font-weight: 650; margin: 6px 0 2px; }
  .price .q { font-size: 0.9rem; color: #8b93a7; font-weight: 400; }
  .row { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0; color: #c7ccd6; }
  .row .k { color: #8b93a7; }
  .badge { font-size: 0.7rem; padding: 2px 8px; border-radius: 999px; border: 1px solid; }
  .badge.fresh { color: #7ee2a8; border-color: #1f5132; background: #16351f; }
  .badge.stale { color: #f79a9a; border-color: #5a2130; background: #351619; }
  details { margin-top: 10px; border-top: 1px solid #23272f; padding-top: 8px; }
  summary { cursor: pointer; color: #8b93a7; font-size: 0.82rem; user-select: none; }
  summary:hover { color: #c7ccd6; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.82rem; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #20242c; white-space: nowrap; }
  th { color: #8b93a7; font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .src-used td:first-child::before { content: "●"; color: #7ee2a8; margin-right: 6px; }
  .src-outlier td:first-child::before { content: "●"; color: #f7c86b; margin-right: 6px; }
  .src-unreachable td:first-child::before { content: "●"; color: #f79a9a; margin-right: 6px; }
  .src-outlier td, .src-unreachable td { color: #9aa1ad; }
  .callout { margin: 22px 0 0; background: #12161d; border: 1px solid #262a33; border-left: 3px solid #7aa2f7; border-radius: 8px; padding: 12px 16px; }
  .callout b { color: #e6e6e6; }
  footer { margin-top: 28px; color: #8b93a7; font-size: 0.82rem; }
  .err { color: #f79a9a; }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>Keeta Price Oracle <span class="muted">Live</span></h1>
    <span class="muted">testnet · v${VERSION}</span>
  </header>
  <p class="sub">Every price below is a median of independent sources. This page shows exactly where
     each number came from — including the sources that were dropped as outliers.</p>

  <div class="statbar" id="statbar"><div class="stat"><div class="k">Loading…</div><div class="v">—</div></div></div>

  <div class="grid" id="grid"></div>

  <div class="callout">
    <b>Don't trust me — verify any quote yourself.</b> Every <code>/getPrice</code> response is
    cryptographically signed. Run the clean-room verifier
    <a href="${VERIFY_URL}">verify-attestation.mjs</a> (it imports none of this server's code) to
    confirm a price against the oracle's public key, or read the
    <a href="${REPO_URL}">full source on GitHub</a>.
  </div>

  <footer>
    <span class="dot" id="refreshDot"></span><span id="refreshMsg">—</span> ·
    auto-refreshes every 15s · <a href="/">home</a> · <a href="/health">/health</a>
  </footer>
</div>

<script>
  var REFRESH_MS = 15000;
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function fmtTime(iso){ if(!iso) return '—'; try { return new Date(iso).toLocaleString(); } catch(e){ return iso; } }
  function ago(iso){ if(!iso) return ''; var s=Math.max(0,Math.round((Date.now()-new Date(iso).getTime())/1000)); return s<60? s+'s ago' : Math.round(s/60)+'m ago'; }

  function sourceRow(s){
    var cls = s.status==='used' ? 'src-used' : (s.status==='outlier' ? 'src-outlier' : 'src-unreachable');
    var detail = s.status==='outlier' ? ('dropped · '+esc(s.deviationPct)+'% off')
               : s.status==='unreachable' ? ('unreachable · '+esc(s.error||'error'))
               : 'used';
    var price = s.price!=null ? esc(s.price) : '—';
    return '<tr class="'+cls+'"><td>'+esc(s.name)+'</td><td class="num">'+price+'</td><td>'+esc(s.quote||'')+'</td><td>'+detail+'</td></tr>';
  }

  function card(p){
    var badge = p.stale ? '<span class="badge stale">STALE</span>' : '<span class="badge fresh">fresh</span>';
    var price = p.price!=null ? esc(p.price) : '—';
    var used = p.sources.filter(function(s){return s.status==='used';}).length;
    var srcRows = p.sources.map(sourceRow).join('');
    return '<div class="card">'
      + '<h2>'+esc(p.pair)+' '+badge+'</h2>'
      + '<div class="price">'+price+' <span class="q">'+esc(p.quoteCurrency)+'</span></div>'
      + '<div class="row"><span class="k">confidence</span><span>±'+esc(p.confidenceBand==null?'—':p.confidenceBand)+' ('+esc(p.confidencePct==null?'—':p.confidencePct)+'%)</span></div>'
      + '<div class="row"><span class="k">TWAP 1h</span><span>'+esc(p.twap1h==null?'—':p.twap1h)+'</span></div>'
      + '<div class="row"><span class="k">TWAP 24h</span><span>'+esc(p.twap24h==null?'—':p.twap24h)+'</span></div>'
      + '<div class="row"><span class="k">sources</span><span>'+used+' used / '+p.sources.length+' seen</span></div>'
      + '<div class="row"><span class="k">updated</span><span>'+ago(p.updatedAt)+'</span></div>'
      + '<details><summary>Per-source breakdown (where this price came from)</summary>'
      + '<table><thead><tr><th>source</th><th class="num">price</th><th>quote</th><th>status</th></tr></thead><tbody>'
      + srcRows + '</tbody></table></details>'
      + '</div>';
  }

  function statbar(d){
    var oc = d.onchain;
    var ocVal = oc ? ('<a href="'+esc('${REPO_URL}')+'">'+esc(String(oc.blockHash).slice(0,16))+'…</a>') : 'pending';
    var ocTrig = oc ? (esc(oc.trigger)+' · '+ago(oc.publishedAt)) : '—';
    return [
      ['Live sources', d.liveSourceCount + ' <span class="muted">('+esc((d.sources||[]).join(', '))+')</span>'],
      ['Aggregation', esc(d.aggregation)+' · min '+d.minSourcesRequired+' · outlier &gt;'+esc(d.outlierThresholdPct)+'%'],
      ['Last price update', fmtTime(d.lastPriceUpdate)+' <span class="muted">('+ago(d.lastPriceUpdate)+')</span>'],
      ['Latest on-chain block', ocVal],
      ['On-chain trigger', ocTrig],
      ['Oracle account', '<span class="muted">'+esc(d.oracle)+'</span>']
    ].map(function(s){ return '<div class="stat"><div class="k">'+s[0]+'</div><div class="v">'+s[1]+'</div></div>'; }).join('');
  }

  var dot = document.getElementById('refreshDot');
  var msg = document.getElementById('refreshMsg');
  async function load(){
    dot.className = 'dot refreshing'; msg.textContent = 'refreshing…';
    try {
      var r = await fetch('/dashboard-data', { headers: { 'Accept':'application/json' } });
      var d = await r.json();
      if(!d.ok) throw new Error(d.error||'bad response');
      document.getElementById('statbar').innerHTML = statbar(d);
      document.getElementById('grid').innerHTML = (d.pairs||[]).map(card).join('');
      dot.className = 'dot'; msg.textContent = 'updated ' + new Date().toLocaleTimeString();
    } catch(e){
      dot.className = 'dot'; msg.innerHTML = '<span class="err">refresh failed: '+esc(e.message)+'</span>';
    }
  }
  load();
  setInterval(load, REFRESH_MS);
</script>
</body>
</html>`;
}
