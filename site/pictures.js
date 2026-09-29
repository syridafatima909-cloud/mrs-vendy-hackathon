// ---------------------------------------------------------------- vending machine pictures (illustrated, one per model)
const VM_MODELS = {
  "ColdVend CV-24": { c1: "#34E3B6", c2: "#06B98B", dark: "#05795C", kind: "drinks", rows: 4, cols: 4, tag: "Drinks cooler", idle: 70, comp: 320, slots: 24, note: "Glass-front cooler for cans and bottles" },
  "ColdVend CV-30": { c1: "#7DB4FF", c2: "#2563EB", dark: "#1E40AF", kind: "drinks", rows: 5, cols: 5, tag: "High-capacity cooler", idle: 80, comp: 360, slots: 30, note: "Taller cabinet for busy metro and mall sites" },
  "ComboVend CB-24": { c1: "#FFB199", c2: "#FF6B6B", dark: "#C2363C", kind: "combo", rows: 4, cols: 4, tag: "Snacks and drinks combo", idle: 65, comp: 300, slots: 24, note: "Spiral snacks on top, chilled drinks below" },
};
const VM_ITEM = ["#FF6B6B", "#3B82F6", "#F59E0B", "#8B5CF6", "#10B981", "#EC4899", "#06B6D4", "#F97316"];
let vmSeq = 0;
function vmArt(model, cls = "") {
  const M = VM_MODELS[model] || VM_MODELS["ColdVend CV-24"]; const id = "vm" + (++vmSeq);
  const gx = 14, gy = 28, gw = 70, gh = 128, rowH = gh / M.rows, colW = gw / M.cols;
  let items = "";
  for (let r = 0; r < M.rows; r++) {
    const y = gy + r * rowH; items += `<rect x="${gx + 2}" y="${(y + rowH - 3).toFixed(1)}" width="${gw - 4}" height="2.4" rx="1.2" fill="#BFE6DA"/>`;
    for (let c = 0; c < M.cols; c++) {
      const x = gx + c * colW + colW * 0.18, w = colW * 0.64, top = y + rowH * 0.18, h = rowH * 0.68, col = VM_ITEM[(r * 3 + c * 5) % VM_ITEM.length];
      if (M.kind === "combo" && r < 2) items += `<path d="M${x.toFixed(1)} ${top.toFixed(1)}h${w.toFixed(1)}l${(-w * 0.12).toFixed(1)} ${h.toFixed(1)}h${(-w * 0.76).toFixed(1)}z" fill="${col}"/><rect x="${(x + w * 0.2).toFixed(1)}" y="${(top + h * 0.35).toFixed(1)}" width="${(w * 0.6).toFixed(1)}" height="${(h * 0.22).toFixed(1)}" rx="1" fill="#FFFFFF" opacity=".75"/>`;
      else if ((r + c) % 3 === 1) items += `<rect x="${(x + w * 0.2).toFixed(1)}" y="${(top - 1).toFixed(1)}" width="${(w * 0.6).toFixed(1)}" height="${(h + 1).toFixed(1)}" rx="${(w * 0.3).toFixed(1)}" fill="${col}"/><rect x="${(x + w * 0.2).toFixed(1)}" y="${(top + h * 0.4).toFixed(1)}" width="${(w * 0.6).toFixed(1)}" height="${(h * 0.2).toFixed(1)}" fill="#FFFFFF" opacity=".8"/>`;
      else items += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${col}"/><rect x="${x.toFixed(1)}" y="${(top + h * 0.38).toFixed(1)}" width="${w.toFixed(1)}" height="${(h * 0.22).toFixed(1)}" fill="#FFFFFF" opacity=".8"/>`;
    }
  }
  return `<svg class="vm-art ${cls}" viewBox="0 0 120 200" role="img" aria-label="${esc(model)} vending machine">
    <defs><linearGradient id="${id}b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${M.c1}"/><stop offset="1" stop-color="${M.c2}"/></linearGradient>
      <linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F4FFFB"/><stop offset="1" stop-color="#DDF3EE"/></linearGradient></defs>
    <ellipse cx="60" cy="195" rx="50" ry="4" fill="#0F172A" opacity=".12"/>
    <rect x="6" y="4" width="108" height="186" rx="12" fill="url(#${id}b)"/>
    <rect x="6" y="4" width="108" height="18" rx="9" fill="${M.dark}"/><text x="60" y="16.5" text-anchor="middle" font-family="Inter, sans-serif" font-weight="800" font-size="8.5" fill="#FFFFFF" letter-spacing=".6">${esc(model.split(" ")[0].toUpperCase())}</text>
    <rect x="${gx}" y="${gy}" width="${gw}" height="${gh}" rx="6" fill="url(#${id}g)"/>${items}
    <path d="M${gx + 6} ${gy + 6}l18 0-30 ${gh - 12}" fill="#FFFFFF" opacity=".35"/>
    <rect x="90" y="28" width="18" height="24" rx="4" fill="#0F172A" opacity=".85"/><rect x="93" y="32" width="12" height="7" rx="1.5" fill="#34E3B6"/><text x="99" y="48" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="5.5" fill="#34E3B6">4.1°</text>
    <g fill="#FFFFFF" opacity=".92">${[0, 1, 2].map(r => [0, 1].map(c => `<rect x="${92 + c * 8}" y="${60 + r * 8}" width="6" height="5.5" rx="1.5"/>`).join("")).join("")}</g>
    <rect x="91" y="88" width="16" height="3" rx="1.5" fill="${M.dark}"/>
    <rect x="90" y="98" width="18" height="12" rx="3" fill="#FFFFFF" opacity=".92"/><rect x="94" y="102" width="10" height="4" rx="1" fill="#EC4899"/>
    <rect x="92" y="116" width="14" height="14" rx="2" fill="#FFFFFF" opacity=".92"/><path d="M94 118h4v4h-4zM100 118h4v4h-4zM94 124h4v4h-4z" fill="#0F172A"/><rect x="101" y="125" width="2" height="2" fill="#0F172A"/>
    <rect x="14" y="164" width="92" height="18" rx="5" fill="${M.dark}" opacity=".85"/><rect x="20" y="168" width="80" height="10" rx="3" fill="#0F172A" opacity=".55"/>
    <rect x="12" y="190" width="10" height="5" rx="1.5" fill="${M.dark}"/><rect x="98" y="190" width="10" height="5" rx="1.5" fill="${M.dark}"/></svg>`;
}
function renderModels() {
  const el = document.getElementById("models"); if (!el || !S.ds) return;
  const count = {}; for (const m of S.ds.T.machines) count[m.model] = (count[m.model] || 0) + 1;
  el.innerHTML = Object.entries(VM_MODELS).map(([name, M]) => `<article class="model-card" style="--c1:${M.c1};--c2:${M.c2}">
      <div class="model-pic">${vmArt(name)}</div>
      <div class="model-body"><span class="model-tag">${esc(M.tag)}</span><h3>${esc(name)}</h3><p class="muted">${esc(M.note)}.</p>
        <div class="pills"><span class="pill">${M.slots} slots</span><span class="pill">${M.idle} W idle</span><span class="pill">${M.comp} W compressor</span><span class="pill ok">refrigerated</span></div>
        <p class="model-count"><b>${count[name] || 0}</b> in the current simulated fleet</p></div></article>`).join("");
}
const vmThumb = (model) => `<span class="vm-thumb" title="${esc(model)}">${vmArt(model)}</span>`;
