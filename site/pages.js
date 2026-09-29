// ================================================================ multi-page shell: router, home, products, features, units, contact
const PAGES = ["home", "products", "features", "units", "contact", "generator"];
const LEGACY = { demo: "generator", fleet: "products", how: "features", top: "home" };
S.page = "home"; S.genCount = 0; S.u = { step: null, filter: "all", q: "", sort: "status", route: "all", timer: null }; S.bill = "monthly";

function stopTimers() {
  if (S.playTimer) { clearInterval(S.playTimer); S.playTimer = null; const b = document.getElementById("rpPlay"); if (b) b.textContent = "▶ Play"; }
  if (S.u.timer) { clearInterval(S.u.timer); S.u.timer = null; const b = document.getElementById("uPlay"); if (b) b.textContent = "▶ Play"; }
}
function showPage(name, opts = {}) {
  name = LEGACY[name] || name; if (!PAGES.includes(name)) name = "home";
  stopTimers(); S.page = name;
  $$(".page").forEach(p => { p.hidden = p.dataset.page !== name; });
  $$("[data-page-link]").forEach(a => { if (a.dataset.pageLink === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  document.body.dataset.page = name;
  try { if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name); } catch (e) { /* sandboxed viewers may refuse; the page still switches */ }
  closeMenu();
  if (!opts.keepScroll) window.scrollTo(0, 0);
  refreshPage();
}
function refreshPage() {
  if (!S.ds) return;
  if (S.page === "home") { S.heroDraw && S.heroDraw(); renderHomeStats(); }
  else if (S.page === "products") renderModels();
  else if (S.page === "features") renderFeatures();
  else if (S.page === "units") renderUnits();
  else if (S.page === "generator") render();
}
function goGenerator(view, focusPrompt) {
  if (view) S.view = view; showPage("generator");
  if (focusPrompt) setTimeout(() => { const p = document.getElementById("prompt"); p.scrollIntoView({ block: "center" }); p.focus(); p.select(); }, 60);
  else setTimeout(() => document.querySelector(".ws").scrollIntoView({ block: "start" }), 60);
}
function closeMenu() { const t = document.getElementById("navToggle"); if (t) { t.setAttribute("aria-expanded", "false"); document.getElementById("navLinks").classList.remove("open"); } }
function afterGenerate() { S.genCount++; S.u.step = null; if (S.page !== "generator") refreshPage(); }

// ---------------------------------------------------------------- home
function renderHomeStats() {
  const el = document.getElementById("homeStats"); if (!el || !S.ds) return;
  const ds = S.ds, ix = telIndex(ds), last = ix.n - 1;
  let online = 0; for (const m of ds.T.machines) { const r = ds.T.telemetry[ix.base.get(m.machine_id) + last]; if (liveStatus(r, ix.cap[m.machine_id]).key !== "crit") online++; }
  const priv = ds.V.filter(c => c.group === "privacy"), privPass = priv.filter(c => c.status === "pass").length, pass = ds.V.filter(c => c.status === "pass").length;
  const rev = ds.T.transactions.reduce((a, t) => a + t.amount, 0);
  const stats = [
    ["#3B82F6", "grid", "Active fleets", ds.T.warehouses.length, `${ds.T.warehouses.length} depots · ${ds.T.routes.length} delivery routes`],
    ["#06D6A0", "vend", "Units online now", `${online}/${ds.T.machines.length}`, "at the end of the simulated period"],
    ["#8B5CF6", "table", "Datasets generated", S.genCount, `this session · ${S.cps.length} checkpoint${S.cps.length === 1 ? "" : "s"} saved`],
    ["#10B981", "shield", "Privacy compliance", Math.round(privPass / priv.length * 100) + "%", `${privPass} of ${priv.length} privacy checks passing`],
    ["#F5B942", "coins", "Simulated sales", money(rev, true), `${ds.T.transactions.length.toLocaleString()} vends · ${ds.cfg.days} days`],
    ["#FF6B6B", "check", "Data trust score", Math.round(pass / ds.V.length * 100) + "%", `${pass} of ${ds.V.length} consistency checks`],
  ];
  el.innerHTML = stats.map(([c, ic, label, val, sub]) => `<div class="stat" style="--c:${c};--ic:var(--i-${ic})"><span class="stat-ic" aria-hidden="true"></span><span class="stat-label">${esc(label)}</span><b>${esc(String(val))}</b><small>${esc(sub)}</small></div>`).join("");
}

// ---------------------------------------------------------------- features
function renderFeatures() {
  const ds = S.ds; if (!ds) return;
  const chain = ["warehouses", "routes", "machines", "slots", "transactions", "payments"];
  const fkPass = ds.V.filter(c => c.group === "schema" && c.check.includes("→") && c.status === "pass").length;
  document.getElementById("fSchemaViz").innerHTML = `<div class="chain">${chain.map((t, i) => `${i ? '<span class="chain-arrow" aria-hidden="true">→</span>' : ""}<span class="chain-node"><b>${t}</b><small>${ds.T[t].length.toLocaleString()} rows</small></span>`).join("")}</div>
    <p class="viz-note"><span class="st ok">${ICON.warn.replace(/<path[^>]*>/g, "") && "✓"} ${fkPass} foreign keys verified</span> every row resolves to its parent</p>`;
  const fp = VG.fingerprint(ds);
  document.getElementById("fCpViz").innerHTML = `<div class="fp"><span class="fp-label">Current fingerprint</span><b class="mono">${fp}</b><span class="muted">seed ${ds.cfg.seed} · ${ds.cfg.days} days · ${ds.T.machines.length} units</span></div>
    <div class="fp-row"><span>${S.cps.length} checkpoint${S.cps.length === 1 ? "" : "s"} saved</span><button class="btn small primary" type="button" id="fCpSave">Save checkpoint now</button></div>`;
  document.getElementById("fCpSave").onclick = () => { cpSave(""); renderFeatures(); };
  const st = columnStats("transactions"); const spec = VG.SCHEMA.transactions.cols.slice(0, 7);
  const fmtC = c => c === "pk" ? '<span class="cons pk">PK</span>' : c === "notnull" ? '<span class="cons">NOT NULL</span>' : c.startsWith("fk:") ? `<span class="cons fk">FK → ${esc(c.slice(3))}</span>` : c.startsWith("rule:") ? '<span class="cons rule">rule</span>' : c.startsWith("enum:") ? '<span class="cons">enum</span>' : c.startsWith("range:") ? '<span class="cons">range</span>' : "";
  document.getElementById("fMetaViz").innerHTML = `<div class="table-wrap" style="max-height:none"><table class="data"><thead><tr><th>column</th><th>type</th><th>constraints</th><th>live</th></tr></thead><tbody>${spec.map(([n, t, cons]) => {
    const ok = (st.cols[n] || { ok: [] }).ok.filter(([, v]) => v !== null); const good = ok.every(([, v]) => v);
    return `<tr><td><b>${n}</b></td><td><span class="type">${t}</span></td><td class="txt"><span class="cons-wrap">${cons.map(fmtC).join("")}</span></td><td>${ok.length ? `<span class="status ${good ? "pass" : "fail"}">${good ? "✓" : "✕"} ${ok.length}</span>` : '<span class="muted">—</span>'}</td></tr>`; }).join("")}</tbody></table></div>`;
  const fp2 = document.getElementById("fPrompt"); if (!fp2.value) fp2.value = VG.EXAMPLES[0];
  featParse();
}
function featParse() {
  const c = cfg(); const r = VG.parseIntent(document.getElementById("fPrompt").value, c);
  document.getElementById("fParsed").innerHTML = r.events.length ? r.events.map(ev => { const d = describe(ev, c); return `<span class="ev"><b>${esc(d.what)}</b> ${esc(d.where)} <span>${esc(d.when)}</span></span>`; }).join("")
    : `<span class="note">${esc(r.notes[0] || "No edge case recognised.")}</span>`;
}

// ---------------------------------------------------------------- vending card management
function unitDefaultStep(ds, n) { const ev = ds.events.find(e => !e.background); return ev ? Math.min(n - 1, Math.round((ev.start_offset_h + Math.min(6, ev.duration_h / 2)) * 4)) : n - 1; }
function unitData(ds) {
  if (ds._unitIdx) return ds._unitIdx;
  const txBy = new Map(); for (const t of ds.T.transactions) { if (!txBy.has(t.machine_id)) txBy.set(t.machine_id, []); txBy.get(t.machine_id).push(t); }
  const par = Object.fromEntries(ds.T.slots.map(s => [s.slot_id, s.par_level])); const tk = {}; for (const t of ds.T.maintenance_tickets) (tk[t.machine_id] ||= []).push(t);
  return (ds._unitIdx = { txBy, par, tk });
}
const U_STATUS = { ok: ["ok", "Online"], low: ["low", "Low stock"], warn: ["warn", "Warning"], crit: ["crit", "Critical"], off: ["off", "Offline"] };
function unitStatus(r, cap) {
  if (r.power_w === 0) return { k: "off", label: "Offline", why: "No power" };
  if (r.temp_c > 8) return { k: "crit", label: "Critical", why: "Cooling failure" };
  if (r.door_open) return { k: "warn", label: "Warning", why: "Door open" };
  if (!r.card_reader_ok) return { k: "warn", label: "Warning", why: "Cashless reader down" };
  if (r.total_stock / cap < 0.35) return { k: "low", label: "Low stock", why: "Below 35% stocked" };
  return { k: "ok", label: "Online", why: "All systems normal" };
}
function sparkline(vals, cls) {
  const w = 110, h = 30, lo = Math.min(2, ...vals), hi = Math.max(10, ...vals); const X = i => (i / Math.max(1, vals.length - 1)) * w, Y = v => h - 2 - (v - lo) / (hi - lo) * (h - 4);
  const d = vals.map((v, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1)).join("");
  return `<svg class="spark ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="${w}" y1="${Y(8).toFixed(1)}" y2="${Y(8).toFixed(1)}" class="spark-lim"/><path d="${d}"/><circle cx="${X(vals.length - 1).toFixed(1)}" cy="${Y(vals[vals.length - 1]).toFixed(1)}" r="2.6"/></svg>`;
}
function renderUnits() {
  const ds = S.ds; if (!ds) return; const ix = telIndex(ds), U = unitData(ds);
  if (S.u.step == null || S.u.step >= ix.n) S.u.step = unitDefaultStep(ds, ix.n);
  const s = S.u.step, t = ds.cfg.startMs + s * 15 * 60000, day0 = t - (t - ds.cfg.startMs) % VG.DAY, hour = Math.min(ds.cfg.days * 24 - 1, Math.floor(s / 4));
  const rSel = document.getElementById("uRoute");
  if (rSel.dataset.for !== VG.fingerprint(ds)) { rSel.innerHTML = `<option value="all">All routes</option>` + ds.T.routes.map(r => `<option value="${r.route_id}">${r.route_id} · ${esc(r.route_name)}</option>`).join(""); rSel.dataset.for = VG.fingerprint(ds); if (![...rSel.options].some(o => o.value === S.u.route)) S.u.route = "all"; rSel.value = S.u.route; }
  const slider = document.getElementById("uTime"); slider.max = ix.n - 1; slider.value = s; document.getElementById("uClock").textContent = dt(t);
  const units = ds.T.machines.map(m => {
    const r = ds.T.telemetry[ix.base.get(m.machine_id) + s], st = unitStatus(r, ix.cap[m.machine_id]);
    const hist = []; for (let k = Math.max(0, s - 95); k <= s; k++) hist.push(ds.T.telemetry[ix.base.get(m.machine_id) + k].temp_c);
    const tx = U.txBy.get(m.machine_id) || []; let vends = 0, sales = 0; for (const x of tx) { if (x.ts > t) break; if (x.ts >= day0) { vends++; sales += x.amount; } }
    const inv = ds.T._inv.get(m.machine_id); let low = 0; for (let j = 0; j < inv.nS; j++) if (inv.snap[hour * inv.nS + j] <= U.par[inv.slotIds[j]]) low++;
    const open = (U.tk[m.machine_id] || []).filter(k => k.opened_at <= t && k.closed_at > t);
    return { m, r, st, hist, vends, sales, low, slots: inv.nS, open, tickets: (U.tk[m.machine_id] || []).length };
  });
  const counts = { all: units.length, ok: 0, low: 0, warn: 0, crit: 0, off: 0 }; units.forEach(u => counts[u.st.k]++);
  document.getElementById("uSummary").innerHTML = [["all", "All units"], ["ok", "Online"], ["low", "Low stock"], ["warn", "Warning"], ["crit", "Critical"], ["off", "Offline"]].map(([k, l]) =>
    `<button type="button" class="u-filter ${k}" data-f="${k}" aria-pressed="${S.u.filter === k}"><span class="dot" aria-hidden="true"></span>${l}<b>${counts[k]}</b></button>`).join("");
  $$("#uSummary .u-filter").forEach(b => b.onclick = () => { S.u.filter = b.dataset.f; renderUnits(); });
  const q = S.u.q.trim().toLowerCase(); const ord = { crit: 0, off: 1, warn: 2, low: 3, ok: 4 };
  let list = units.filter(u => (S.u.filter === "all" || u.st.k === S.u.filter) && (S.u.route === "all" || u.m.route_id === S.u.route)
    && (!q || ("unit #" + u.m.machine_id + " " + u.m.site_name + " " + u.m.city + " " + u.m.model + " " + u.m.route_id).toLowerCase().includes(q)));
  const sorters = { status: (a, b) => ord[a.st.k] - ord[b.st.k] || a.m.machine_id - b.m.machine_id, id: (a, b) => a.m.machine_id - b.m.machine_id,
    stock: (a, b) => a.r.total_stock / ix.cap[a.m.machine_id] - b.r.total_stock / ix.cap[b.m.machine_id], temp: (a, b) => b.r.temp_c - a.r.temp_c, sales: (a, b) => b.sales - a.sales };
  list.sort(sorters[S.u.sort]);
  const grid = document.getElementById("uGrid");
  grid.innerHTML = list.length ? list.map(u => { const m = u.m, cap = ix.cap[m.machine_id], pct = Math.round(u.r.total_stock / cap * 100);
    return `<article class="unit ${u.st.k}"><header class="unit-h"><span class="unit-pic">${vmArt(m.model)}</span><div class="unit-id"><h3>Unit #${m.machine_id}</h3><p>${esc(m.site_name)}</p><p class="muted">${esc(m.route_id)} · ${esc(m.model)}</p></div>
        <span class="u-badge ${u.st.k}" title="${esc(u.st.why)}"><span class="dot" aria-hidden="true"></span>${u.st.label}</span></header>
      <p class="unit-why ${u.st.k}">${esc(u.st.why)}${u.open.length ? ` · ticket ${u.open[0].ticket_id} open` : ""}</p>
      <div class="unit-reads"><div><span>Cabinet</span><b class="${u.r.temp_c > 8 ? "hot" : ""}">${u.r.temp_c.toFixed(1)} °C</b>${sparkline(u.hist, u.st.k)}</div>
        <div><span>Power</span><b>${Math.round(u.r.power_w)} W</b><small>compressor ${Math.round(u.r.compressor_on_pct)}% · ${u.r.compressor_cycles} starts</small></div>
        <div><span>Stock</span><b>${u.r.total_stock}<small> / ${cap}</small></b><span class="u-bar"><i style="width:${pct}%"></i></span><small>${u.low} of ${u.slots} slots at reorder level</small></div>
        <div><span>Sales today</span><b>${esc(money(u.sales))}</b><small>${u.vends} vends</small></div></div>
      <div class="unit-flags"><span class="${u.r.door_open ? "bad" : "good"}">Door ${u.r.door_open ? "open" : "closed"}</span><span class="${u.r.card_reader_ok ? "good" : "bad"}">Cashless ${u.r.card_reader_ok ? "ready" : "down"}</span><span>Ambient ${u.r.ambient_c.toFixed(1)} °C</span></div>
      <div class="unit-actions"><button class="btn small" type="button" data-u-tel="${m.machine_id}">Telemetry</button>
        <label class="sr" for="uf${m.machine_id}">Simulate a fault on unit ${m.machine_id}</label><select id="uf${m.machine_id}" data-u-fault="${m.machine_id}"><option value="">Simulate fault…</option><option value="compressor_failure">Compressor failure</option><option value="power_outage">Power cut</option><option value="door_left_open">Door left open</option><option value="card_reader_failure">Card reader down</option><option value="demand_spike">Demand spike ×3</option><option value="restock_delay">Skip restocks</option></select>
        ${u.tickets ? `<button class="btn small" type="button" data-u-tk="${m.machine_id}">Tickets ${u.tickets}</button>` : ""}</div></article>`; }).join("")
    : `<div class="cp-empty"><b>No units match.</b><p class="muted">Clear the search or pick another status filter.</p></div>`;
  $$("[data-u-tel]", grid).forEach(b => b.onclick = () => { S.machine = +b.dataset.uTel; goGenerator("tabular"); });
  $$("[data-u-tk]", grid).forEach(b => b.onclick = () => { S.docType = "service_ticket"; const i = S.ds.D.service_ticket.findIndex(d => d.machine_id === +b.dataset.uTk); S.docIdx = Math.max(0, i); goGenerator("documents"); });
  $$("[data-u-fault]", grid).forEach(sel => sel.onchange = () => { if (sel.value) injectUnitFault(+sel.dataset.uFault, sel.value); });
  document.getElementById("uFoot").textContent = `${list.length} of ${units.length} units shown · readings at ${dt(t)} · faults you simulate are added to the scenario plan and regenerate the whole dataset`;
}
function injectUnitFault(mid, type) {
  const ds = S.ds, ix = telIndex(ds); const dur = { compressor_failure: 20, power_outage: 6, door_left_open: 3, card_reader_failure: 12, demand_spike: 12, restock_delay: 72 }[type];
  const lastH = ds.cfg.days * 24; let start = S.u.step / 4; if (start > lastH - 6) start = Math.max(0, lastH - 12);
  const ev = { type, targets: { machine_ids: [mid], cities: [], location_types: [], route_ids: [] }, start_offset_h: +start.toFixed(2), duration_h: dur, params: type === "demand_spike" ? { multiplier: 3, categories: [] } : {} };
  S.plan.push(ev); S.planFor = $("#prompt").value; renderPlan();
  const keep = Math.min(ix.n - 1, Math.round((start + ({ compressor_failure: 5, power_outage: 1, door_left_open: 1.5, card_reader_failure: 1, demand_spike: 2, restock_delay: 24 }[type])) * 4));
  generate(); S.u.step = keep; S.u.filter = "all"; renderUnits();
  toast(`${({ compressor_failure: "Compressor failure", power_outage: "Power cut", door_left_open: "Door left open", card_reader_failure: "Card reader failure", demand_spike: "Demand spike", restock_delay: "Restock delay" })[type]} injected on unit #${mid}; dataset regenerated`);
}

// ---------------------------------------------------------------- contact
function contactInit() {
  const f = document.getElementById("contactForm"), done = document.getElementById("contactDone"), err = document.getElementById("ctErr");
  f.addEventListener("submit", e => {
    e.preventDefault(); const v = id => document.getElementById(id).value.trim(); const bad = [];
    $$(".field-err", f).forEach(x => x.textContent = ""); $$("[aria-invalid]", f).forEach(x => x.removeAttribute("aria-invalid"));
    const flag = (id, msg) => { const el = document.getElementById(id); el.setAttribute("aria-invalid", "true"); document.getElementById(id + "Err").textContent = msg; bad.push(el); };
    if (!v("ctName")) flag("ctName", "Enter your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v("ctEmail"))) flag("ctEmail", "Enter a valid email address, like name@company.com.");
    if (v("ctMsg").length < 10) flag("ctMsg", "Tell us a little more, at least 10 characters.");
    if (!document.getElementById("ctOk").checked) flag("ctOk", "Tick this box so we can reply to you.");
    if (bad.length) { err.textContent = `Please fix ${bad.length} field${bad.length > 1 ? "s" : ""} before sending.`; bad[0].focus(); return; }
    err.textContent = ""; const ref = "MV-" + Math.random().toString(36).slice(2, 7).toUpperCase(); const topic = document.getElementById("ctTopic");
    document.getElementById("ctDoneText").innerHTML = `Your <b>${esc(topic.options[topic.selectedIndex].text.toLowerCase())}</b> request is logged with reference <b class="mono">${ref}</b>. This is a demo site, so no email was actually sent. In the live product our team would reply to <b>${esc(v("ctEmail"))}</b> within one business day.`;
    document.getElementById("ctDoneName").textContent = `Thanks, ${v("ctName").split(" ")[0]}.`;
    f.hidden = true; done.hidden = false; done.focus();
  });
  document.getElementById("ctAgain").onclick = () => { f.reset(); done.hidden = true; f.hidden = false; document.getElementById("ctName").focus(); };
}

// ---------------------------------------------------------------- wiring
function pagesInit() {
  document.addEventListener("click", e => {
    const a = e.target.closest("[data-page-link]");
    if (a) { e.preventDefault(); showPage(a.dataset.pageLink); return; }
    const g = e.target.closest("[data-go]");
    if (g) { e.preventDefault(); if (g.dataset.topic) { document.getElementById("ctTopic").value = g.dataset.topic; }
      if (g.dataset.go === "generator") goGenerator(g.dataset.view, g.dataset.focus === "prompt"); else showPage(g.dataset.go); }
  });
  const t = document.getElementById("navToggle"); t.onclick = () => { const open = t.getAttribute("aria-expanded") !== "true"; t.setAttribute("aria-expanded", String(open)); document.getElementById("navLinks").classList.toggle("open", open); };
  window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (h && (LEGACY[h] || h) !== S.page) showPage(h); });
  // pricing
  const price = () => { $$("[data-price]").forEach(el => { const [m, y] = el.dataset.price.split("|"); el.textContent = S.bill === "yearly" ? y : m; });
    $$("#billSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === S.bill)); $$(".per").forEach(el => el.textContent = S.bill === "yearly" ? "per month, billed yearly" : "per month"); };
  $$("#billSeg button").forEach(b => b.onclick = () => { S.bill = b.dataset.v; price(); }); price();
  // features
  document.getElementById("fParseBtn").onclick = featParse;
  document.getElementById("fPrompt").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); featParse(); } });
  document.getElementById("fRun").onclick = () => { $("#prompt").value = document.getElementById("fPrompt").value; interpret(); generate(); goGenerator("control"); };
  $$("#fExamples button").forEach(b => b.onclick = () => { document.getElementById("fPrompt").value = VG.EXAMPLES[+b.dataset.ex]; featParse(); });
  // units
  document.getElementById("uSearch").addEventListener("input", e => { S.u.q = e.target.value; renderUnits(); });
  document.getElementById("uSort").onchange = e => { S.u.sort = e.target.value; renderUnits(); };
  document.getElementById("uRoute").onchange = e => { S.u.route = e.target.value; renderUnits(); };
  document.getElementById("uTime").addEventListener("input", e => { if (S.u.timer) { clearInterval(S.u.timer); S.u.timer = null; document.getElementById("uPlay").textContent = "▶ Play"; } S.u.step = +e.target.value; renderUnits(); });
  document.getElementById("uPlay").onclick = () => { const b = document.getElementById("uPlay"); if (S.u.timer) { clearInterval(S.u.timer); S.u.timer = null; b.textContent = "▶ Play"; return; }
    const n = telIndex(S.ds).n; if (S.u.step >= n - 1) S.u.step = 0; b.textContent = "❚❚ Pause";
    S.u.timer = setInterval(() => { if (S.page !== "units") return stopTimers(); S.u.step = Math.min(n - 1, S.u.step + 2); renderUnits(); if (S.u.step >= n - 1) stopTimers(); }, 320); };
  document.getElementById("uNow").onclick = () => { stopTimers(); S.u.step = telIndex(S.ds).n - 1; renderUnits(); };
  contactInit();
  const h = location.hash.slice(1); showPage(h || "home", { keepScroll: true });
}
