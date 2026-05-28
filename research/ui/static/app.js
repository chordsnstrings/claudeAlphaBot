"use strict";
const $ = (s, r = document) => r.querySelector(s);
const fmtX = v => (v == null ? "—" : v.toFixed(1) + "×");
const pct = v => (v == null ? "—" : (v * 100).toFixed(v && Math.abs(v) < 0.1 ? 1 : 0) + "%");
const sgn = v => (v > 0 ? "pos" : v < 0 ? "neg" : "");
function usd(v, c = true) {
  if (v == null) return "—";
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (c && a >= 1e6) return s + "$" + (a / 1e6).toFixed(2) + "M";
  if (c && a >= 1e3) return s + "$" + (a / 1e3).toFixed(0) + "k";
  return s + "$" + Math.round(a).toLocaleString();
}
const elHTML = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

/* ---------- tiny SVG charts (no deps) ---------- */
function lineChart(host, pts, { area = true } = {}) {
  const W = 560, H = 190, pl = 8, pr = 8, pt = 12, pb = 22;
  const ys = pts.map(p => p[1]); const ymin = Math.min(0, ...ys), ymax = Math.max(...ys, 1);
  const X = i => pl + (i / (pts.length - 1)) * (W - pl - pr);
  const Y = v => pt + (1 - (v - ymin) / (ymax - ymin || 1)) * (H - pt - pb);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
  let g = "";
  for (let k = 0; k <= 3; k++) { const v = ymin + (k / 3) * (ymax - ymin); const y = Y(v).toFixed(1);
    g += `<line class="gridline" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/><text class="axlab" x="${W - pr}" y="${y - 3}" text-anchor="end">${usd(v)}</text>`; }
  const labs = [0, Math.floor(pts.length / 2), pts.length - 1].map(i =>
    `<text class="axlab" x="${X(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}">${pts[i][0]}</text>`).join("");
  const fill = area ? `<path d="${line}L${X(pts.length - 1)},${Y(ymin)}L${X(0)},${Y(ymin)}Z" fill="url(#cg)" opacity=".18"/>` : "";
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#6366f1" stop-opacity="0"/></linearGradient>
    <linearGradient id="lg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs>
    ${g}${fill}<path d="${line}" fill="none" stroke="url(#lg)" stroke-width="2.2" stroke-linejoin="round"/>${labs}</svg>`;
}
function scatter(host, pts) {
  const W = 560, H = 190, pl = 30, pr = 8, pt = 12, pb = 24;
  const xmax = Math.max(...pts.map(p => p.dd)) * 1.05, ymax = Math.max(...pts.map(p => p.roi)) * 1.05;
  const X = v => pl + (v / xmax) * (W - pl - pr), Y = v => pt + (1 - v / ymax) * (H - pt - pb);
  let g = "";
  for (let k = 0; k <= 3; k++) { const v = (k / 3) * ymax, y = Y(v).toFixed(1);
    g += `<line class="gridline" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/><text class="axlab" x="${pl - 5}" y="${y + 3}" text-anchor="end">${v.toFixed(0)}×</text>`; }
  for (let k = 0; k <= 4; k++) { const v = (k / 4) * xmax; g += `<text class="axlab" x="${X(v)}" y="${H - 7}" text-anchor="middle">${pct(v)}</text>`; }
  const dots = pts.map(p => p.rec ? "" :
    `<circle cx="${X(p.dd).toFixed(1)}" cy="${Y(p.roi).toFixed(1)}" r="2.4" fill="#6366f1" opacity=".32"/>`).join("");
  const rec = pts.find(p => p.rec);
  const recDot = rec ? `<circle cx="${X(rec.dd)}" cy="${Y(rec.roi)}" r="6" fill="none" stroke="#5eead4" stroke-width="2"/><circle cx="${X(rec.dd)}" cy="${Y(rec.roi)}" r="3" fill="#5eead4"/>` : "";
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}${dots}${recDot}
    <text class="axlab" x="${W - pr}" y="${pt + 4}" text-anchor="end">↑ROI · →drawdown</text></svg>`;
}

