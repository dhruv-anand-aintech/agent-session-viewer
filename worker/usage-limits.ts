export interface Env {
  USAGE_KV: KVNamespace
  SYNC_SECRET: string
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "X-Sync-Secret,Content-Type" } })
    }

    // POST /ingest — local daemon pushes full fetchAllUsage() snapshot
    if (req.method === "POST" && url.pathname === "/ingest") {
      if (req.headers.get("X-Sync-Secret") !== env.SYNC_SECRET)
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS })
      const body = await req.json() as Record<string, unknown>
      await env.USAGE_KV.put("usage_snapshot", JSON.stringify({ ...body, pushedAt: Date.now() }))
      return new Response(JSON.stringify({ ok: true }), { headers: CORS })
    }

    // GET /snapshot — return latest snapshot JSON
    if (req.method === "GET" && url.pathname === "/snapshot") {
      const raw = await env.USAGE_KV.get("usage_snapshot")
      if (!raw) return new Response(JSON.stringify({ error: "No data yet — daemon not running?" }), { status: 404, headers: CORS })
      return new Response(raw, { headers: CORS })
    }

    // GET / — minimal HTML dashboard that polls /snapshot
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    return new Response("Not Found", { status: 404 })
  },
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Usage — ainorthstartech</title>
<style>
  :root { --bg:#0d0d0f; --surface:#16161a; --border:#2a2a30; --text:#e8e8ed; --muted:#6e6e7a; --accent:#d97757; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; padding:2rem; }
  h1 { font-size:1.1rem; font-weight:600; margin-bottom:1.5rem; color:var(--muted); letter-spacing:.05em; text-transform:uppercase; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:1rem; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:1.2rem; }
  .card-title { font-weight:600; font-size:.95rem; margin-bottom:.8rem; display:flex; align-items:center; gap:.5rem; }
  .bar-wrap { margin:.4rem 0; }
  .bar-label { display:flex; justify-content:space-between; font-size:.75rem; color:var(--muted); margin-bottom:.25rem; }
  .bar-track { background:#222; border-radius:4px; height:6px; overflow:hidden; }
  .bar-fill { height:100%; border-radius:4px; transition:width .4s; }
  .bar-fill.low { background:#2fb565; }
  .bar-fill.medium { background:#f1c40f; }
  .bar-fill.high { background:#f27d22; }
  .bar-fill.exhausted { background:#e05050; }
  .stat { display:flex; justify-content:space-between; font-size:.78rem; padding:.2rem 0; border-bottom:1px solid var(--border); }
  .stat:last-child { border-bottom:none; }
  .stat-label { color:var(--muted); }
  .err { color:#e05050; font-size:.8rem; margin-top:.4rem; }
  .hint { color:var(--muted); font-size:.8rem; margin-top:.4rem; }
  footer { margin-top:2rem; font-size:.75rem; color:var(--muted); }
</style>
</head>
<body>
<h1>AI Usage · ainorthstartech</h1>
<div class="grid" id="grid"><div class="hint">Loading…</div></div>
<footer id="footer"></footer>
<script>
function pct(v){return v==null?null:Math.min(100,Math.max(0,v))}
function n(v){return typeof v==='number'?v:Number(v)||0}
function pf(v,d=0){return n(v).toFixed(d)}
function fmtD(iso){try{return new Date(iso).toLocaleDateString()}catch{return iso}}
function fmtDT(iso){try{return new Date(iso).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}catch{return iso}}
function usagePct(v){const x=n(v);return x<=1?x*100:x}
function fmtWindowReset(w){
  if(!w)return'';
  if(w.resetDescription)return w.resetDescription;
  if(w.resetsAt){try{return 'resets '+new Date(w.resetsAt).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}catch{return 'resets '+w.resetsAt}}
  return '';
}
function windowSub(w){const reset=fmtWindowReset(w);return pf(w?.usedPercent)+'%'+(reset?' · '+reset:'')}
function codexPlanLabel(plan){if(!plan)return'';const p=String(plan).toLowerCase();if(p==='prolite'||p==='pro')return'pro';if(p==='plus')return'plus';return String(plan)}
function bar(label,p,sub){
  const cls=p>=99?'exhausted':p>=80?'high':p>=50?'medium':'low';
  return \`<div class="bar-wrap"><div class="bar-label"><span>\${label}</span><span>\${sub??p.toFixed(0)+'%'}</span></div>
  <div class="bar-track"><div class="bar-fill \${cls}" style="width:\${p}%"></div></div></div>\`;
}
function stat(label,val){return \`<div class="stat"><span class="stat-label">\${label}</span><span>\${val}</span></div>\`}

function renderClaude(d){
  if(!d)return'';
  let h=\`<div class="card"><div class="card-title">✦ Claude Code</div>\`;
  if(d.error)h+=\`<div class="err">\${d.error}</div>\`;
  const u=d.usage;const cli=d.cliUsage;
  if(u?.five_hour){const p=pct(usagePct(u.five_hour.utilization));h+=bar('5-hour limit',p,pf(p)+'% · resets '+fmtDT(u.five_hour.resets_at))}
  if(u?.seven_day){const p=pct(usagePct(u.seven_day.utilization));h+=bar('7-day limit',p,pf(p)+'% · resets '+fmtDT(u.seven_day.resets_at))}
  if(!u?.five_hour&&cli?.sessionPct!=null)h+=bar('Session limit',pct(cli.sessionPct),cli.sessionPct+'%'+(cli.sessionResetsAt?' · resets '+cli.sessionResetsAt:''));
  if(!u?.seven_day&&cli?.weeklyPct!=null)h+=bar('Weekly limit',pct(cli.weeklyPct),cli.weeklyPct+'%'+(cli.weeklyResetsAt?' · resets '+cli.weeklyResetsAt:''));
  if(d.numSessions!=null)h+=stat('Sessions',d.numSessions);
  return h+'</div>';
}
function renderCursor(d){
  if(!d)return'';
  const s=d.usageSummary;
  const plan=s?.plan;
  let h=\`<div class="card"><div class="card-title">⬡ Cursor<small style="color:var(--muted);font-weight:400;margin-left:.5rem">\${d.me?.email??s?.membershipType??''}</small></div>\`;
  if(d.error)h+=\`<div class="err">\${d.error}</div>\`;
  if(plan?.totalPercentUsed!=null)h+=bar('Plan usage',pct(n(plan.totalPercentUsed)),pf(plan.totalPercentUsed)+'%'+(s?.billingCycleEnd?' · resets '+fmtDT(s.billingCycleEnd):''));
  if(plan?.autoPercentUsed!=null&&plan.autoPercentUsed!==plan.totalPercentUsed)h+=bar('Auto (composer)',pct(n(plan.autoPercentUsed)),pf(plan.autoPercentUsed)+'%');
  if(plan?.apiPercentUsed!=null)h+=bar('API (named model)',pct(n(plan.apiPercentUsed)),pf(plan.apiPercentUsed)+'%');
  if(s?.membershipType)h+=stat('Plan',s.membershipType);
  return h+'</div>';
}
function renderCodex(d){
  if(!d)return'';
  const w=d.wham;const pr=w?.rate_limit?.primary_window;const se=w?.rate_limit?.secondary_window;
  const lp=d.limits?.primary;const ls=d.limits?.secondary;
  let h=\`<div class="card"><div class="card-title">◈ Codex<small style="color:var(--muted);font-weight:400;margin-left:.5rem">\${[d.email,codexPlanLabel(w?.plan_type??d.plan)].filter(Boolean).join(' · ')}</small></div>\`;
  if(d.error)h+=\`<div class="err">\${d.error}</div>\`;
  const fmtTs=ts=>ts?new Date(ts*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';
  if(lp)h+=bar('5-hour limit',pct(n(lp.usedPercent)),windowSub(lp));
  else if(pr?.used_percent!=null)h+=bar('5-hour limit',pct(n(pr.used_percent)),pf(pr.used_percent)+'%'+(pr.reset_at?' · resets '+fmtTs(pr.reset_at):''));
  if(ls)h+=bar('Weekly limit',pct(n(ls.usedPercent)),windowSub(ls));
  else if(se?.used_percent!=null)h+=bar('Weekly limit',pct(n(se.used_percent)),pf(se.used_percent)+'%'+(se.reset_at?' · resets '+fmtD(new Date(se.reset_at*1000).toISOString()):''));
  if(w?.credits?.balance!=null)h+=stat('Credits','$'+pf(w.credits.balance,2));
  if(d.sessionCount!=null)h+=stat('Local sessions',d.sessionCount);
  return h+'</div>';
}
function renderGemini(d){
  if(!d)return'';
  const t=d.totalTokens;
  const l=d.limits;
  let h=\`<div class="card"><div class="card-title">◆ Gemini CLI<small style="color:var(--muted);font-weight:400;margin-left:.5rem">\${d.email??''}</small></div>\`;
  if(d.error)h+=\`<div class="err">\${d.error}</div>\`;
  if(d.quotaStatus)h+=\`<div class="hint">\${d.quotaStatus}</div>\`;
  if(l?.primary)h+=bar('Pro',pct(n(l.primary.usedPercent)),windowSub(l.primary));
  if(l?.secondary)h+=bar('Flash',pct(n(l.secondary.usedPercent)),windowSub(l.secondary));
  if(l?.tertiary)h+=bar('Flash Lite',pct(n(l.tertiary.usedPercent)),windowSub(l.tertiary));
  if(d.sessionCount!=null)h+=stat('Sessions',d.sessionCount);
  if(t&&t.input+t.output>0){
    const fmt=v=>n(v)>=1e6?(n(v)/1e6).toFixed(1)+'M':n(v)>=1e3?(n(v)/1e3).toFixed(0)+'K':String(n(v));
    h+=stat('Input',fmt(t.input))+stat('Output',fmt(t.output));
    if(n(t.cached)>0)h+=stat('Cached',fmt(t.cached));
  }
  return h+'</div>';
}
function renderOpenCode(d){
  if(!d)return'';
  let h=\`<div class="card"><div class="card-title">◇ OpenCode<small style="color:var(--muted);font-weight:400;margin-left:.5rem">\${(d.providers||[]).join(', ')||d.topModel||''}</small></div>\`;
  if(d.error)h+=\`<div class="err">\${d.error}</div>\`;
  if(d.sessionCount!=null)h+=stat('Sessions',d.sessionCount);
  if(d.totalCost>0)h+=stat('Total cost','$'+pf(d.totalCost,4));
  const fmt=v=>n(v)>=1e6?(n(v)/1e6).toFixed(1)+'M':n(v)>=1e3?(n(v)/1e3).toFixed(0)+'K':String(n(v));
  if(d.totalTokensIn)h+=stat('Input tokens',fmt(d.totalTokensIn));
  if(d.totalTokensOut)h+=stat('Output tokens',fmt(d.totalTokensOut));
  if(d.topModel)h+=stat('Top model',d.topModel);
  return h+'</div>';
}
function renderAntigravity(d){
  if(!d)return'';
  const q=d.quota;const cr=q?.promptCredits;
  let h=\`<div class="card"><div class="card-title">⟡ Antigravity<small style="color:var(--muted);font-weight:400;margin-left:.5rem">\${q?.email??d.model??''}</small></div>\`;
  if(d.error)h+=\`<div class="err">\${d.error}</div>\`;
  if(cr?.usedPercentage!=null)h+=bar('Prompt credits',pct(cr.usedPercentage*100),cr.used.toLocaleString()+' / '+cr.monthly.toLocaleString());
  if(d.sessionCount!=null)h+=stat('Sessions',d.sessionCount);
  return h+'</div>';
}

async function load(){
  try{
    const r=await fetch('/snapshot');
    const d=await r.json();
    if(!r.ok){
      document.getElementById('footer').textContent='Refresh failed: '+d.error;
      return;
    }
    localStorage.setItem('agentUsageSnapshot',JSON.stringify(d));
    renderSnapshot(d);
  }catch(e){
    document.getElementById('footer').textContent='Refresh failed: '+e.message;
  }
}
function renderSnapshot(d){
    const cards=[renderClaude(d.claude),renderCursor(d.cursor),renderCodex(d.codex),renderGemini(d.gemini),renderAntigravity(d.antigravity),renderOpenCode(d.opencode)].filter(Boolean).join('');
    document.getElementById('grid').innerHTML=cards||'<div class="hint">No data</div>';
    const age=d.pushedAt?Math.round((Date.now()-d.pushedAt)/1000)+'s ago':'unknown';
    document.getElementById('footer').textContent='Last pushed: '+age+' · auto-refresh 60s';
}
try{const cached=localStorage.getItem('agentUsageSnapshot');if(cached)renderSnapshot(JSON.parse(cached));}catch{}
load();setInterval(load,60000);
</script>
</body>
</html>`
