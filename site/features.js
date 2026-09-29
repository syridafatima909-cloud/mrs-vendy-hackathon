// ---------------------------------------------------------------- checkpoints and schema inspector
// A checkpoint stores the inputs (settings, prompt, event plan) and a fingerprint, not the rows.
// Generation is deterministic, so restoring regenerates the exact same tables and documents,
// and the fingerprint comparison proves it.
const CP_KEY = "mrsvendy.checkpoints.v1";
function cpLoad() { try { const v = JSON.parse(localStorage.getItem(CP_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
function cpStore() { try { localStorage.setItem(CP_KEY, JSON.stringify(S.cps)); return true; } catch (e) { return false; } }
S.cps = cpLoad(); S.cpDel = null; S.lastRestore = null; S.schemaSel = "transactions"; S.schemaCache = {};

function cpStats(ds) {
  const pass = ds.V.filter(c => c.status === "pass").length;
  return { machines: ds.T.machines.length, vends: ds.T.transactions.length, telemetry: ds.T.telemetry.length, tickets: ds.T.maintenance_tickets.length,
    docs: Object.values(ds.D).reduce((a, d) => a + d.length, 0), revenue: +ds.T.transactions.reduce((a, t) => a + t.amount, 0).toFixed(2), trust: Math.round(pass / ds.V.length * 100) };
}
function cpSave(name) {
  const ds = S.ds; const fp = VG.fingerprint(ds);
  const cp = { app: "mrs-vendy", version: 1, id: "cp_" + Date.now().toString(36), name: (name || "").trim() || `Checkpoint ${S.cps.length + 1}`, created: Date.now(),
    prompt: $("#prompt").value, plan: JSON.parse(JSON.stringify(S.plan)), cfg: JSON.parse(JSON.stringify(ds.cfg)), fp, stats: cpStats(ds) };
  S.cps.unshift(cp); const kept = cpStore();
  toast(kept ? `Saved “${cp.name}”` : `Saved “${cp.name}” for this visit. Export it to keep it after you close the page.`);
  return cp;
}
function applyCfg(c) {
  $("#region").value = c.region; ["nWh", "nRt", "nMc", "days"].forEach(k => { $("#" + k).value = c[k]; });
  $("#card").value = Math.round(c.cardShare * 100); $("#seed").value = c.seed; $("#bg").checked = !!c.background; $("#jitter").checked = !!c.privacy.jitter;
  $$("#pNames button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === c.privacy.names));
  $$("#pTokens button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === c.privacy.tokens));
  ["#nWh", "#nRt", "#nMc", "#days", "#card"].forEach(i => $(i).dispatchEvent(new Event("input")));
  regionHint();
}
function cpRestore(cp) {
  applyCfg(cp.cfg); $("#prompt").value = cp.prompt || ""; S.plan = JSON.parse(JSON.stringify(cp.plan || [])); S.notes = []; S.planFor = $("#prompt").value;
  renderPlan(); generate();
  const fp = VG.fingerprint(S.ds); S.lastRestore = { name: cp.name, ok: fp === cp.fp, fp, want: cp.fp };
  render(); toast(S.lastRestore.ok ? `Restored “${cp.name}”, identical to when it was saved` : `Restored “${cp.name}”, but the data differs from the saved fingerprint`);
}
function cpValid(o) { return o && o.app === "mrs-vendy" && o.cfg && VG.REGIONS[o.cfg.region] && Array.isArray(o.plan) && typeof o.fp === "string"; }

function viewCheckpoints(el) {
  const ds = S.ds; const cur = VG.fingerprint(ds); const reg = VG.REGIONS;
  const when = ms => { const d = new Date(ms); return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); };
  const lr = S.lastRestore;
  el.innerHTML = kpis() + `<div class="panel-head"><div><h3>Data checkpoints</h3><p>Save the current state of the tabular, relational and document data and reload it later. A checkpoint keeps the settings, the prompt and the event plan; restoring regenerates every table and document exactly, and the fingerprint proves it.</p></div></div>
    ${lr ? `<div class="trace" style="${lr.ok ? "" : "background:var(--crit-soft)"}"><b style="${lr.ok ? "" : "color:var(--crit)"}">${lr.ok ? "✓" : "✕"}</b><span>Restored <b>${esc(lr.name)}</b>. Fingerprint now <span class="mono">${lr.fp}</span>${lr.ok ? ", identical to the saved one." : `, saved one was <span class="mono">${esc(lr.want)}</span>.`}</span></div>` : ""}
    <div class="cp-now"><div><span class="eyebrow">Current data</span><p><b>${ds.T.machines.length} machines · ${ds.cfg.days} days · ${esc(reg[ds.cfg.region].name)} · seed ${ds.cfg.seed}</b></p>
      <p class="muted" style="font-size:.84rem">${ds.events.filter(e => !e.background).length} injected event(s) · ${ds.T.transactions.length.toLocaleString()} vends · fingerprint <span class="mono">${cur}</span></p></div>
      <form class="cp-form" id="cpForm"><label for="cpName" class="sr">Checkpoint name</label><input type="text" id="cpName" maxlength="60" placeholder="Name, e.g. Heatwave baseline"><button class="btn primary" type="submit">Save checkpoint</button></form></div>
    <div class="panel-head"><div><h3>Saved checkpoints <span class="muted" style="font-weight:400">${S.cps.length}</span></h3></div>
      <div class="row-tools"><label class="btn small" for="cpFile">Import .json</label><input type="file" id="cpFile" accept=".json,application/json" hidden>${S.cps.length ? `<button class="btn small" id="cpCopyAll" type="button">Copy all as JSON</button>` : ""}</div></div>
    <div class="cp-list">${S.cps.length ? S.cps.map(cp => { const same = cp.fp === cur; const s = cp.stats || {};
      return `<article class="cp${same ? " cur" : ""}"><div class="cp-top"><div><b>${esc(cp.name)}</b><span class="muted"> · ${when(cp.created)}</span></div>${same ? '<span class="pill ok">matches current data</span>' : ""}</div>
        <div class="cp-meta"><span>${esc(reg[cp.cfg.region]?.name || cp.cfg.region)} · ${cp.cfg.nWh}×${cp.cfg.nRt}×${cp.cfg.nMc} fleet · ${cp.cfg.days} days · seed ${cp.cfg.seed}</span>
          <span>${(cp.plan || []).length ? esc((cp.plan || []).map(e => ({ heatwave: "Heatwave", compressor_failure: "Compressor failure", power_outage: "Power outage", demand_spike: "Demand spike", restock_delay: "Restock delay", card_reader_failure: "Card reader failure", door_left_open: "Door left open" }[e.type] || e.type)).join(", ")) : "baseline, no injected events"}</span></div>
        <div class="pills"><span class="pill">${(s.vends || 0).toLocaleString()} vends</span><span class="pill">${(s.telemetry || 0).toLocaleString()} telemetry rows</span><span class="pill">${s.docs || 0} documents</span><span class="pill">${s.tickets || 0} tickets</span><span class="pill ok">trust ${s.trust ?? "–"}%</span><span class="pill mono">${esc(cp.fp)}</span></div>
        <div class="cp-actions"><button class="btn small primary" type="button" data-cp-restore="${cp.id}">Restore</button>${CAN_DL ? `<button class="btn small" type="button" data-cp-export="${cp.id}">Export .json</button>` : ""}<button class="btn small" type="button" data-cp-copy="${cp.id}">Copy JSON</button>
          <button class="btn small ${S.cpDel === cp.id ? "danger" : ""}" type="button" data-cp-del="${cp.id}">${S.cpDel === cp.id ? "Confirm delete" : "Delete"}</button></div></article>`; }).join("")
      : `<div class="cp-empty"><b>No checkpoints yet.</b><p class="muted">Save the current data above, or import a checkpoint file someone shared with you. Saved checkpoints stay in this browser.</p></div>`}</div>`;
  $("#cpForm").onsubmit = e => { e.preventDefault(); cpSave($("#cpName").value); S.lastRestore = null; render(); };
  const find = id => S.cps.find(c => c.id === id);
  $$("[data-cp-restore]", el).forEach(b => b.onclick = () => cpRestore(find(b.dataset.cpRestore)));
  $$("[data-cp-export]", el).forEach(b => b.onclick = () => { const cp = find(b.dataset.cpExport); download(`mrs_vendy_${cp.name.replace(/[^\w-]+/g, "_").toLowerCase()}.json`, JSON.stringify(cp, null, 2), "application/json"); });
  $$("[data-cp-copy]", el).forEach(b => b.onclick = e => copyText(JSON.stringify(find(b.dataset.cpCopy), null, 2), e.target));
  $$("[data-cp-del]", el).forEach(b => b.onclick = () => { const id = b.dataset.cpDel;
    if (S.cpDel === id) { S.cps = S.cps.filter(c => c.id !== id); S.cpDel = null; cpStore(); toast("Checkpoint deleted"); } else S.cpDel = id; render(); });
  const all = $("#cpCopyAll"); if (all) all.onclick = e => copyText(JSON.stringify(S.cps, null, 2), e.target);
  $("#cpFile").onchange = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader();
    r.onload = () => { try { let o = JSON.parse(String(r.result)); const list = (Array.isArray(o) ? o : [o]).filter(cpValid);
        if (!list.length) throw new Error("this file isn't a Mrs Vendy checkpoint");
        for (const cp of list) { cp.id = "cp_" + Math.random().toString(36).slice(2, 9); S.cps.unshift(cp); }
        cpStore(); toast(`Imported ${list.length} checkpoint${list.length > 1 ? "s" : ""}`); render(); }
      catch (err) { toast("Couldn't import: " + err.message); } };
    r.readAsText(f); };
  S.redraw = null;
}

// ---------------------------------------------------------------- schema inspector
const ORDER = ["warehouses", "routes", "machines", "products", "slots", "telemetry", "transactions", "restocks", "inventory", "maintenance_tickets"];
function schemaRows(name) {
  const T = S.ds.T;
  if (name !== "inventory") return T[name];
  return null; // inventory is stored compactly; its stats are computed straight from the snapshots
}
function columnStats(name) {
  const key = VG.fingerprint(S.ds) + "|" + name; if (S.schemaCache[key]) return S.schemaCache[key];
  const T = S.ds.T; const spec = VG.SCHEMA[name]; const out = {}; let n;
  const parentSet = (ref) => { const [t, c] = ref.split("."); return new Set(T[t].map(r => r[c])); };
  if (name === "inventory") {
    const slotSet = new Set(T.slots.map(s => s.slot_id)), mSet = new Set(T.machines.map(m => m.machine_id)); let min = Infinity, max = -Infinity, rows = 0, badFk = 0; const slotsSeen = new Set();
    for (const [mid, v] of T._inv) { const H = v.snap.length / v.nS; rows += v.snap.length; if (!mSet.has(mid)) badFk += v.snap.length;
      for (let j = 0; j < v.nS; j++) { slotsSeen.add(v.slotIds[j]); if (!slotSet.has(v.slotIds[j])) badFk += H; } for (const s of v.snap) { if (s < min) min = s; if (s > max) max = s; } }
    const recon = S.ds.V.find(c => c.check.startsWith("inventory reconciles"));
    n = rows;
    out.ts = { nulls: 0, distinct: S.ds.cfg.days * 24, range: `${VG.fmtDate(S.ds.cfg.startMs, S.ds.cfg.region)} → hourly`, ok: [["notnull", true]] };
    out.machine_id = { nulls: 0, distinct: T._inv.size, range: "", ok: [["fk", !badFk]] };
    out.slot_id = { nulls: 0, distinct: slotsSeen.size, range: "", ok: [["fk", !badFk]] };
    out.stock = { nulls: 0, distinct: max - min + 1, range: `${min} – ${max}`, ok: [["range", min >= 0 && max <= 15], ["rule", recon ? recon.status === "pass" : null]] };
    return (S.schemaCache[key] = { n, cols: out });
  }
  const rows = T[name]; n = rows.length;
  const prod = Object.fromEntries(T.products.map(p => [p.product_id, p])), slot = Object.fromEntries(T.slots.map(s => [s.slot_id, s]));
  const mById = Object.fromEntries(T.machines.map(m => [m.machine_id, m])), whCity = Object.fromEntries(T.warehouses.map(w => [w.warehouse_id, w.city])), rWh = Object.fromEntries(T.routes.map(r => [r.route_id, r.warehouse_id]));
  const t0 = S.ds.cfg.startMs, t1 = t0 + S.ds.cfg.days * VG.DAY;
  const RULES = {
    "machines.city": r => whCity[rWh[r.route_id]] === r.city, "machines.install_date": r => r.install_date < t0,
    "products.unit_price": r => r.unit_price > r.unit_cost, "slots.par_level": r => r.par_level <= r.capacity,
    "transactions.ts": r => r.ts >= t0 && r.ts < t1, "transactions.slot_id": r => slot[r.slot_id] && slot[r.slot_id].machine_id === r.machine_id,
    "transactions.product_id": r => slot[r.slot_id] && slot[r.slot_id].product_id === r.product_id, "transactions.unit_price": r => r.unit_price === prod[r.product_id].unit_price,
    "transactions.amount": r => Math.abs(r.amount - r.qty * r.unit_price) < 0.005, "transactions.card_token": r => (r.payment_method === "cash") === !r.card_token,
    "restocks.stock_after": r => r.stock_before + r.qty_added === r.stock_after, "maintenance_tickets.route_id": r => mById[r.machine_id].route_id === r.route_id,
    "maintenance_tickets.closed_at": r => r.closed_at > r.opened_at,
  };
  for (const [col, type, cons] of spec.cols) {
    const vals = rows.map(r => r[col]); const nulls = vals.filter(v => v === null || v === undefined || v === "").length;
    const distinct = new Set(vals).size; const ok = [];
    let range = "";
    if (type === "integer" || type === "float") { let lo = Infinity, hi = -Infinity; for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; } range = `${+lo.toFixed(2)} – ${+hi.toFixed(2)}`;
      for (const c of cons) if (c.startsWith("range:")) { const [, a, b] = c.split(":"); ok.push(["range", lo >= +a && hi <= +b]); } }
    else if (type === "datetime") { let lo = Infinity, hi = -Infinity; for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; } range = `${VG.fmtDate(lo, S.ds.cfg.region)} → ${VG.fmtDate(hi, S.ds.cfg.region)}`; }
    else if (type === "boolean") { const t = vals.filter(Boolean).length; range = `${t.toLocaleString()} true · ${(n - t).toLocaleString()} false`; }
    else { const freq = {}; for (const v of vals) if (v !== "") freq[v] = (freq[v] || 0) + 1; const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]; if (top && distinct < n) range = `top: ${top[0]} (${Math.round(top[1] / n * 100)}%)`; }
    for (const c of cons) {
      if (c === "pk") ok.push(["pk", distinct === n && !nulls]);
      else if (c === "notnull") ok.push(["notnull", !nulls]);
      else if (c.startsWith("fk:")) { const ps = parentSet(c.slice(3)); ok.push(["fk", vals.every(v => ps.has(v))]); }
      else if (c.startsWith("enum:")) { const list = c.slice(5) === "region cities" ? Object.keys(VG.REGIONS[S.ds.cfg.region].cities) : c.slice(5).split("|");
        ok.push(["enum", vals.every(v => list.includes(String(v)))]); }
      else if (c.startsWith("rule:")) { const f = RULES[name + "." + col]; ok.push(["rule", f ? rows.every(f) : null]); }
    }
    out[col] = { nulls, distinct, range, sample: vals.find(v => v !== "" && v !== null), ok };
  }
  return (S.schemaCache[key] = { n, cols: out });
}
function viewSchema(el) {
  const SC = VG.SCHEMA, sel = S.schemaSel, isDoc = !!VG.DOC_LINEAGE[sel];
  const refBy = {}; for (const [t, s] of Object.entries(SC)) for (const [col, , cons] of s.cols) for (const c of cons) if (c.startsWith("fk:")) { const p = c.slice(3).split(".")[0]; (refBy[p] ||= []).push(`${t}.${col}`); }
  const count = t => t === "inventory" ? [...S.ds.T._inv.values()].reduce((a, v) => a + v.snap.length, 0) : S.ds.T[t].length;
  const chip = (t, extra = "") => `<button type="button" class="dep" data-go="${t}">${esc(t)}${extra}</button>`;
  const DOCN = { invoice: "Sales invoices", purchase_order: "Purchase orders", service_ticket: "Service tickets", bank_statement: "Bank statement" };
  el.innerHTML = kpis() + `<div class="panel-head"><div><h3>Schema inspector</h3><p>Metadata, column types, constraints and dependencies for everything Mrs Vendy generates. Each constraint is checked against the current data as you look at it.</p></div></div>
    <div class="order" aria-label="Generation order">${ORDER.map((t, i) => `${i ? '<span aria-hidden="true">→</span>' : ""}<button type="button" data-go="${t}" aria-pressed="${t === sel}">${t === "maintenance_tickets" ? "tickets" : t}</button>`).join("")}<span aria-hidden="true">→</span><button type="button" data-go="invoice" aria-pressed="${isDoc}">documents</button></div>
    <div class="schema-grid"><nav class="schema-nav" aria-label="Tables and documents">
      ${["Relational", "Tabular"].map(layer => `<div class="cap">${layer}</div>` + Object.entries(SC).filter(([, s]) => s.layer === layer).map(([t]) => `<button type="button" data-go="${t}" aria-selected="${t === sel}">${t}<small>${count(t).toLocaleString()}</small></button>`).join("")).join("")}
      <div class="cap">Documents</div>${Object.keys(VG.DOC_LINEAGE).map(d => `<button type="button" data-go="${d}" aria-selected="${d === sel}">${DOCN[d]}<small>${S.ds.D[d].length}</small></button>`).join("")}
    </nav><div class="schema-body" id="schBody"></div></div>`;
  $$("[data-go]", el).forEach(b => b.onclick = () => { S.schemaSel = b.dataset.go; viewSchema(el); });
  const body = $("#schBody");
  if (isDoc) {
    const L = VG.DOC_LINEAGE[sel];
    body.innerHTML = `<div class="sch-head"><div><span class="eyebrow">Document</span><h3>${DOCN[sel]}</h3><p class="muted">${S.ds.D[sel].length} generated in this dataset.</p></div></div>
      <dl class="meta-grid"><div><dt>Built from</dt><dd>${L.from.map(t => VG.SCHEMA[t] ? chip(t) : `<span class="dep static">${esc(DOCN[t] || t)}</span>`).join(" ")}</dd></div><div><dt>Consistency checks</dt><dd>${S.ds.V.filter(c => c.group === "documents").length} in the Checks view, ${S.ds.V.filter(c => c.group === "documents" && c.status === "pass").length} passing</dd></div></dl>
      <h4 class="sub">Field lineage</h4>${table([{ k: 0, label: "field" }, { k: 1, label: "computed from", txt: 1 }], L.fields, { h: 300 })}`;
    $$("[data-go]", body).forEach(b => b.onclick = () => { S.schemaSel = b.dataset.go; viewSchema(el); });
    S.redraw = null; return;
  }
  const spec = SC[sel]; const st = columnStats(sel);
  const pk = spec.key || (spec.cols.find(c => c[2].includes("pk")) || [])[0];
  const parents = [...new Set(spec.cols.flatMap(c => c[2].filter(x => x.startsWith("fk:")).map(x => x.slice(3).split(".")[0])))];
  const children = [...new Set((refBy[sel] || []).map(x => x.split(".")[0]))];
  const docsUsing = Object.entries(VG.DOC_LINEAGE).filter(([, l]) => l.from.includes(sel)).map(([d]) => d);
  const allOk = Object.values(st.cols).flatMap(c => c.ok).filter(([, v]) => v !== null);
  const passN = allOk.filter(([, v]) => v).length;
  const badge = (c) => { if (c === "pk") return '<span class="cons pk">PK</span>'; if (c === "notnull") return '<span class="cons">NOT NULL</span>'; if (c === "nullable") return '<span class="cons soft">nullable</span>';
    if (c.startsWith("fk:")) return `<span class="cons fk">FK → ${esc(c.slice(3))}</span>`; if (c.startsWith("range:")) { const [, a, b] = c.split(":"); return `<span class="cons">${esc(a)} ≤ x ≤ ${esc(b)}</span>`; }
    if (c.startsWith("enum:")) return `<span class="cons" title="${esc(c.slice(5).replace(/\|/g, ", "))}">one of ${c.slice(5) === "region cities" ? "region cities" : c.slice(5).split("|").length + " values"}</span>`;
    if (c.startsWith("rule:")) return `<span class="cons rule">${esc(c.slice(5))}</span>`; return ""; };
  const verdict = ok => { const v = ok.filter(([, x]) => x !== null); if (!ok.length) return '<span class="muted">—</span>'; if (!v.length) return '<span class="muted">declared</span>';
    return v.every(([, x]) => x) ? `<span class="status pass">✓ ${v.length}</span>` : `<span class="status fail">✕ ${v.filter(([, x]) => !x).length}</span>`; };
  body.innerHTML = `<div class="sch-head"><div><span class="eyebrow">${spec.layer} table</span><h3 class="mono" style="font-size:1.1rem">${esc(sel)}</h3><p class="muted">${esc(spec.desc)}</p></div>
      <span class="status ${passN === allOk.length ? "pass" : "fail"}">${passN}/${allOk.length} constraints hold</span></div>
    <dl class="meta-grid"><div><dt>Rows</dt><dd>${st.n.toLocaleString()}</dd></div><div><dt>Grain</dt><dd>${esc(spec.grain)}</dd></div><div><dt>Key</dt><dd class="mono">${esc(pk)}</dd></div><div><dt>Generated by</dt><dd>${esc(spec.generatedBy)}</dd></div>
      <div><dt>References</dt><dd>${parents.length ? parents.map(t => chip(t)).join(" ") : '<span class="muted">none, a root table</span>'}</dd></div>
      <div><dt>Referenced by</dt><dd>${children.length ? children.map(t => chip(t)).join(" ") : '<span class="muted">none</span>'}</dd></div>
      <div><dt>Derived from</dt><dd>${spec.derivedFrom.length ? spec.derivedFrom.map(t => chip(t)).join(" ") : '<span class="muted">generated directly</span>'}</dd></div>
      <div><dt>Feeds documents</dt><dd>${docsUsing.length ? docsUsing.map(d => `<button type="button" class="dep" data-go="${d}">${DOCN[d]}</button>`).join(" ") : '<span class="muted">none</span>'}</dd></div></dl>
    <h4 class="sub">Columns</h4>
    ${table([{ k: "name", label: "column", f: v => `<b>${esc(v)}</b>` }, { k: "type", f: v => `<span class="type">${esc(v)}</span>` }, { k: "cons", label: "constraints", txt: 1, f: v => `<span class="cons-wrap">${v.map(badge).join("")}</span>` },
      { k: "check", label: "live check", f: (v, r) => verdict(r.ok) }, { k: "nulls", num: 1 }, { k: "distinct", num: 1 }, { k: "range", label: "range / values", txt: 1 }, { k: "desc", label: "description", txt: 1 }],
      spec.cols.map(([name, type, cons, desc]) => Object.assign({ name, type, cons, desc }, st.cols[name] || { nulls: "", distinct: "", range: "", ok: [] })), { h: 460 })}`;
  $$("[data-go]", body).forEach(b => b.onclick = () => { S.schemaSel = b.dataset.go; viewSchema(el); });
  S.redraw = null;
}