/* ---------- render ---------- */
function render(d) {
  const s = d.strategy, h = s.headline;
  $("#asof").textContent = "as of " + (d.live?.asof || d.market?.asof || "—");
  const mb = $("#mode-badge"); mb.textContent = d.live?.live ? "PAPER · live-data" : "PAPER";
  // KPIs
  $("#kpis").innerHTML = [
    ["Cash ROI", fmtX(h.roi), "on $" + (s.base / 1e3) + "k base, reset yearly"],
    ["Cash extracted", usd(h.cash), "base intact · self-funding ✓"],
    ["Max drawdown", pct(h.dd), "of total wealth"],
    ["Principal back", h.days + " days", "then house money"],
  ].map(([l, v, n]) => `<div class="kpi"><div class="k-lab">${l}</div><div class="k-val">${v}</div><div class="k-note">${n}</div></div>`).join("");
  // book weights
  const wmax = Math.max(...Object.values(s.weights));
  $("#book-weights").innerHTML = Object.entries(s.weights).map(([k, v]) =>
    `<div class="wrow"><span class="wname">${k}</span><div class="wbar"><span style="width:${(v / wmax * 100).toFixed(0)}%"></span></div><span class="wpct">${pct(v)}</span></div>`).join("");
  $("#harvest-chips").innerHTML = [
    ["base", "$" + (s.base / 1e3) + "k"], ["leverage", s.leverage + "×"],
    ["take-profit", "at 2×"], ["leave on table", pct(1 - s.harvest.harvest_frac)],
    ["stop", "−" + pct(s.harvest.stop)], ["reset", "yearly"],
  ].map(([k, v]) => `<span class="chip">${k} <b>${v}</b></span>`).join("");
  // sleeves
  const sh = `<div class="trow thead sleeve-row"><span>sleeve</span><span class="r">CAGR</span><span class="r">Sharpe</span><span class="r">maxDD</span></div>`;
  $("#sleeve-table").innerHTML = sh + s.sleeves.map(x =>
    `<div class="trow sleeve-row"><span class="num">${x.name}</span><span class="r ${sgn(x.cagr)}">${pct(x.cagr)}</span><span class="r">${x.sharpe.toFixed(2)}</span><span class="r neg">${pct(x.max_dd)}</span></div>`).join("");
  $("#book-hint").textContent = "all-weather profile";
  // fidelity
  $("#fidelity").innerHTML = d.fidelity.map(f =>
    `<div class="fid"><span class="pill">${f.status}</span><span class="fname">${f.sleeve}</span><span class="fdet">${f.detail}</span></div>`).join("");
  // cash curve + per year
  lineChart($("#chart-cash"), d.harvest.curve);
  const pymax = Math.max(...d.harvest.per_year.map(p => Math.abs(p.cash)));
  $("#per-year").innerHTML = d.harvest.per_year.map(p => {
    const hgt = Math.max(2, Math.abs(p.cash) / pymax * 42);
    return `<div class="py"><div class="pybar"><span style="height:${hgt}px;background:${p.cash >= 0 ? "var(--pos)" : "var(--neg)"}"></span></div><div class="pylab">${p.year}</div><div class="pyval ${sgn(p.cash)}">${usd(p.cash)}</div></div>`;
  }).join("");
  // sweep
  scatter($("#chart-sweep"), d.sweep.scatter);
  const fh = `<div class="trow thead"><span>max DD</span><span class="r">ROI</span><span class="r">$back</span><span class="r">days</span></div>`;
  $("#frontier").innerHTML = fh + d.sweep.frontier.map(r => {
    const isRec = Math.abs(r.dd) <= 0.25 + 1e-6 && r.roi === d.strategy.headline.roi;
    return `<div class="trow ${isRec ? "rec rec-dot" : ""}"><span>≤ ${pct(r.ceil)}</span><span class="r">${fmtX(r.roi)}</span><span class="r">${usd(r.cash)}</span><span class="r">${r.days}d</span></div>`;
  }).join("");
  // live book
  const L = d.live;
  $("#book-asof").textContent = L.live ? "as of " + L.asof + " · m=" + L.leverage : "live fetch unavailable";
  if (L.live) {
    $("#harvest-state").innerHTML = [
      ["equity", usd(L.equity)], ["base", usd(L.base)], ["cash out", usd(L.cum_cash)],
      ["gross", pct(L.gross)], ["net", `<span class="${sgn(L.net)}">${L.net >= 0 ? "+" : ""}${pct(L.net)}</span>`],
      ["principal", L.principal_returned ? '<span class="pos">returned</span>' : "building"],
      ["state", L.locked ? '<span class="amber">LOCKED</span>' : '<span class="pos">active</span>'],
    ].map(([k, v]) => `<div class="stat"><div class="s-lab">${k}</div><div class="s-val">${v}</div></div>`).join("");
    const amax = Math.max(...L.rows.map(r => Math.abs(r.weight)));
    $("#live-book").innerHTML = L.rows.map(r => {
      const w = r.weight / amax * 50, pos = r.weight >= 0;
      const fill = pos ? `left:50%;width:${w}%;background:var(--pos)` : `right:50%;width:${-w}%;background:var(--neg)`;
      return `<div class="brow"><span class="bcoin">${r.coin}</span><div class="bbar"><span class="mid"></span><span class="fill" style="${fill}"></span></div><span class="bnot ${sgn(r.weight)}">${usd(r.notional)}</span></div>`;
    }).join("");
  } else {
    $("#harvest-state").innerHTML = `<div class="stat"><div class="s-lab">note</div><div class="s-val" style="font-size:11px">offline snapshot — run refresh with network</div></div>`;
    $("#live-book").innerHTML = "";
  }
  // market
  $("#mkt-asof").textContent = "as of " + d.market.asof;
  $("#market").innerHTML = d.market.coins.map(c =>
    `<div class="mcoin"><div class="mc">${c.coin}</div><div class="mp">${usd(c.price, false)}</div>
     <div class="mtr ${sgn(c.vs_sma50)}">50d ${c.vs_sma50 >= 0 ? "+" : ""}${pct(c.vs_sma50)}</div>
     <div class="mtr ${sgn(c.vs_sma200)}">200d ${c.vs_sma200 >= 0 ? "+" : ""}${pct(c.vs_sma200)}</div></div>`).join("");
  $("#gen").textContent = "generated " + (d.generated_at || "").replace("T", " ") + (s.window ? " · OOS " + s.window[0] + "→" + s.window[1] : "");
}

