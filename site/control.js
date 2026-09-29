// ---------------------------------------------------------------- control room (live replay) and payments
const CH = { cash: ["Cash", "var(--muted)"], qr_code: ["QR", "#60A5FA"], mobile_nfc: ["NFC", "#22D3EE"], rfid_card: ["RFID", "#C084FC"], contactless_card: ["Card", "#FFA94D"] };
const chChip = k => `<span class="chip-ch" style="--c:${CH[k] ? CH[k][1] : "var(--muted)"}">${CH[k] ? CH[k][0] : esc(k)}</span>`;
S.view = "control"; S.replay = null; S.playTimer = null; S.payFilter = { status: "all", channel: "all" };

function telIndex(ds) {
  if (ds._telIdx) return ds._telIdx; const n = ds.cfg.days * 24 * 4; const base = new Map();
  ds.T.telemetry.forEach((r, i) => { if (i % n === 0) base.set(r.machine_id, i); });
  const cap = {}; for (const s of ds.T.slots) cap[s.machine_id] = (cap[s.machine_id] || 0) + s.capacity;
  return (ds._telIdx = { n, base, cap });
}
function liveStatus(r, cap) {
  if (r.power_w === 0) return { key: "crit", label: "Offline", icon: ICON.bolt };
  if (r.temp_c > 8) return { key: "crit", label: "Cooling fault", icon: ICON.crit };
  if (r.door_open) return { key: "warn", label: "Door open", icon: ICON.warn };
  if (!r.card_reader_ok) return { key: "warn", label: "Cashless down", icon: ICON.warn };
  if (r.total_stock / cap < 0.35) return { key: "warn", label: "Stock low", icon: ICON.warn };
  return { key: "ok", label: "Online", icon: '<span class="pulse" aria-hidden="true"></span>' };
}
function upTo(arr, ts) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].ts <= ts) lo = m + 1; else hi = m; } return lo; }