/* ---------- live worker controls ---------- */
function ctlMsg(text, kind) {
  const m = $("#ctl-msg"); if (!m) return;
  m.textContent = text; m.className = "ctl-msg" + (kind ? " " + kind : "");
}
function renderWorker(d) {
  const st = d.state || {}, caps = d.caps || {};
  const mode = st.mode || "paper", paused = !!st.paused, lev = st.leverage;
  $("#worker-hint").innerHTML = `worker connected · ${d.live_capable
    ? '<span class="amber">live-capable</span>' : '<span class="pos">paper-locked</span>'}`;
  $("#worker-state").innerHTML = [
    ["mode", `<span class="${mode === "live" ? "amber" : "pos"}">${mode.toUpperCase()}</span>`],
    ["state", paused ? '<span class="amber">PAUSED</span>' : '<span class="pos">ACTIVE</span>'],
    ["leverage", (lev == null ? "—" : lev + "×")],
    ["max lev", (caps.max_leverage ?? "—") + "×"],
    ["max gross", caps.max_gross == null ? "—" : (caps.max_gross * 100).toFixed(0) + "%"],
    ["daily stop", caps.daily_loss_limit == null ? "—" : "−" + (caps.daily_loss_limit * 100).toFixed(0) + "%"],
  ].map(([k, v]) => `<div class="stat"><div class="s-lab">${k}</div><div class="s-val">${v}</div></div>`).join("");
  const li = $("#lev-input");
  if (caps.max_leverage != null) li.max = caps.max_leverage;
  if (lev != null && document.activeElement !== li) li.value = lev;
}
async function loadWorker() {
  try {
    const r = await fetch("/api/worker?t=" + Date.now());
    if (!r.ok) { ctlMsg("worker unreachable (" + r.status + ")", "neg"); return; }
    renderWorker(await r.json());
  } catch (e) { ctlMsg("worker error: " + e, "neg"); }
}
async function sendCmd(action, params) {
  if (action === "flatten" && !confirm("Flatten the book and pause trading? This zeroes all positions.")) return;
  ctlMsg("sending " + action + "…");
  try {
    const r = await fetch("/api/cmd", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, params: params || {} }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { ctlMsg(j.error || ("failed (" + r.status + ")"), "neg"); return; }
    ctlMsg(j.result || "ok", "pos");
    loadWorker();
  } catch (e) { ctlMsg("error: " + e, "neg"); }
}
async function initControls() {
  let configured = false;
  try { configured = (await (await fetch("/api/status")).json()).worker; } catch (_) {}
  if (!configured) return;                       // no worker wired — hide controls
  $("#controls-card").hidden = false;
  document.querySelectorAll("[data-cmd]").forEach(b =>
    b.addEventListener("click", () => sendCmd(b.dataset.cmd)));
  $("#lev-set").addEventListener("click", () =>
    sendCmd("set_leverage", { m: parseFloat($("#lev-input").value) || 0 }));
  loadWorker();
}

/* ---------- load + refresh ---------- */
async function load() {
  const r = await fetch("/api/data?t=" + Date.now());
  return r.json();
}
async function init() {
  try {
    const d = await load();
    render(d);
    $("#app").hidden = false; $("#loader").hidden = true;
    window.__gen = d.generated_at;
    initControls();
  } catch (e) { $("#loader-msg").textContent = "failed to load: " + e; }
}
$("#refresh").addEventListener("click", async () => {
  const b = $("#refresh"); b.disabled = true; b.textContent = "↻ refreshing… (~2m)";
  try {
    await fetch("/api/refresh", { method: "POST" });
    const t0 = Date.now();
    const poll = setInterval(async () => {
      try {
        const d = await load();
        if (d.generated_at !== window.__gen) { clearInterval(poll); render(d); window.__gen = d.generated_at; b.disabled = false; b.textContent = "↻ Refresh"; }
        else if (Date.now() - t0 > 240000) { clearInterval(poll); b.disabled = false; b.textContent = "↻ Refresh"; }
      } catch (_) {}
    }, 5000);
  } catch (e) { b.disabled = false; b.textContent = "↻ Refresh"; }
});
init();