function viewControl(el) {
  const ds = S.ds; const ix = telIndex(ds);
  if (S.replay == null || S.replay >= ix.n) { const ev = ds.events.find(e => !e.background); S.replay = ev ? Math.min(ix.n - 1, Math.round((ev.start_offset_h + Math.min(6, ev.duration_h / 2)) * 4)) : ix.n - 1; }
  el.innerHTML = kpis() + `<div class="panel-head"><div><h3>Control room</h3><p>Every deployment on one screen. Scrub or play through the simulated period to watch machines go offline, warm up and run low, and payments flow in.</p></div></div>
    <div class="replay"><button class="btn primary small" id="rpPlay" type="button" aria-label="Play replay">▶ Play</button>
      <input type="range" id="rpSlider" min="0" max="${ix.n - 1}" value="${S.replay}" aria-label="Replay time"><span class="rp-time" id="rpTime"></span>
      <button class="btn small" id="rpIncident" type="button">Next incident</button><button class="btn small" id="rpNow" type="button">End of period</button></div>
    <div class="control-grid"><div style="display:grid;gap:10px;min-width:0">
        <div class="panel-head"><div><h3 style="font-size:1rem">Live fleet</h3></div><div class="fleet-legend" id="liveLegend"></div></div>
        <div class="fleet" id="liveFleet" role="group" aria-label="Machines, select one to open its telemetry"></div>
        <h3 style="font-size:1rem">Deployments</h3><div id="deploy"></div></div>
      <div style="display:grid;gap:12px;align-content:start;min-width:0">
        <div class="feed"><div class="feed-h"><b>Alerts</b><span class="muted" id="alertCount"></span></div><div id="alerts"></div></div>
        <div class="feed"><div class="feed-h"><b>Transaction stream</b><span class="muted">latest first</span></div><div id="stream"></div></div></div></div>`;
  const m2 = Object.fromEntries(ds.T.machines.map(m => [m.machine_id, m])); const prod = Object.fromEntries(ds.T.products.map(p => [p.product_id, p]));
  const pay = new Map(ds.T.payments.filter(p => p.status === "approved").map(p => [p.txn_id, p]));
  const draw = () => {
    const s = S.replay; const t = ds.cfg.startMs + s * 15 * 60000; $("#rpTime").textContent = dt(t); $("#rpSlider").value = s;
    const live = ds.T.machines.map(m => { const r = ds.T.telemetry[ix.base.get(m.machine_id) + s]; return { m, r, st: liveStatus(r, ix.cap[m.machine_id]) }; });
    const ord = { crit: 0, warn: 1, ok: 2 }; live.sort((a, b) => ord[a.st.key] - ord[b.st.key] || a.m.machine_id - b.m.machine_id);
    const c = { ok: 0, warn: 0, crit: 0 }; live.forEach(x => c[x.st.key]++);
    $("#liveLegend").innerHTML = `<span class="st ok"><span class="pulse" aria-hidden="true"></span>${c.ok} online</span><span class="st warn">${ICON.warn}${c.warn} warnings</span><span class="st crit">${ICON.crit}${c.crit} critical</span>`;
    $("#liveFleet").innerHTML = live.map(({ m, r, st }) => `<button type="button" class="mtile ${st.key}" data-mid="${m.machine_id}" title="${esc(m.site_name)}">
      <span class="id">#${m.machine_id}${st.key === "ok" ? '<span class="pulse" aria-hidden="true"></span>' : `<span class="st ${st.key}" style="padding:2px 5px">${st.icon}</span>`}</span>
      <span class="where">${esc(VG.LOCATION_TYPES[m.location_type].label)} · ${esc(m.city)}</span><span class="st ${st.key}">${esc(st.label)}</span>
      <span class="reads"><span class="${r.temp_c > 8 ? "hot" : ""}">${r.temp_c.toFixed(1)} °C</span><span>${r.total_stock}/${ix.cap[m.machine_id]}</span><span>${Math.round(r.power_w)} W</span></span>
      <span class="fill"><i style="width:${Math.round(r.total_stock / ix.cap[m.machine_id] * 100)}%"></i></span></button>`).join("");
    $$("#liveFleet .mtile").forEach(b => b.onclick = () => { stopPlay(); S.machine = +b.dataset.mid; S.view = "tabular"; render(); document.querySelector(".ws").scrollIntoView({ behavior: "smooth", block: "start" }); });
    const nTx = upTo(ds.T.transactions, t); const done = ds.T.transactions.slice(0, nTx);
    const byRoute = {}; for (const x of live) (byRoute[x.m.route_id] ||= { on: 0, alerts: 0, n: 0 }).n++;
    for (const x of live) { const b = byRoute[x.m.route_id]; if (x.st.label !== "Offline") b.on++; if (x.st.key !== "ok") b.alerts++; }
    const sales = {}; for (const tx of done) { const rid = m2[tx.machine_id].route_id; (sales[rid] ||= { v: 0, amt: 0, cl: 0 }); sales[rid].v++; sales[rid].amt += tx.amount; if (tx.payment_method === "card") sales[rid].cl += tx.amount; }
    const rows = ds.T.routes.map(r => { const b = byRoute[r.route_id] || { on: 0, alerts: 0, n: 0 }, sv = sales[r.route_id] || { v: 0, amt: 0, cl: 0 };
      return { depot: ds.T.warehouses.find(w => w.warehouse_id === r.warehouse_id).name, route: r.route_id, machines: b.n, online: b.on, alerts: b.alerts, vends: sv.v, sales: sv.amt, cashless: sv.amt ? sv.cl / sv.amt : 0 }; });
    $("#deploy").innerHTML = table([{ k: "depot", txt: 1 }, { k: "route" }, { k: "machines", num: 1 }, { k: "online", num: 1, f: (v, r) => `${v}/${r.machines}` },
      { k: "alerts", num: 1, f: v => v ? `<span class="st ${v > 1 ? "crit" : "warn"}" style="padding:1px 8px">${v}</span>` : '<span class="muted">0</span>' },
      { k: "vends", label: "vends to date", num: 1, f: v => v.toLocaleString() }, { k: "sales", label: "sales to date", num: 1, f: v => esc(money(v)) }, { k: "cashless", label: "cashless", num: 1, f: v => Math.round(v * 100) + "%" }], rows, { h: 300 });
    const tk = ds.T.maintenance_tickets.filter(x => x.opened_at <= t).sort((a, b) => b.opened_at - a.opened_at);
    const open = tk.filter(x => x.closed_at > t);
    $("#alertCount").textContent = `${open.length} open · ${tk.length - open.length} resolved`;
    $("#alerts").innerHTML = tk.slice(0, 7).map(x => { const o = x.closed_at > t, sev = x.priority === "P1" ? "crit" : "warn";
      return `<div class="feed-row"><span class="st ${o ? sev : "ok"}" style="padding:2px 8px">${o ? (sev === "crit" ? ICON.crit : ICON.warn) : "✓"}${x.priority}</span><div><b>${esc(x.fault_type)}</b> · #${x.machine_id}<small>${o ? "open since" : "resolved"} ${dt(o ? x.opened_at : x.closed_at)}</small></div></div>`; }).join("") || '<p class="muted" style="font-size:.84rem;padding:6px 2px">No alerts yet at this point in time.</p>';
    $("#stream").innerHTML = done.slice(-8).reverse().map(tx => { const p = pay.get(tx.txn_id);
      return `<div class="feed-row">${chChip(tx.channel || "cash")}<div><b>${esc(prod[tx.product_id].name)}</b> · #${tx.machine_id}<small>${VG.fmtTime(tx.ts)} · ${tx.txn_id}${p ? " · auth " + p.auth_code : ""}</small></div><span class="amt">${esc(money(tx.amount))}</span></div>`; }).join("") || '<p class="muted" style="font-size:.84rem;padding:6px 2px">No vends yet.</p>';
  };
  const stopPlay = () => { if (S.playTimer) { clearInterval(S.playTimer); S.playTimer = null; const b = $("#rpPlay"); if (b) b.textContent = "▶ Play"; } };
  $("#rpSlider").oninput = e => { stopPlay(); S.replay = +e.target.value; draw(); };
  $("#rpPlay").onclick = () => { if (S.playTimer) return stopPlay(); if (S.replay >= ix.n - 1) S.replay = 0; $("#rpPlay").textContent = "❚❚ Pause";
    S.playTimer = setInterval(() => { if (!document.getElementById("rpSlider") || S.view !== "control") { clearInterval(S.playTimer); S.playTimer = null; return; }
      S.replay = Math.min(ix.n - 1, S.replay + 2); draw(); if (S.replay >= ix.n - 1) stopPlay(); }, 180); };
  $("#rpNow").onclick = () => { stopPlay(); S.replay = ix.n - 1; draw(); };
  $("#rpIncident").onclick = () => { stopPlay(); const t = ds.cfg.startMs + S.replay * 15 * 60000; const nx = ds.T.maintenance_tickets.filter(x => x.opened_at > t + 60000).sort((a, b) => a.opened_at - b.opened_at)[0];
    if (!nx) { toast("No more incidents after this point"); return; } S.replay = Math.min(ix.n - 1, Math.ceil((nx.opened_at - ds.cfg.startMs) / (15 * 60000)) + 2); draw(); };
  draw(); S.redraw = null;
}

function viewPayments(el) {
  const ds = S.ds, P = ds.T.payments; const ap = P.filter(p => p.status === "approved"), de = P.filter(p => p.status === "declined");
  const cardAmt = ap.reduce((a, p) => a + p.amount, 0), allAmt = ds.T.transactions.reduce((a, t) => a + t.amount, 0);
  const byCh = {}; for (const p of ap) { (byCh[p.channel] ||= { n: 0, amt: 0, lat: 0 }); byCh[p.channel].n++; byCh[p.channel].amt += p.amount; byCh[p.channel].lat += p.latency_ms; }
  const cash = ds.T.transactions.filter(t => t.payment_method === "cash"); const cashAmt = cash.reduce((a, t) => a + t.amount, 0);
  const reasons = {}; for (const p of de) reasons[p.decline_reason] = (reasons[p.decline_reason] || 0) + 1;
  const recon = ds.V.filter(c => /payment|settlement batch|cashless/.test(c.check));
  const maxAmt = Math.max(cashAmt, ...Object.values(byCh).map(v => v.amt));
  el.innerHTML = kpis() + `<div class="panel-head"><div><h3>Cashless payment logs</h3><p>Every QR code scan, NFC mobile wallet tap, RFID card read and contactless card payment, including declined attempts. Approved payments link one-to-one to vends and roll up into invoices and bank settlements.</p></div></div>
    <div class="groups"><div class="group"><span>Approval rate</span><b>${(ap.length / Math.max(1, P.length) * 100).toFixed(1)}%</b></div><div class="group"><span>Cashless share of sales</span><b>${Math.round(cardAmt / allAmt * 100)}%</b></div>
      <div class="group"><span>Approved payments</span><b>${ap.length.toLocaleString()}</b></div><div class="group"><span>Declined attempts</span><b style="color:var(--coral)">${de.length}</b></div>
      <div class="group"><span>Avg terminal latency</span><b>${Math.round(ap.reduce((a, p) => a + p.latency_ms, 0) / Math.max(1, ap.length))} ms</b></div></div>
    <div class="two"><div class="chart-box"><h4>Sales by payment channel</h4><div class="chbars">${["qr_code", "mobile_nfc", "rfid_card", "contactless_card"].map(k => { const v = byCh[k] || { n: 0, amt: 0 };
        return `<div class="chbar">${chChip(k)}<span class="lbl">${esc(VG.CHANNELS ? VG.CHANNELS[k].label : k)}</span><span class="track"><i style="width:${v.amt / maxAmt * 100}%;background:${CH[k][1]}"></i></span><span class="val">${esc(money(v.amt, true))}<small>${v.n.toLocaleString()}</small></span></div>`; }).join("")}
        <div class="chbar">${chChip("cash")}<span class="lbl">Cash</span><span class="track"><i style="width:${cashAmt / maxAmt * 100}%;background:var(--s4)"></i></span><span class="val">${esc(money(cashAmt, true))}<small>${cash.length.toLocaleString()}</small></span></div></div></div>
      <div style="display:grid;gap:10px;align-content:start"><div class="chart-box"><h4>Decline reasons</h4><div class="pills" style="padding:6px 0">${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="pill crit">${esc(k.replace(/_/g, " "))} · ${n}</span>`).join("") || '<span class="muted">none</span>'}</div>
          <p class="muted" style="font-size:.8rem">terminal_offline declines line up with card-reader faults and outages in telemetry.</p></div>
        <div class="checks-mini">${recon.map(c => `<div><span class="status ${c.status}">${c.status}</span><span>${esc(c.check)}</span><span class="muted">${esc(c.detail)}</span></div>`).join("")}</div></div></div>
    <div class="panel-head"><div><h3>Payment log</h3></div><div class="row-tools"><div class="seg" id="pySt">${["all", "approved", "declined"].map(v => `<button type="button" data-v="${v}" aria-pressed="${S.payFilter.status === v}">${v}</button>`).join("")}</div>
      <select id="pyCh" aria-label="Channel"><option value="all">All channels</option>${["qr_code", "mobile_nfc", "rfid_card", "contactless_card"].map(k => `<option value="${k}"${S.payFilter.channel === k ? " selected" : ""}>${CH[k][0]}</option>`).join("")}</select>
      ${dlBtn("pyDl", "Download CSV")}<button class="btn small" id="pyCp" type="button">Copy CSV</button></div></div><div id="pyRows"></div>`;
  const cols = ["payment_id", "ts", "machine_id", "txn_id", "channel", "provider", "token", "amount", "status", "decline_reason", "auth_code", "settlement_batch", "latency_ms"];
  const rows = () => P.filter(p => (S.payFilter.status === "all" || p.status === S.payFilter.status) && (S.payFilter.channel === "all" || p.channel === S.payFilter.channel));
  const draw = () => { const r = rows(); $$("#pySt button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === S.payFilter.status));
    $("#pyRows").innerHTML = table([{ k: "payment_id" }, { k: "ts", f: v => dt(v) }, { k: "machine_id", label: "machine" }, { k: "txn_id", f: v => v || '<span class="muted">—</span>' }, { k: "channel", f: v => chChip(v) }, { k: "provider", txt: 1 },
      { k: "token" }, { k: "amount", num: 1, f: v => esc(money(v)) }, { k: "status", f: v => `<span class="status ${v === "approved" ? "pass" : "fail"}">${v}</span>` }, { k: "decline_reason" }, { k: "auth_code" }, { k: "settlement_batch", label: "batch" }, { k: "latency_ms", label: "ms", num: 1 }], r, { limit: 250, hl: p => p.status === "declined" }); };
  $$("#pySt button").forEach(b => b.onclick = () => { S.payFilter.status = b.dataset.v; draw(); });
  $("#pyCh").onchange = e => { S.payFilter.channel = e.target.value; draw(); };
  on("pyDl", () => download("payments.csv", toCSV(cols, rows().map(isoOut)), "text/csv"));
  $("#pyCp").onclick = e => copyText(toCSV(cols, rows().slice(0, 2000).map(isoOut)), e.target);
  draw(); S.redraw = null;
}
