/* Mrs Vendy browser engine — pure JS, no DOM. Mirrors the Python engine in the repo. */
(function (root) {
"use strict";

// ---------------------------------------------------------------- RNG
function rngFactory(seed) {
  let a = (seed >>> 0) || 1;
  const next = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let spare = null;
  const r = {
    next,
    uni: (a, b) => a + (b - a) * next(),
    int: (a, b) => Math.floor(a + (b - a) * next()),            // [a, b)
    normal: (mu = 0, sd = 1) => {
      if (spare !== null) { const s = spare; spare = null; return mu + sd * s; }
      let u = 0, v = 0; while (u === 0) u = next(); v = next();
      const m = Math.sqrt(-2 * Math.log(u)); spare = m * Math.sin(2 * Math.PI * v);
      return mu + sd * m * Math.cos(2 * Math.PI * v);
    },
    poisson: (lam) => {
      if (lam <= 0) return 0;
      if (lam > 30) return Math.max(0, Math.round(r.normal(lam, Math.sqrt(lam))));
      const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= next(); } while (p > L); return k - 1;
    },
    pickW: (w, total) => { let x = next() * (total ?? w.reduce((s, v) => s + v, 0));
      for (let i = 0; i < w.length; i++) { x -= w[i]; if (x < 0) return i; } return w.length - 1; },
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    hex: (n) => { let s = ""; for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(next() * 16)]; return s; },
    shuffle: (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; },
  };
  return r;
}

// ---------------------------------------------------------------- Reference data
const REGIONS = {
  PK: { name: "Pakistan", currency: "PKR", fx: 1, round: 10, dec: 0, tax: { label: "Sales tax", rate: 0.18 }, dateFmt: "dmy", sep: "/",
        cities: { Islamabad: [33.6844, 73.0479, 31, 7], Rawalpindi: [33.5651, 73.0169, 32, 7], Lahore: [31.5204, 74.3587, 34, 6.5],
                  Karachi: [24.8607, 67.0011, 31.5, 4.5], Peshawar: [34.0151, 71.5249, 33.5, 7.5], Multan: [30.1575, 71.5249, 36, 7] },
        fuel: 4500, callout: { P1: 9000, P2: 6000, P3: 3500 }, opening: 2500000 },
  US: { name: "United States", currency: "USD", fx: 1 / 280, round: 0.25, dec: 2, tax: { label: "Sales tax", rate: 0.0825 }, dateFmt: "mdy", sep: "/",
        cities: { Houston: [29.7604, -95.3698, 29, 5], Dallas: [32.7767, -96.797, 30, 6], Austin: [30.2672, -97.7431, 30, 6.5],
                  "San Antonio": [29.4241, -98.4936, 30, 6], "El Paso": [31.7619, -106.485, 29, 8], Phoenix: [33.4484, -112.074, 34, 7] },
        fuel: 38, callout: { P1: 180, P2: 120, P3: 75 }, opening: 12000 },
  UK: { name: "United Kingdom", currency: "GBP", fx: 1 / 355, round: 0.05, dec: 2, tax: { label: "VAT", rate: 0.20 }, dateFmt: "dmy", sep: "/",
        cities: { London: [51.5072, -0.1276, 19, 5], Manchester: [53.4808, -2.2426, 17, 4.5], Birmingham: [52.4862, -1.8904, 18, 5],
                  Leeds: [53.8008, -1.5491, 17, 4.5], Bristol: [51.4545, -2.5879, 18, 5], Glasgow: [55.8642, -4.2518, 16, 4] },
        fuel: 30, callout: { P1: 150, P2: 95, P3: 60 }, opening: 9000 },
  DE: { name: "Germany", currency: "EUR", fx: 1 / 305, round: 0.1, dec: 2, tax: { label: "MwSt.", rate: 0.19 }, dateFmt: "dmy", sep: ".",
        cities: { Berlin: [52.52, 13.405, 20, 5.5], Munich: [48.1351, 11.582, 20, 6], Hamburg: [53.5511, 9.9937, 18, 4.5],
                  Frankfurt: [50.1109, 8.6821, 21, 6], Cologne: [50.9375, 6.9603, 20, 5.5], Stuttgart: [48.7758, 9.1829, 21, 6] },
        fuel: 34, callout: { P1: 165, P2: 110, P3: 70 }, opening: 10500 },
};

const LOCATION_TYPES = {
  university: { rate: 2.0, peaks: [10, 13, 16], open: [7, 22], indoor: true, label: "University" },
  hospital: { rate: 1.6, peaks: [9, 14, 20], open: [0, 24], indoor: true, label: "Hospital" },
  office: { rate: 1.4, peaks: [9, 13, 17], open: [7, 21], indoor: true, label: "Office" },
  mall: { rate: 2.2, peaks: [15, 19, 21], open: [10, 23], indoor: true, label: "Mall" },
  metro_station: { rate: 2.6, peaks: [8, 13, 18], open: [5, 24], indoor: false, label: "Metro station" },
  petrol_station: { rate: 1.2, peaks: [8, 14, 22], open: [0, 24], indoor: false, label: "Petrol station" },
};
const LOC_P = [0.22, 0.14, 0.2, 0.16, 0.16, 0.12];

const MODELS = { "ColdVend CV-24": [70, 320, 24], "ColdVend CV-30": [80, 360, 30], "ComboVend CB-24": [65, 300, 24] };

// sku, name, category, cost (PKR), price (PKR), chilled, popularity
const PRODUCTS = [
  ["BEV-001", "Mineral Water 500ml", "beverage", 45, 80, 1, 1.6], ["BEV-002", "Mineral Water 1.5L", "beverage", 75, 130, 1, 0.8],
  ["BEV-003", "Cola 345ml Can", "beverage", 85, 150, 1, 1.5], ["BEV-004", "Lemon Lime 345ml Can", "beverage", 85, 150, 1, 1.0],
  ["BEV-005", "Orange Soda 345ml Can", "beverage", 85, 150, 1, 0.8], ["BEV-006", "Iced Tea Peach 330ml", "beverage", 90, 160, 1, 0.9],
  ["BEV-007", "Energy Drink 250ml", "beverage", 180, 300, 1, 1.1], ["BEV-008", "Mango Juice 200ml", "beverage", 55, 100, 1, 1.2],
  ["BEV-009", "Apple Juice 200ml", "beverage", 55, 100, 1, 0.7], ["BEV-010", "Sports Drink 500ml", "beverage", 120, 210, 1, 0.8],
  ["DRY-001", "Flavoured Milk 225ml", "dairy", 70, 130, 1, 0.9], ["DRY-002", "Yogurt Drink 250ml", "dairy", 60, 110, 1, 0.7],
  ["DRY-003", "Cold Coffee 240ml", "dairy", 140, 240, 1, 0.8], ["SNK-001", "Salted Crisps 45g", "snack", 45, 80, 0, 1.3],
  ["SNK-002", "Masala Crisps 45g", "snack", 45, 80, 0, 1.4], ["SNK-003", "Nimko Mix 60g", "snack", 40, 70, 0, 0.9],
  ["SNK-004", "Popcorn Butter 40g", "snack", 50, 90, 0, 0.6], ["SNK-005", "Roasted Peanuts 50g", "snack", 35, 60, 0, 0.5],
  ["CON-001", "Chocolate Bar 40g", "confectionery", 70, 120, 0, 1.2], ["CON-002", "Wafer Bar 35g", "confectionery", 30, 50, 0, 1.0],
  ["CON-003", "Chewing Gum Pack", "confectionery", 25, 40, 0, 0.6], ["CON-004", "Caramel Toffee Pack", "confectionery", 40, 70, 0, 0.5],
  ["BAK-001", "Chocolate Chip Cookies", "bakery", 55, 100, 0, 1.0], ["BAK-002", "Cake Rusk 150g", "bakery", 60, 110, 0, 0.5],
  ["BAK-003", "Digestive Biscuits", "bakery", 50, 90, 0, 0.7], ["SAN-001", "Chicken Sandwich", "fresh_food", 150, 280, 1, 0.9],
  ["SAN-002", "Vegetable Wrap", "fresh_food", 130, 250, 1, 0.6], ["SAN-003", "Fruit Cup 200g", "fresh_food", 110, 200, 1, 0.5],
];
const PERISHABLE = new Set(["dairy", "fresh_food"]);
const CASE_PACK = { beverage: 24, dairy: 12, snack: 24, confectionery: 36, bakery: 12, fresh_food: 6 };
const SUPPLIER = { beverage: "Synthetic Beverages Ltd", dairy: "Synthetic Dairy Co", snack: "Synthetic Snacks Co",
  confectionery: "Synthetic Snacks Co", bakery: "Synthetic Bakers", fresh_food: "Synthetic Kitchens" };
// Synthetic given/family names for the "realistic names" privacy mode. Invented combinations only.
const GIVEN = ["Ayesha", "Bilal", "Hira", "Omar", "Sana", "Hamza", "Maryam", "Usman", "Zara", "Imran", "Nida", "Faisal", "Mehak", "Tariq", "Rabia", "Saad",
  "Alex", "Jordan", "Priya", "Daniel", "Sofia", "Lukas", "Emma", "Noah", "Chloe", "Leon", "Mia", "Ethan", "Hannah", "Ravi", "Grace", "Tom"];
const FAMILY = ["Qureshi", "Malik", "Siddiqui", "Hussain", "Chaudhry", "Awan", "Rana", "Baig", "Sheikh", "Mirza", "Carter", "Novak", "Schmidt",
  "Patel", "Reyes", "Walsh", "Becker", "Morgan", "Hughes", "Fischer", "Kaur", "Bennett", "Lang", "Shaw"];

const SETPOINT = 4, LOCKOUT = 8, STEP = 15, SPH = 4;
// Cashless channels. "card" in transactions.payment_method means any of these; transactions.channel names which.
const CHANNELS = {
  qr_code: { label: "QR code", provider: "SynthPay QR" }, mobile_nfc: { label: "Mobile wallet (NFC)", provider: "TapWallet NFC" },
  rfid_card: { label: "RFID card", provider: "SiteID RFID" }, contactless_card: { label: "Contactless card", provider: "Synthetic Acquirer" },
};
const CH_KEYS = Object.keys(CHANNELS);
const CH_MIX = { university: [0.35, 0.2, 0.3, 0.15], office: [0.25, 0.2, 0.35, 0.2], hospital: [0.3, 0.2, 0.25, 0.25], mall: [0.35, 0.3, 0.02, 0.33],
  metro_station: [0.45, 0.3, 0.05, 0.2], petrol_station: [0.3, 0.2, 0.02, 0.48] };
const DECLINE = [["insufficient_funds", 0.45], ["network_timeout", 0.35], ["qr_expired", 0.1], ["card_not_supported", 0.1]];
const DAY = 86400000, MIN = 60000;

// ---------------------------------------------------------------- Scenarios
const EVENT_TYPES = {
  heatwave: { desc: "Ambient temperature rises in the targeted cities; cold drinks sell faster, compressors work harder.", params: { delta_c: 6 }, dur: 72 },
  compressor_failure: { desc: "Refrigeration fails; cabinet drifts to ambient; chilled slots lock out above 8 °C.", params: { mode: "gradual" }, dur: 20 },
  power_outage: { desc: "No power: no vends, no cooling, telemetry reports 0 W.", params: {}, dur: 6 },
  demand_spike: { desc: "Sales multiply for targeted sites or categories (exam week, event, festival).", params: { multiplier: 3, categories: [] }, dur: 48 },
  restock_delay: { desc: "Scheduled restocks are skipped for targeted routes or machines.", params: {}, dur: 96 },
  card_reader_failure: { desc: "Card and wallet payments fail; only cash customers can buy.", params: {}, dur: 24 },
  door_left_open: { desc: "Service door left ajar; temperature climbs, door sensor stays on.", params: {}, dur: 3 },
};
const EXAMPLES = [
  "Simulate a cooling compressor failure on Machine #404 during a heatwave on day 3",
  "Exam week at universities: triple beverage and snack demand from day 2 for 3 days",
  "Power outage in the first depot city on day 4 at 2pm for 8 hours",
  "Card reader failure on machine 117 for 2 days and delay restocks on route R-02-1",
  "Heatwave across the fleet from day 1 for 4 days, +9C",
  "Someone left the door open on machine 130 on day 5 at 9pm",
];
const TYPE_PATTERNS = [
  ["compressor_failure", /compressor|cooling (?:fail|failure|fault|broke)|refrigerat\w* (?:fail|fault)|fridge (?:fail|broke)/],
  ["heatwave", /heat ?wave|extreme heat|hot spell|scorching|\+\s*\d+\s*°?\s*c\b/],
  ["power_outage", /power (?:outage|cut|failure)|blackout|load ?shedding|outage/],
  ["demand_spike", /spike|surge|rush|exam week|festival|event|double|triple|\d+(?:\.\d+)?\s*x\b|demand/],
  ["restock_delay", /restock\w* (?:delay|miss|skip)|delay\w* restock|missed restock|no restock|driver strike|truck breakdown/],
  ["card_reader_failure", /card reader|payment (?:fail|outage)|card (?:fail|outage)|cashless (?:fail|down)/],
  ["door_left_open", /door (?:left )?open|door ajar|left the door/],
];
const LOC_KW = { university: /universit|campus|student|exam/, hospital: /hospital|clinic/, office: /office|corporate/, mall: /\bmall|shopping/,
  metro_station: /metro|station|commuter/, petrol_station: /petrol|fuel|gas station/ };
const CAT_KW = { beverage: /beverage|drink|soda|water|juice/, snack: /snack|crisp|chips/, confectionery: /chocolate|candy|confection|sweet/,
  dairy: /dairy|milk|yog/, fresh_food: /sandwich|fresh food|wrap|meal/, bakery: /bakery|biscuit|cookie/ };
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function weekday(ms) { return (new Date(ms).getUTCDay() + 6) % 7; } // Mon=0

function normalizeEvent(ev, cfg) {
  const spec = EVENT_TYPES[ev.type];
  if (!spec) throw new Error("Unknown event type: " + ev.type);
  const cities = Object.keys(REGIONS[cfg.region].cities);
  const t = ev.targets || {};
  const targets = {
    machine_ids: [...new Set((t.machine_ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b),
    cities: (t.cities || []).filter(c => cities.includes(c)),
    location_types: (t.location_types || []).filter(l => LOCATION_TYPES[l]),
    route_ids: (t.route_ids || []).map(r => String(r).toUpperCase()),
  };
  const horizon = cfg.days * 24;
  let start = ev.start_offset_h ?? horizon * 0.4;
  start = Math.max(0, Math.min(start, horizon - 1));
  let dur = ev.duration_h || spec.dur;
  dur = Math.max(0.25, Math.min(dur, horizon - start));
  const params = Object.assign({}, spec.params, ev.params || {});
  if (ev.type === "demand_spike") params.multiplier = Math.max(0.1, Math.min(+params.multiplier, 10));
  if (ev.type === "heatwave") params.delta_c = Math.max(1, Math.min(+params.delta_c, 20));
  return { type: ev.type, targets, start_offset_h: +start.toFixed(2), duration_h: +dur.toFixed(2), params, label: ev.label || eventLabel(ev.type, targets), background: !!ev.background };
}

function eventLabel(type, t) {
  const where = [];
  const plural = { university: "universities", metro_station: "metro stations", petrol_station: "petrol stations" };
  if (t.machine_ids.length) where.push("machine " + t.machine_ids.map(m => "#" + m).join(", "));
  if (t.cities.length) where.push(t.cities.join(", "));
  if (t.location_types.length) where.push(t.location_types.map(l => plural[l] || l + "s").join(", "));
  if (t.route_ids.length) where.push("route " + t.route_ids.join(", "));
  const name = type.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
  if (type === "heatwave" && t.machine_ids.length && !t.cities.length) return name + " — city around machine " + t.machine_ids.map(m => "#" + m).join(", ");
  return name + " — " + (where.length ? where.join("; ") : "whole fleet");
}

function parseIntent(prompt, cfg) {
  const text = (prompt || "").toLowerCase();
  if (!text.trim()) return { events: [], notes: ["Empty prompt: baseline data only."] };
  const cityNames = Object.keys(REGIONS[cfg.region].cities);
  const clauses = text.split(/\s*(?:;|\band then\b|\band also\b|\.\s)\s*|\s+and\s+(?=(?:delay|a |an |heat|power|card|door|triple|double|exam|spike|surge|restock))/).filter(s => s && s.trim());
  const events = [];
  const notes = [];
  for (const clause of clauses) {
    let types = TYPE_PATTERNS.filter(([, p]) => p.test(clause)).map(([t]) => t);
    if (types.includes("demand_spike") && types.length > 1 && !/spike|surge|rush|exam|festival|double|triple|\d\s*x\b/.test(clause)) types = types.filter(t => t !== "demand_spike");
    if (!types.length) continue;
    // time
    let startH = null, durH = null;
    let m = clause.match(/day\s*(\d+)/);
    if (m) startH = (+m[1] - 1) * 24;
    else { const wi = WEEKDAYS.findIndex(w => clause.includes(w)); if (wi >= 0) startH = ((wi - weekday(cfg.startMs)) % 7 + 7) % 7 * 24; }
    if (startH !== null) {
      const tm = clause.match(/(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
      if (tm) startH += (+tm[1] % 12) + (tm[3] === "pm" ? 12 : 0) + (+(tm[2] || 0)) / 60;
      else if (clause.includes("morning")) startH += 8;
      else if (/evening|night/.test(clause)) startH += 20;
      else if (clause.includes("afternoon")) startH += 14;
      else startH += 12;
    }
    const d = clause.match(/for\s*(\d+(?:\.\d+)?)\s*(hour|hr|h\b|day|week)/);
    if (d) durH = +d[1] * (d[2].startsWith("day") ? 24 : d[2].startsWith("week") ? 168 : 1);
    // targets
    let ids = [...clause.matchAll(/(?:machine|vm|unit|kiosk)s?\s*(?:no\.?|number)?\s*#?\s*(\d{2,4})/g)].map(x => +x[1]);
    ids = [...new Set(ids.concat([...clause.matchAll(/#\s*(\d{2,4})/g)].map(x => +x[1])))];
    let cities = cityNames.filter(c => clause.includes(c.toLowerCase()));
    if (/first depot city|depot city|home city/.test(clause) && !cities.length) cities = ["@depot1"];
    const locs = ids.length ? [] : Object.keys(LOC_KW).filter(l => LOC_KW[l].test(clause));
    const routes = [...clause.matchAll(/\b(r-\d{2}-\d)\b/g)].map(x => x[1].toUpperCase());
    for (const type of types) {
      const ev = { type, targets: { machine_ids: ids, cities, location_types: locs, route_ids: routes }, params: {} };
      if (startH !== null) ev.start_offset_h = startH;
      if (durH !== null) ev.duration_h = durH;
      if (type === "heatwave") {
        const dm = clause.match(/\+\s*(\d+(?:\.\d+)?)\s*°?\s*c/); if (dm) ev.params.delta_c = +dm[1];
        if (types.includes("compressor_failure")) { if (startH !== null) ev.start_offset_h = Math.max(0, startH - 24); ev.duration_h = durH || 72; }
      }
      if (type === "compressor_failure" && types.includes("heatwave") && startH === null) ev.start_offset_h = cfg.days * 24 * 0.4 + 14;
      if (type === "demand_spike") {
        let mult = 3; if (clause.includes("double")) mult = 2; else if (clause.includes("quadruple")) mult = 4;
        const mm = clause.match(/(\d+(?:\.\d+)?)\s*x\b/); if (mm) mult = +mm[1];
        ev.params.multiplier = mult; ev.params.categories = Object.keys(CAT_KW).filter(c => CAT_KW[c].test(clause));
      }
      events.push(ev);
    }
  }
  if (!events.length) notes.push("No known edge case recognised. Try words like heatwave, compressor, outage, spike, restock delay, card reader, door open.");
  return { events, notes }; // normalised later, once the fleet (and depot cities) are known
}

// ---------------------------------------------------------------- Fleet
function buildMaster(cfg, R, reservedIds, reservedCities, reservedLocs) {
  const reg = REGIONS[cfg.region];
  const cityNames = Object.keys(reg.cities);
  const forced = reservedCities.filter(c => cityNames.includes(c)).slice(0, cfg.nWh);
  const rest = R.shuffle(cityNames.filter(c => !forced.includes(c)));
  const whCities = forced.concat(rest).slice(0, cfg.nWh);
  while (whCities.length < cfg.nWh) whCities.push(R.pick(cityNames));
  const names = cfg.privacy.names === "realistic";
  const person = () => R.pick(GIVEN) + " " + R.pick(FAMILY);

  const warehouses = whCities.map((city, i) => {
    const [lat, lon] = reg.cities[city];
    return { warehouse_id: "W-" + String(i + 1).padStart(2, "0"), name: `${city} Depot ${i + 1}`, city,
      lat: +(lat + R.normal(0, 0.03)).toFixed(5), lon: +(lon + R.normal(0, 0.03)).toFixed(5), capacity_units: R.int(20, 60) * 1000 };
  });
  const routes = []; const drivers = R.shuffle([...Array(899).keys()].map(i => i + 100));
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  for (const w of warehouses) for (let k = 1; k <= cfg.nRt; k++) {
    const shift = (k - 1) % 3;
    const days = [...new Set([0, 3].map(d => (d + shift) % 6))].sort();
    routes.push({ route_id: `R-${w.warehouse_id.slice(2)}-${k}`, warehouse_id: w.warehouse_id, route_name: `${w.city} Route ${k}`,
      driver: names ? person() : "DRV-" + drivers[routes.length], service_days: days.map(d => DOW[d]).join(","), vehicle: "VAN-" + R.int(10, 99), _days: days });
  }
  const n = cfg.nWh * cfg.nRt * cfg.nMc;
  let ids = R.shuffle([...Array(899).keys()].map(i => i + 101)).slice(0, n);
  for (const rid of reservedIds) if (!ids.includes(rid)) { const i = ids.findIndex(x => !reservedIds.includes(x)); if (i >= 0) ids[i] = rid; }
  ids.sort((a, b) => a - b);
  const order = R.shuffle([...Array(n).keys()]);
  const locNames = Object.keys(LOCATION_TYPES);
  const machines = []; let idx = 0;
  const whById = Object.fromEntries(warehouses.map(w => [w.warehouse_id, w]));
  for (const r of routes) {
    const city = whById[r.warehouse_id].city; const [lat0, lon0] = reg.cities[city];
    for (let stop = 1; stop <= cfg.nMc; stop++) {
      const id = ids[order[idx++]];
      const loc = locNames[R.pickW(LOC_P, 1)];
      const model = R.pick(Object.keys(MODELS));
      const jit = cfg.privacy.jitter ? R.normal(0, 0.009) : 0;
      machines.push({ machine_id: id, route_id: r.route_id, route_stop: stop, site_name: `${city} ${LOCATION_TYPES[loc].label} Site ${id}`,
        location_type: loc, city, lat: +(lat0 + R.normal(0, 0.06) + jit).toFixed(5), lon: +(lon0 + R.normal(0, 0.06) + jit).toFixed(5),
        model, install_date: cfg.startMs - R.int(60, 1100) * DAY, slot_count: MODELS[model][2] });
    }
  }
  const others = machines.filter(m => !reservedLocs.includes(m.location_type));
  reservedLocs.forEach((lt, k) => {
    const have = machines.filter(m => m.location_type === lt).length;
    others.slice(k * 2, k * 2 + Math.max(0, 2 - have)).forEach(m => { m.location_type = lt; m.site_name = `${m.city} ${LOCATION_TYPES[lt].label} Site ${m.machine_id}`; });
  });

  const roundP = (v) => { const x = v * reg.fx; return Math.max(reg.round, Math.round(x / reg.round) * reg.round); };
  const products = PRODUCTS.map(([sku, name, cat, cost, price, chilled, pop]) => ({ product_id: sku, name, category: cat,
    unit_cost: +(cost * reg.fx).toFixed(reg.dec ? 2 : 0), unit_price: +roundP(price).toFixed(reg.dec), chilled: !!chilled, _pop: pop }));
  const skus = products.map(p => p.product_id);
  const slots = [];
  for (const m of machines) {
    const w = products.map(p => p._pop * ((m.location_type === "hospital" || m.location_type === "office") && PERISHABLE.has(p.category) ? 1.8 : 1)
      * ((m.location_type === "metro_station" || m.location_type === "petrol_station") && p.category === "beverage" ? 1.4 : 1));
    const picks = []; const wl = w.slice();
    while (picks.length < Math.min(m.slot_count, skus.length)) { const i = R.pickW(wl); picks.push(skus[i]); wl[i] = 0; }
    while (picks.length < m.slot_count) { const s = skus[R.pickW(w)]; if (picks.filter(x => x === s).length < 2) picks.push(s); }
    picks.forEach((sku, k) => {
      const cat = products[skus.indexOf(sku)].category;
      const cap = (cat === "beverage" || cat === "dairy") ? R.int(8, 11) : cat === "fresh_food" ? R.int(6, 9) : R.int(10, 16);
      const code = "ABCDE"[Math.floor(k / 6)] + (k % 6 + 1);
      slots.push({ slot_id: `${m.machine_id}-${code}`, machine_id: m.machine_id, slot_code: code, product_id: sku, capacity: cap, par_level: Math.max(2, Math.ceil(cap * 0.35)) });
    });
  }
  return { warehouses, routes, machines, products, slots };
}

function affected(ev, machines) {
  const t = ev.targets;
  if (!t.machine_ids.length && !t.cities.length && !t.route_ids.length && !t.location_types.length) return new Set(machines.map(m => m.machine_id));
  const out = new Set();
  for (const m of machines) {
    let hit = t.machine_ids.includes(m.machine_id) || t.cities.includes(m.city) || t.route_ids.includes(m.route_id);
    const lt = t.location_types.includes(m.location_type);
    if (t.location_types.length) hit = (t.cities.length && !t.machine_ids.length) ? (hit && lt) : (hit || lt);
    if (hit) out.add(m.machine_id);
  }
  return out;
}

function backgroundEvents(cfg, machines, R) {
  const evs = []; const H = cfg.days * 24; const f = cfg.days / 7;
  const one = (type, id, s, d, label) => evs.push({ type, targets: { machine_ids: [id], cities: [], location_types: [], route_ids: [] }, start_offset_h: s, duration_h: d, params: {}, label, background: true });
  for (const m of machines) {
    if (R.next() < 0.06 * f) one("card_reader_failure", m.machine_id, R.uni(0, H - 8), R.uni(2, 6), `Background: card reader glitch #${m.machine_id}`);
    if (R.next() < 0.03 * f) one("door_left_open", m.machine_id, R.uni(0, H - 3), R.uni(0.75, 1.5), `Background: door ajar #${m.machine_id}`);
    if (!LOCATION_TYPES[m.location_type].indoor && R.next() < 0.08 * f) one("power_outage", m.machine_id, R.uni(0, H - 3), R.pick([1, 1.5, 2]), `Background: grid interruption #${m.machine_id}`);
  }
  return evs;
}

// ---------------------------------------------------------------- Simulation
function hourProfiles() {
  const out = {};
  for (const [loc, s] of Object.entries(LOCATION_TYPES)) {
    const p = []; for (let h = 0; h < 24; h++) { let v = 0.25; for (const pk of s.peaks) v += Math.exp(-((h + 0.5 - pk) ** 2) / (2 * 1.6 ** 2)); if (h < s.open[0] || h >= s.open[1]) v = 0; p.push(v); }
    const mean = p.reduce((a, b) => a + b, 0) / 24; out[loc] = p.map(v => v / mean);
  }
  return out;
}
function dowFactor(loc, dow) {
  if (loc === "office" || loc === "university") return dow === 5 ? 0.5 : dow === 6 ? 0.2 : 1;
  if (loc === "mall") return dow === 4 ? 1.1 : dow === 5 ? 1.35 : dow === 6 ? 1.4 : 1;
  return 1;
}

function simulate(cfg, M, events, R) {
  const reg = REGIONS[cfg.region];
  const nSteps = cfg.days * 24 * SPH;
  const t0 = cfg.startMs;
  const prof = hourProfiles();
  const prod = Object.fromEntries(M.products.map(p => [p.product_id, p]));
  const cityKeys = Object.keys(reg.cities);
  const hw = Object.fromEntries(cityKeys.map(c => [c, new Float32Array(nSteps)]));
  const perM = new Map(M.machines.map(m => [m.machine_id, []]));
  for (const ev of events) {
    const s0 = Math.max(0, Math.floor(ev.start_offset_h * SPH)), s1 = Math.min(nSteps, Math.ceil((ev.start_offset_h + ev.duration_h) * SPH));
    let hit = affected(ev, M.machines);
    if (ev.type === "heatwave") {
      const cs = new Set(ev.targets.cities); M.machines.forEach(m => { if (hit.has(m.machine_id)) cs.add(m.city); });
      for (const c of cs) for (let s = s0; s < s1; s++) { const r = Math.min(1, (s - s0 + 1) / (6 * SPH), (s1 - s) / (6 * SPH)) * ev.params.delta_c; if (r > hw[c][s]) hw[c][s] = r; }
      hit = new Set(M.machines.filter(m => cs.has(m.city)).map(m => m.machine_id));
    }
    for (const id of hit) perM.get(id).push([ev, s0, s1]);
  }
  const amb = {};
  for (const c of cityKeys) {
    const [, , mean, swing] = reg.cities[c]; const a = new Float32Array(nSteps);
    const daily = Array.from({ length: cfg.days + 1 }, () => R.normal(0, 1.4));
    for (let s = 0; s < nSteps; s++) { const h = s / SPH; a[s] = mean + swing * Math.sin(2 * Math.PI * ((h % 24) - 9) / 24) + daily[Math.floor(h / 24)] + R.normal(0, 0.35) + hw[c][s]; }
    amb[c] = a;
  }
  const tokenPool = Object.fromEntries(cityKeys.map(c => [c, Array.from({ length: 300 }, () => cfg.privacy.tokens === "masked" ? "•••• " + String(R.int(1000, 9999)) : "tok_" + R.hex(12))]));
  const zipf = Array.from({ length: 300 }, (_, i) => 1 / (i + 1) ** 0.8); const zipfT = zipf.reduce((a, b) => a + b, 0);
  const routeDays = Object.fromEntries(M.routes.map(r => [r.route_id, new Set(r._days)]));

  const tx = [], restocks = [], tel = [], lost = [], collections = [], payments = [];
  const RP = rngFactory(cfg.seed + 99); // payment-detail randomness kept separate from the demand model
  const invSnap = new Map(); // machine -> {slotIds, hours: Int16Array(hours*slots)}
  for (const m of M.machines) {
    const mid = m.machine_id; const loc = m.location_type; const [idleW, compW] = MODELS[m.model];
    const ms = M.slots.filter(s => s.machine_id === mid); const nS = ms.length;
    const cap = ms.map(s => s.capacity); const stock = cap.map(c => Math.max(1, Math.round(c * R.uni(0.6, 1))));
    const cats = ms.map(s => prod[s.product_id].category); const chilled = ms.map(s => prod[s.product_id].chilled);
    const perish = cats.map(c => PERISHABLE.has(c)); const prices = ms.map(s => prod[s.product_id].unit_price); const pop = ms.map(s => prod[s.product_id]._pop);
    const mfac = Math.exp(R.normal(0, 0.28)); const indoor = LOCATION_TYPES[loc].indoor; const ao = amb[m.city];
    const fail = new Uint8Array(nSteps), phase = new Float32Array(nSteps), sudden = new Uint8Array(nSteps), outage = new Uint8Array(nSteps),
      card = new Uint8Array(nSteps), door = new Uint8Array(nSteps), noRestock = new Uint8Array(nSteps); const spikes = []; const labels = new Array(nSteps);
    for (const [ev, s0, s1] of perM.get(mid)) {
      const tag = (ev.background ? "bg:" : "") + ev.type;
      for (let s = s0; s < s1; s++) labels[s] = labels[s] ? labels[s] + "," + tag : tag;
      const fillArr = (arr) => { for (let s = s0; s < s1; s++) arr[s] = 1; };
      if (ev.type === "compressor_failure") { fillArr(fail); for (let s = s0; s < s1; s++) phase[s] = (s - s0) / Math.max(1, s1 - s0); if (ev.params.mode === "sudden") fillArr(sudden); }
      else if (ev.type === "power_outage") fillArr(outage); else if (ev.type === "card_reader_failure") fillArr(card);
      else if (ev.type === "door_left_open") fillArr(door); else if (ev.type === "restock_delay") fillArr(noRestock);
      else if (ev.type === "demand_spike") spikes.push([s0, s1, ev.params.multiplier, ev.params.categories || []]);
    }
    const hours = cfg.days * 24; const snap = new Int16Array(hours * nS);
    invSnap.set(mid, { slotIds: ms.map(s => s.slot_id), snap, nS });
    let temp = SETPOINT + R.normal(0, 0.3), warm = 0, cashSince = 0;
    const visitMin = 9 * 60 + 10 + 18 * (m.route_stop - 1);
    for (let s = 0; s < nSteps; s++) {
      const ts = t0 + s * STEP * MIN; const hm = (s * STEP) % 1440; const h = Math.floor(hm / 60); const dow = weekday(ts);
      let minSale = 0;
      if (hm % 60 === 0) { const hi = s / SPH; for (let j = 0; j < nS; j++) snap[hi * nS + j] = stock[j]; }
      if (hm <= visitMin && visitMin < hm + STEP && routeDays[m.route_id].has(dow) && s > 0 && !noRestock[s] && !outage[s]) {
        const visit = ts + (visitMin - hm) * MIN + 1000; minSale = (visit - ts) / 1000 + 1;
        for (let j = 0; j < nS; j++) if (stock[j] < cap[j]) { restocks.push({ ts: visit, route_id: m.route_id, machine_id: mid, slot_id: ms[j].slot_id, product_id: ms[j].product_id, qty_added: cap[j] - stock[j], stock_before: stock[j], stock_after: cap[j], reason: "scheduled" }); stock[j] = cap[j]; }
        if (cashSince > 0) collections.push({ ts: visit, route_id: m.route_id, machine_id: mid, amount: +cashSince.toFixed(2) });
        cashSince = 0;
      }
      const a = indoor ? 24 + 0.3 * (ao[s] - 24) + R.normal(0, 0.25) : ao[s];
      let target, tau, duty, cycles, power;
      if (outage[s]) { target = a; tau = 4; duty = 0; cycles = 0; power = 0; }
      else if (fail[s]) { target = a; tau = 3; if (!sudden[s] && phase[s] < 0.25) { duty = 1; cycles = R.int(6, 11); } else { duty = 0; cycles = 0; } power = idleW + duty * compW * 1.15 + R.normal(0, 6); }
      else if (door[s]) { target = a - 4; tau = 1; duty = 1; cycles = R.int(1, 3); power = idleW + compW + R.normal(0, 8); }
      else { target = SETPOINT + 0.04 * (a - 25); const pd = temp > SETPOINT + 1.5;
        duty = pd ? 1 : Math.min(0.97, Math.max(0.12, 0.28 + 0.022 * (a - 20) + R.normal(0, 0.05))); cycles = pd ? 1 : R.poisson(0.8 + 1.4 * duty); power = idleW + duty * compW + R.normal(0, 6); tau = pd ? 0.35 : 0.25; }
      temp = temp + (target - temp) * (1 - Math.exp(-(STEP / 60) / tau)) + R.normal(0, 0.12);
      const locked = temp > LOCKOUT;
      if (locked) warm++;
      else { if (warm >= 2 * SPH) { const wo = ts + Math.max(60, minSale) * 1000; for (let j = 0; j < nS; j++) if (perish[j] && stock[j] > 0) { restocks.push({ ts: wo, route_id: m.route_id, machine_id: mid, slot_id: ms[j].slot_id, product_id: ms[j].product_id, qty_added: -stock[j], stock_before: stock[j], stock_after: 0, reason: "spoilage_writeoff" }); stock[j] = 0; } minSale = (wo - ts) / 1000 + 1; } warm = 0; }
      const heat = Math.max(0, ao[s] - 30);
      const w = pop.map((p, j) => p * ((cats[j] === "beverage" || cats[j] === "dairy") ? 1 + 0.07 * heat : 1));
      let rateMult = 1 + 0.015 * heat;
      for (const [a0, a1, mult, spc] of spikes) if (s >= a0 && s < a1) {
        if (spc.length) { const tot = w.reduce((x, y) => x + y, 0); let sh = 0; for (let j = 0; j < nS; j++) if (spc.includes(cats[j])) { sh += w[j]; w[j] *= mult; } rateMult *= 1 + (mult - 1) * sh / tot; }
        else rateMult *= mult;
      }
      const lam = LOCATION_TYPES[loc].rate * prof[loc][h] * dowFactor(loc, dow) * mfac * rateMult / SPH;
      let nc = R.poisson(lam), lostN = 0;
      if (outage[s]) { lostN = nc; nc = 0; }
      if (nc) {
        const wt = w.reduce((x, y) => x + y, 0);
        for (let c = 0; c < nc; c++) {
          let j = R.pickW(w, wt);
          const avail = (k) => stock[k] > 0 && !(chilled[k] && locked);
          if (!avail(j)) {
            const aw = w.map((v, k) => avail(k) ? v : 0); const at = aw.reduce((x, y) => x + y, 0);
            if (at > 0 && R.next() < 0.5) j = R.pickW(aw, at); else { lostN++; continue; }
          }
          let isCard = R.next() < cfg.cardShare; let ch = "cash";
          if (isCard) {
            const mix = CH_MIX[loc].map((v, k) => v * (cfg.region === "PK" ? [1.4, 0.8, 1, 0.7][k] : [0.5, 1.5, 1, 1.3][k]));
            ch = CH_KEYS[RP.pickW(mix)];
            const tkn = tokenPool[m.city][RP.pickW(zipf, zipfT)];
            const decline = (reason) => payments.push({ ts: ts + Math.floor(RP.uni(minSale, STEP * 60)) * 1000, machine_id: mid, _tx: null, channel: ch, provider: CHANNELS[ch].provider,
              token: tkn, amount: prices[j], status: "declined", decline_reason: reason, auth_code: "", settlement_batch: "", latency_ms: RP.int(900, 8000) });
            if (card[s]) { decline("terminal_offline"); if (R.next() < 0.6) { lostN++; continue; } isCard = false; ch = "cash"; }
            else if (RP.next() < 0.015) { const rs = DECLINE[RP.pickW(DECLINE.map(d => d[1]))][0]; decline(ch === "qr_code" || rs !== "qr_expired" ? rs : "insufficient_funds");
              if (RP.next() < 0.5) { lostN++; continue; } isCard = false; ch = "cash"; }
          }
          const qty = stock[j] >= 2 && R.next() < 0.04 ? 2 : 1; stock[j] -= qty;
          const amt = +(prices[j] * qty).toFixed(2);
          if (!isCard) cashSince += amt;
          const tk = isCard ? tokenPool[m.city][R.pickW(zipf, zipfT)] : "";
          const txo = { ts: ts + Math.floor(R.uni(minSale, STEP * 60)) * 1000, machine_id: mid, slot_id: ms[j].slot_id, product_id: ms[j].product_id, qty, unit_price: prices[j], amount: amt, payment_method: isCard ? "card" : "cash", channel: ch, card_token: tk };
          tx.push(txo);
          if (isCard) { const lat = RP.int(300, 2600); payments.push({ ts: txo.ts - lat, machine_id: mid, _tx: txo, channel: ch, provider: CHANNELS[ch].provider, token: tk, amount: amt,
            status: "approved", decline_reason: "", auth_code: RP.hex(6).toUpperCase(), settlement_batch: "ACQ-" + (Math.floor((txo.ts - t0) / DAY) + 1), latency_ms: lat }); }
        }
      }
      if (lostN) lost.push([mid, s, lostN]);
      tel.push({ ts, machine_id: mid, ambient_c: +a.toFixed(2), temp_c: +temp.toFixed(2), compressor_on_pct: +(duty * 100).toFixed(1), compressor_cycles: cycles,
        power_w: +Math.max(0, power).toFixed(1), door_open: !!door[s], card_reader_ok: !(card[s] || outage[s]), total_stock: stock.reduce((x, y) => x + y, 0), active_events: labels[s] || "" });
    }
    m._cashInMachine = +cashSince.toFixed(2);
  }
  tx.sort((a, b) => a.ts - b.ts); tx.forEach((t, i) => t.txn_id = "TX-" + String(i + 1).padStart(7, "0"));
  restocks.sort((a, b) => a.ts - b.ts); restocks.forEach((r, i) => r.restock_id = "RS-" + String(i + 1).padStart(6, "0"));
  payments.sort((a, b) => a.ts - b.ts);
  const pays = payments.map((p, i) => ({ payment_id: "PM-" + String(i + 1).padStart(7, "0"), ts: p.ts, machine_id: p.machine_id, txn_id: p._tx ? p._tx.txn_id : "",
    channel: p.channel, provider: p.provider, token: p.token, amount: p.amount, status: p.status, decline_reason: p.decline_reason, auth_code: p.auth_code, settlement_batch: p.settlement_batch, latency_ms: p.latency_ms }));
  return { tx, restocks, tel, lost, invSnap, collections, nSteps, payments: pays };
}

function runs(mask, minLen) { const out = []; let st = -1; for (let i = 0; i <= mask.length; i++) { const v = i < mask.length && mask[i]; if (v && st < 0) st = i; else if (!v && st >= 0) { if (i - st >= minLen) out.push([st, i]); st = -1; } } return out; }

function deriveTickets(cfg, M, S, R) {
  const t0 = cfg.startMs; const route = Object.fromEntries(M.machines.map(m => [m.machine_id, m.route_id]));
  const whOf = Object.fromEntries(M.routes.map(r => [r.route_id, r.warehouse_id]));
  const price = Object.fromEntries(M.products.map(p => [p.product_id, p.unit_price]));
  const avg = {}; for (const s of M.slots) (avg[s.machine_id] ||= []).push(price[s.product_id]);
  const byM = new Map(); for (const r of S.tel) { if (!byM.has(r.machine_id)) byM.set(r.machine_id, []); byM.get(r.machine_id).push(r); }
  const lostBy = new Map(); for (const [m, s, n] of S.lost) { if (!lostBy.has(m)) lostBy.set(m, []); lostBy.get(m).push([s, n]); }
  const techNames = cfg.privacy.names === "realistic";
  const tickets = [];
  for (const [mid, g] of [...byM.entries()].sort((a, b) => a[0] - b[0])) {
    const cands = [];
    const off = g.map(r => r.power_w === 0);
    runs(off, 2).forEach(([a, b]) => cands.push(["Power loss", a, b]));
    runs(g.map((r, i) => r.temp_c > LOCKOUT && !off[i]), 2).forEach(([a, b]) => { if (a > 0 && off[a - 1]) return;
      const ds = g.slice(a, b).filter(r => r.door_open).length / (b - a); cands.push([ds > 0.5 ? "Door left open" : "Refrigeration failure", a, b]); });
    runs(g.map((r, i) => !r.card_reader_ok && !off[i]), 4).forEach(([a, b]) => cands.push(["Payment terminal fault", a, b]));
    for (const [fault, a, b] of cands) {
      const seg = g.slice(a, b); const hrs = (b - a) / SPH;
      const lv = (lostBy.get(mid) || []).filter(([s]) => s >= a && s < b + 2 * SPH).reduce((x, [, n]) => x + n, 0);
      const maxT = Math.max(...seg.map(r => r.temp_c)), maxA = Math.max(...seg.map(r => r.ambient_c));
      let ev, prio;
      if (fault === "Refrigeration failure") { const pc = Math.max(...seg.map(r => r.compressor_cycles));
        ev = `Cabinet peaked at ${maxT.toFixed(1)} °C (ambient ${maxA.toFixed(1)} °C); above 8 °C for ${hrs.toFixed(1)} h`;
        if (pc >= 6) ev += `; compressor short-cycling up to ${pc} starts per 15 min before overload trip`; prio = maxT > 15 || hrs > 4 ? "P1" : "P2"; }
      else if (fault === "Door left open") { ev = `Door sensor open for ${hrs.toFixed(1)} h; cabinet reached ${maxT.toFixed(1)} °C`; prio = hrs > 1.5 ? "P2" : "P3"; }
      else if (fault === "Power loss") { ev = `0 W reported for ${hrs.toFixed(1)} h; no vends possible`; prio = hrs >= 4 ? "P1" : "P2"; }
      else { ev = `Card and wallet payments unavailable for ${hrs.toFixed(1)} h`; prio = "P3"; }
      const ta = t0 + a * STEP * MIN, tb = t0 + Math.min(b, S.nSteps - 1) * STEP * MIN;
      const spoiled = S.restocks.filter(r => r.machine_id === mid && r.reason === "spoilage_writeoff" && r.ts >= ta && r.ts <= tb + 35 * MIN).reduce((x, r) => x - r.qty_added, 0);
      if (spoiled) ev += `; ${spoiled} perishable units written off`;
      const ap = avg[mid].reduce((x, y) => x + y, 0) / avg[mid].length;
      const wh = whOf[route[mid]];
      tickets.push({ machine_id: mid, route_id: route[mid], opened_at: ta + R.int(5, 16) * MIN, closed_at: tb + R.int(10, 40) * MIN, fault_type: fault, priority: prio,
        technician: techNames ? R.pick(GIVEN) + " " + R.pick(FAMILY) : `TECH-${wh.slice(2)}${R.int(1, 4)}`, evidence: ev, lost_vends: lv, est_lost_revenue: +(lv * ap).toFixed(REGIONS[cfg.region].dec) });
    }
  }
  tickets.sort((a, b) => a.opened_at - b.opened_at); tickets.forEach((t, i) => t.ticket_id = "MT-" + String(i + 1).padStart(5, "0"));
  return tickets;
}

// ---------------------------------------------------------------- Documents
const SITE_COMMISSION = 0.12;
function r2(x) { return Math.round(x * 100) / 100; }

function buildDocuments(cfg, T) {
  const reg = REGIONS[cfg.region]; const rate = reg.tax.rate;
  const prod = Object.fromEntries(T.products.map(p => [p.product_id, p]));
  const mById = Object.fromEntries(T.machines.map(m => [m.machine_id, m]));
  const rById = Object.fromEntries(T.routes.map(r => [r.route_id, r]));
  const whById = Object.fromEntries(T.warehouses.map(w => [w.warehouse_id, w]));
  const pStart = cfg.startMs, pEnd = cfg.startMs + cfg.days * DAY - 1000;
  const ym = new Date(pStart).toISOString().slice(0, 7).replace("-", "");

  const txBy = new Map(); for (const t of T.transactions) { if (!txBy.has(t.machine_id)) txBy.set(t.machine_id, []); txBy.get(t.machine_id).push(t); }
  const invoices = [];
  for (const mid of [...txBy.keys()].sort((a, b) => a - b)) {
    const g = txBy.get(mid); const m = mById[mid]; const agg = {};
    for (const t of g) { const k = t.product_id; (agg[k] ||= { product_id: k, description: prod[k].name, qty: 0, unit_price: t.unit_price, amount: 0 }); agg[k].qty += t.qty; agg[k].amount = r2(agg[k].amount + t.amount); }
    const lines = Object.values(agg).sort((a, b) => b.amount - a.amount);
    const gross = r2(lines.reduce((x, l) => x + l.amount, 0));
    const tax = r2(gross * rate / (1 + rate));
    const commission = r2(gross * SITE_COMMISSION);
    invoices.push({ doc_id: `INV-${ym}-${mid}`, doc_type: "invoice", machine_id: mid, site_name: m.site_name, city: m.city, route_id: m.route_id,
      period_start: pStart, period_end: pEnd, lines, vend_count: g.length, cash_total: r2(g.filter(t => t.payment_method === "cash").reduce((x, t) => x + t.amount, 0)),
      channels: Object.fromEntries(CH_KEYS.map(k => [k, r2(g.filter(t => t.channel === k).reduce((x, t) => x + t.amount, 0))])),
      card_total: r2(g.filter(t => t.payment_method === "card").reduce((x, t) => x + t.amount, 0)), gross_sales: gross, tax_label: reg.tax.label, tax_rate: rate,
      tax_included: tax, net_of_tax: r2(gross - tax), site_commission_rate: SITE_COMMISSION, site_commission: commission, net_to_operator: r2(gross - commission),
      first_txn: g[0].txn_id, last_txn: g[g.length - 1].txn_id });
  }
  const pos = [];
  const needBy = {};
  for (const r of T.restocks) if (r.reason === "scheduled") { const wid = rById[r.route_id].warehouse_id; ((needBy[wid] ||= { need: {}, routes: new Set() }).need[r.product_id] ||= 0); needBy[wid].need[r.product_id] += r.qty_added; needBy[wid].routes.add(r.route_id); }
  for (const wid of Object.keys(needBy).sort()) {
    const lines = Object.entries(needBy[wid].need).map(([pid, q]) => { const p = prod[pid]; const pack = CASE_PACK[p.category]; const cases = Math.ceil(q * 1.1 / pack);
      return { product_id: pid, description: p.name, supplier: SUPPLIER[p.category], restocked_units: q, cases, case_pack: pack, order_units: cases * pack, unit_cost: p.unit_cost, amount: r2(cases * pack * p.unit_cost) }; })
      .sort((a, b) => (a.supplier + a.product_id).localeCompare(b.supplier + b.product_id));
    const sub = r2(lines.reduce((x, l) => x + l.amount, 0)); const tax = r2(sub * rate);
    pos.push({ doc_id: `PO-${new Date(pStart).toISOString().slice(0, 10).replace(/-/g, "")}-${wid}`, doc_type: "purchase_order", warehouse_id: wid, warehouse_name: whById[wid].name, city: whById[wid].city,
      period_start: pStart, period_end: pEnd, routes: [...needBy[wid].routes].sort(), lines, subtotal: sub, tax_label: reg.tax.label, tax_rate: rate, tax: tax, total_amount: r2(sub + tax),
      total_units: lines.reduce((x, l) => x + l.order_units, 0) });
  }
  const tickets = T.maintenance_tickets.map(t => { const m = mById[t.machine_id]; return Object.assign({ doc_id: t.ticket_id, doc_type: "service_ticket", site_name: m.site_name, model: m.model, city: m.city,
    warehouse_id: rById[t.route_id].warehouse_id, actions: ACTIONS[t.fault_type] || ["Inspect machine"] }, t); });

  // Bank statement: operator settlement account
  const lines = []; const push = (ts, description, debit, credit, ref, kind) => lines.push({ ts, description, debit: r2(debit), credit: r2(credit), ref, kind });
  const cardByDay = {}; for (const t of T.transactions) if (t.payment_method === "card") { const d = Math.floor((t.ts - pStart) / DAY); cardByDay[d] = r2((cardByDay[d] || 0) + t.amount); }
  let pendingCard = 0;
  for (let d = 0; d < cfg.days; d++) { const amt = cardByDay[d] || 0; if (!amt) continue;
    if (d + 1 < cfg.days) push(pStart + (d + 1) * DAY + 6 * 3600000, `Cashless settlement · QR, NFC, RFID, card · sales of ${fmtDate(pStart + d * DAY, cfg.region)}`, 0, amt, `ACQ-${d + 1}`, "card");
    else pendingCard = amt; }
  const colBy = {}; for (const c of T._collections) { const k = c.route_id + "|" + Math.floor((c.ts - pStart) / DAY); (colBy[k] ||= { route: c.route_id, day: Math.floor((c.ts - pStart) / DAY), amt: 0, n: 0 }); colBy[k].amt = r2(colBy[k].amt + c.amount); colBy[k].n++; }
  for (const c of Object.values(colBy)) push(pStart + c.day * DAY + 16 * 3600000 + 30 * MIN, `Cash deposit · route ${c.route} (${c.n} machines)`, 0, c.amt, `CSH-${c.route}-${c.day + 1}`, "cash");
  const visitDays = {}; for (const r of T.restocks) if (r.reason === "scheduled") visitDays[r.route_id + "|" + Math.floor((r.ts - pStart) / DAY)] = [r.route_id, Math.floor((r.ts - pStart) / DAY)];
  const RF = rngFactory(cfg.seed + 7);
  for (const [rid, d] of Object.values(visitDays)) push(pStart + d * DAY + 18 * 3600000, `Fuel · route ${rid}`, reg.fuel * RF.uni(0.85, 1.2), 0, `FUEL-${rid}-${d + 1}`, "fuel");
  for (const t of T.maintenance_tickets) if (t.closed_at <= pEnd) push(t.closed_at + 30 * MIN, `Field service · ${t.ticket_id} ${t.fault_type.toLowerCase()}`, reg.callout[t.priority], 0, t.ticket_id, "service");
  for (const p of pos) push(pEnd - 2 * 3600000, `Supplier payment · ${p.doc_id}`, p.total_amount, 0, p.doc_id, "supplier");
  const comm = r2(invoices.reduce((x, i) => x + i.site_commission, 0));
  push(pEnd - 3600000, `Site host commissions · ${invoices.length} sites`, comm, 0, "COMM-" + ym, "commission");
  lines.sort((a, b) => a.ts - b.ts);
  let bal = reg.opening; lines.forEach((l, i) => { bal = r2(bal + l.credit - l.debit); l.balance = bal; l.line_id = "BS-" + String(i + 1).padStart(4, "0"); });
  const statement = { doc_id: `STMT-${ym}-OPS`, doc_type: "bank_statement", account: "Operator settlement account · ****" + String(1000 + (cfg.seed * 37) % 9000),
    period_start: pStart, period_end: pEnd, opening_balance: reg.opening, closing_balance: bal, lines, pending_card_settlement: pendingCard,
    cash_in_machines: r2(T.machines.reduce((x, m) => x + (m._cashInMachine || 0), 0)) };
  return { invoice: invoices, purchase_order: pos, service_ticket: tickets, bank_statement: [statement] };
}
const ACTIONS = {
  "Refrigeration failure": ["Inspect compressor start relay and overload protector", "Check condenser coil and fan; clean if blocked", "Verify refrigerant pressure; recharge or replace compressor", "Discard perishable stock held above 8 °C for 2 h or more"],
  "Door left open": ["Close and latch service door", "Check door switch and gasket seal", "Confirm pull-down to 4 °C within 90 minutes"],
  "Power loss": ["Confirm site supply restored", "Check machine fuse and surge protector", "Verify telemetry resumes and temperature recovers"],
  "Payment terminal fault": ["Power-cycle card reader", "Check reader cable and SIM signal", "Replace reader if fault persists"],
};

function queryStatement(st, q, region) {
  const text = (q || "").toLowerCase(); let rows = st.lines.slice(); const applied = [];
  const endMs = st.period_end;
  let m = text.match(/last\s*(\d+)\s*(day|week)/); if (m) { const n = +m[1] * (m[2] === "week" ? 7 : 1); rows = rows.filter(l => l.ts > endMs - n * DAY); applied.push(`last ${n} days`); }
  m = text.match(/balance\s*(over|above|>|under|below|<)\s*([\d,\.]+)\s*(k|m)?/);
  if (m) { const v = +m[2].replace(/,/g, "") * (m[3] === "k" ? 1e3 : m[3] === "m" ? 1e6 : 1); const over = /over|above|>/.test(m[1]); rows = rows.filter(l => over ? l.balance > v : l.balance < v); applied.push(`balance ${over ? ">" : "<"} ${v.toLocaleString()}`); }
  m = text.replace(/balance\s*(over|above|>|under|below|<)\s*[\d,\.]+\s*(k|m)?/, "").match(/(?:amount\s*)?(over|above|>)\s*([\d,\.]+)\s*(k|m)?/);
  if (m) { const v = +m[2].replace(/,/g, "") * (m[3] === "k" ? 1e3 : m[3] === "m" ? 1e6 : 1); rows = rows.filter(l => Math.max(l.debit, l.credit) > v); applied.push(`amount > ${v.toLocaleString()}`); }
  if (/\bcredits?\b|money in|incoming/.test(text)) { rows = rows.filter(l => l.credit > 0); applied.push("credits"); }
  if (/\bdebits?\b|money out|outgoing|payments/.test(text)) { rows = rows.filter(l => l.debit > 0); applied.push("debits"); }
  for (const k of ["card", "cash", "fuel", "supplier", "service", "commission"]) if (new RegExp("\\b" + k).test(text)) { rows = rows.filter(l => l.kind === k); applied.push(k); }
  const rm = text.match(/\b(r-\d{2}-\d)\b/); if (rm) { rows = rows.filter(l => l.description.toLowerCase().includes(rm[1])); applied.push(rm[1].toUpperCase()); }
  return { rows, applied };
}

// ---------------------------------------------------------------- Validation
function validate(cfg, T, D, events) {
  const out = []; const chk = (group, check, ok, detail, warn) => out.push({ group, check, status: ok ? "pass" : (warn ? "warn" : "fail"), detail });
  const keys = { warehouses: "warehouse_id", routes: "route_id", machines: "machine_id", products: "product_id", slots: "slot_id", transactions: "txn_id", payments: "payment_id", restocks: "restock_id", maintenance_tickets: "ticket_id" };
  for (const [t, k] of Object.entries(keys)) { const s = new Set(T[t].map(r => r[k])); chk("schema", `${t}: primary key ${k} unique`, s.size === T[t].length, `${T[t].length.toLocaleString()} rows, ${T[t].length - s.size} duplicates`); }
  const fk = [["routes", "warehouse_id", "warehouses"], ["machines", "route_id", "routes"], ["slots", "machine_id", "machines"], ["slots", "product_id", "products"],
    ["transactions", "machine_id", "machines"], ["transactions", "slot_id", "slots"], ["transactions", "product_id", "products"], ["restocks", "route_id", "routes"],
    ["restocks", "slot_id", "slots"], ["payments", "machine_id", "machines"], ["telemetry", "machine_id", "machines"], ["maintenance_tickets", "machine_id", "machines"], ["maintenance_tickets", "route_id", "routes"]];
  for (const [t, c, p] of fk) { const ref = new Set(T[p].map(r => r[keys[p]])); const orph = T[t].filter(r => !ref.has(r[c])).length; chk("schema", `${t}.${c} → ${p}.${keys[p]}`, !orph, orph ? `${orph} orphan rows` : `all ${T[t].length.toLocaleString()} rows resolve`); }

  const slot = Object.fromEntries(T.slots.map(s => [s.slot_id, s])); const prod = Object.fromEntries(T.products.map(p => [p.product_id, p]));
  chk("business", "amount = qty × unit price", T.transactions.every(t => Math.abs(t.amount - t.qty * t.unit_price) < 0.005), `${T.transactions.length.toLocaleString()} vends checked`);
  chk("business", "vend price = catalogue price", T.transactions.every(t => t.unit_price === prod[t.product_id].unit_price), "every vend priced from products");
  chk("business", "vended product matches slot planogram", T.transactions.every(t => slot[t.slot_id].product_id === t.product_id && slot[t.slot_id].machine_id === t.machine_id), "slot → product → machine consistent");
  // inventory reconciliation
  let bad = 0, total = 0, bounds = 0; const first = cfg.startMs, last = cfg.startMs + (cfg.days * 24 - 1) * 3600000;
  const sold = {}, moved = {};
  for (const t of T.transactions) if (t.ts >= first && t.ts < last) sold[t.slot_id] = (sold[t.slot_id] || 0) + t.qty;
  for (const r of T.restocks) if (r.ts >= first && r.ts < last) moved[r.slot_id] = (moved[r.slot_id] || 0) + r.qty_added;
  for (const [mid, inv] of T._inv) { const H = inv.snap.length / inv.nS;
    for (let j = 0; j < inv.nS; j++) { total++; const sid = inv.slotIds[j]; const s0 = inv.snap[j], s1 = inv.snap[(H - 1) * inv.nS + j];
      if (s0 + (moved[sid] || 0) - (sold[sid] || 0) !== s1) bad++;
      for (let h = 0; h < H; h++) { const v = inv.snap[h * inv.nS + j]; if (v < 0 || v > slot[sid].capacity) bounds++; } } }
  chk("business", "0 ≤ stock ≤ slot capacity", !bounds, `${bounds} out-of-bound snapshots`);
  chk("business", "inventory reconciles: start + restocks − vends = end", !bad, bad ? `${bad} of ${total} slots off` : `all ${total.toLocaleString()} slots reconcile exactly`);
  const telIdx = new Map(); for (const r of T.telemetry) telIdx.set(r.machine_id + "|" + r.ts, r);
  let outV = 0, lockV = 0, cardV = 0;
  for (const t of T.transactions) { const r = telIdx.get(t.machine_id + "|" + (t.ts - (t.ts - cfg.startMs) % (STEP * MIN))); if (!r) continue;
    if (r.power_w === 0) outV++; if (prod[t.product_id].chilled && r.temp_c > LOCKOUT) lockV++; if (t.payment_method === "card" && !r.card_reader_ok) cardV++; }
  chk("business", "no vends while a machine has no power", !outV, `${outV} vends during 0 W intervals`);
  chk("business", "chilled items locked out above 8 °C", !lockV, `${lockV} chilled vends above 8 °C`);
  chk("business", "no card payments while the reader is down", !cardV, `${cardV} violations`);
  { const P = T.payments || []; const txById = new Map(T.transactions.map(t => [t.txn_id, t]));
    const approved = P.filter(p => p.status === "approved"), declined = P.filter(p => p.status === "declined");
    const orphan = approved.filter(p => !txById.has(p.txn_id)).length;
    chk("schema", "payments.txn_id → transactions.txn_id (approved only)", !orphan, orphan ? `${orphan} approved payments without a vend` : `${approved.length.toLocaleString()} approved payments resolve`);
    const perTx = new Map(); for (const p of approved) perTx.set(p.txn_id, (perTx.get(p.txn_id) || 0) + 1);
    const cardTx = T.transactions.filter(t => t.payment_method === "card");
    const unpaired = cardTx.filter(t => perTx.get(t.txn_id) !== 1).length, amtBad = approved.filter(p => txById.has(p.txn_id) && Math.abs(txById.get(p.txn_id).amount - p.amount) > 0.005).length;
    chk("business", "every cashless vend has exactly one approved payment of the same amount", !unpaired && !amtBad, `${cardTx.length.toLocaleString()} cashless vends, ${unpaired} unpaired, ${amtBad} amount mismatches`);
    chk("business", "declined payments never produce a vend", declined.every(p => !p.txn_id), `${declined.length} declined attempts`);
    chk("business", "channel on the vend matches the payment channel", approved.every(p => txById.get(p.txn_id)?.channel === p.channel), "QR, NFC, RFID and card channels consistent");
    let offBad = 0; for (const p of approved) { const r = telIdx.get(p.machine_id + "|" + (p.ts - (p.ts - cfg.startMs) % (STEP * MIN))); if (r && !r.card_reader_ok) offBad++; }
    chk("business", "no approved payments while the terminal is offline", !offBad, `${declined.filter(p => p.decline_reason === "terminal_offline").length} attempts declined as terminal_offline`);
  }
  const rOf = Object.fromEntries(T.machines.map(m => [m.machine_id, m.route_id]));
  chk("business", "ticket route = machine's route", T.maintenance_tickets.every(t => rOf[t.machine_id] === t.route_id), `${T.maintenance_tickets.length} tickets checked`);

  const txSum = {}; for (const t of T.transactions) txSum[t.machine_id] = (txSum[t.machine_id] || 0) + t.amount;
  const mism = D.invoice.filter(d => Math.abs(d.gross_sales - txSum[d.machine_id]) > 0.01).length;
  chk("documents", "invoice total = Σ machine transactions", !mism, `${D.invoice.length} invoices, ${mism} mismatches`);
  chk("documents", "cash + card = gross sales", D.invoice.every(d => Math.abs(d.cash_total + d.card_total - d.gross_sales) < 0.02), "payment split ties out");
  chk("documents", `${REGIONS[cfg.region].tax.label} breakdown adds up`, D.invoice.every(d => Math.abs(d.tax_included + d.net_of_tax - d.gross_sales) < 0.02), `${(REGIONS[cfg.region].tax.rate * 100).toFixed(2).replace(/\.?0+$/, "")}% applied`);
  chk("documents", "purchase orders cover every restocked unit", D.purchase_order.every(p => p.lines.every(l => l.order_units >= l.restocked_units)), `${D.purchase_order.length} POs`);
  const st = D.bank_statement[0];
  const cardSales = T.transactions.filter(t => t.payment_method === "card").reduce((x, t) => x + t.amount, 0);
  const cardCred = st.lines.filter(l => l.kind === "card").reduce((x, l) => x + l.credit, 0);
  chk("documents", "card settlements + pending = card sales", Math.abs(cardCred + st.pending_card_settlement - cardSales) < 0.05, `pending last-day settlement ${st.pending_card_settlement.toLocaleString()}`);
  { const P = (T.payments || []).filter(p => p.status === "approved"); const byM = {}; for (const p of P) byM[p.machine_id] = (byM[p.machine_id] || 0) + p.amount;
    const bad = D.invoice.filter(d => Math.abs((byM[d.machine_id] || 0) - d.card_total) > 0.01).length;
    chk("documents", "Σ approved payments = invoice cashless total", !bad, `${D.invoice.length} invoices, ${bad} mismatches`);
    const byBatch = {}; for (const p of P) byBatch[p.settlement_batch] = (byBatch[p.settlement_batch] || 0) + p.amount;
    const sl = st.lines.filter(l => l.kind === "card"); const bb = sl.filter(l => Math.abs((byBatch[l.ref] || 0) - l.credit) > 0.05).length;
    chk("documents", "each settlement batch on the statement = its approved payments", !bb, `${sl.length} batches reconciled`); }
  const cashSales = T.transactions.filter(t => t.payment_method === "cash").reduce((x, t) => x + t.amount, 0);
  const cashDep = st.lines.filter(l => l.kind === "cash").reduce((x, l) => x + l.credit, 0);
  chk("documents", "cash deposits + cash still in machines = cash sales", Math.abs(cashDep + st.cash_in_machines - cashSales) < 0.05, "every cash vend is banked or still in a coin box");
  const net = st.lines.reduce((x, l) => x + l.credit - l.debit, 0);
  chk("documents", "statement closing = opening + credits − debits", Math.abs(st.opening_balance + net - st.closing_balance) < 0.05, `${st.lines.length} statement lines`);

  const t0 = cfg.startMs;
  for (const ev of events.filter(e => !e.background)) {
    const a = t0 + ev.start_offset_h * 3600000, b = a + ev.duration_h * 3600000;
    let hit = affected(ev, T.machines);
    if (ev.type === "heatwave") { const cs = new Set(ev.targets.cities); T.machines.forEach(m => { if (hit.has(m.machine_id)) cs.add(m.city); }); hit = new Set(T.machines.filter(m => cs.has(m.city)).map(m => m.machine_id)); }
    const w = T.telemetry.filter(r => hit.has(r.machine_id) && r.ts >= a && r.ts < b); const label = "scenario: " + ev.label;
    if (!w.length) { chk("scenario", label, false, "no telemetry for targets in window"); continue; }
    if (ev.type === "compressor_failure") { const pk = Math.max(...w.map(r => r.temp_c)); chk("scenario", label, pk > LOCKOUT, `peak cabinet ${pk.toFixed(1)} °C`); }
    else if (ev.type === "power_outage") { const sh = w.filter(r => r.power_w === 0).length / w.length; chk("scenario", label, sh > 0.95, `${Math.round(sh * 100)}% of intervals at 0 W`); }
    else if (ev.type === "heatwave") { const outside = T.telemetry.filter(r => hit.has(r.machine_id) && (r.ts < a || r.ts >= b)); const base = outside.reduce((x, r) => x + r.ambient_c, 0) / Math.max(1, outside.length); const d = w.reduce((x, r) => x + r.ambient_c, 0) / w.length - base; chk("scenario", label, d > 1, `ambient +${d.toFixed(1)} °C vs outside the window`); }
    else if (ev.type === "demand_spike") { const vt = T.transactions.filter(t => hit.has(t.machine_id)); const ins = vt.filter(t => t.ts >= a && t.ts < b).length / Math.max(1, ev.duration_h); const outs = vt.filter(t => t.ts < a || t.ts >= b).length / Math.max(1, cfg.days * 24 - ev.duration_h); const ratio = ins / Math.max(outs, 1e-9); chk("scenario", label, ratio > 1.3, `vend rate ×${ratio.toFixed(2)} vs baseline`, ratio > 1.05); }
    else if (ev.type === "restock_delay") { const n = T.restocks.filter(r => hit.has(r.machine_id) && r.ts >= a && r.ts < b && r.reason === "scheduled").length; chk("scenario", label, !n, `${n} scheduled restocks in the delay window`); }
    else if (ev.type === "card_reader_failure") { const n = T.transactions.filter(t => hit.has(t.machine_id) && t.ts >= a && t.ts < b && t.payment_method === "card").length; chk("scenario", label, !n, `${n} card vends in window; cash only`); }
    else if (ev.type === "door_left_open") chk("scenario", label, w.some(r => r.door_open), `door sensor on, peak ${Math.max(...w.map(r => r.temp_c)).toFixed(1)} °C`);
  }
  const pats = { email: /[\w.+-]+@[\w-]+\.[\w.]+/, phone: /(?:\+\d{1,3}[\s-]?)?\(?\d{3,4}\)?[\s-]\d{3}[\s-]?\d{4}\b/, "national ID": /\b\d{5}-\d{7}-\d\b|\b\d{3}-\d{2}-\d{4}\b/, "card number": /\b\d{13,19}\b/ };
  const strings = []; for (const t of ["warehouses", "routes", "machines", "maintenance_tickets"]) for (const r of T[t]) for (const v of Object.values(r)) if (typeof v === "string") strings.push(v);
  for (const t of T.transactions) if (t.card_token) strings.push(t.card_token);
  for (const [k, p] of Object.entries(pats)) { const n = strings.filter(s => p.test(s)).length; chk("privacy", `no ${k} patterns in any table`, !n, `${n} matches in ${strings.length.toLocaleString()} text values`); }
  chk("privacy", "card identifiers are surrogates", T.transactions.every(t => !t.card_token || /^tok_[0-9a-f]{12}$|^•••• \d{4}$/.test(t.card_token)), cfg.privacy.tokens === "masked" ? "masked last-4 only, no full numbers" : "random tokens, not derived from card data");
  return out;
}

// ---------------------------------------------------------------- Pipeline
function generate(cfgIn, rawEvents) {
  const t0 = Date.now();
  const cfg = Object.assign({ region: "PK", nWh: 3, nRt: 3, nMc: 5, days: 7, seed: 42, cardShare: 0.55, background: true,
    privacy: { names: "codes", jitter: true, tokens: "tokens" }, startMs: Date.UTC(2026, 5, 1) }, cfgIn);
  const R = rngFactory(cfg.seed);
  // Resolve "@depot1" placeholder city before normalising
  const cityNames = Object.keys(REGIONS[cfg.region].cities);
  const R0 = rngFactory(cfg.seed + 1);
  const depot1 = R0.pick(cityNames);
  let events = rawEvents.map(e => { const c = JSON.parse(JSON.stringify(e)); if (c.targets && c.targets.cities) c.targets.cities = c.targets.cities.map(x => x === "@depot1" ? depot1 : x); return normalizeEvent(c, cfg); });
  const reservedIds = [...new Set(events.flatMap(e => e.targets.machine_ids))];
  const reservedCities = [...new Set(events.flatMap(e => e.targets.cities))];
  const reservedLocs = [...new Set(events.flatMap(e => e.targets.location_types))];
  const M = buildMaster(cfg, R, reservedIds, reservedCities, reservedLocs);
  const all = events.concat(cfg.background ? backgroundEvents(cfg, M.machines, R).map(e => normalizeEvent(e, cfg)) : []);
  const S = simulate(cfg, M, all, R);
  const tickets = deriveTickets(cfg, M, S, R);
  const T = Object.assign({}, M, { transactions: S.tx, payments: S.payments, restocks: S.restocks, telemetry: S.tel, maintenance_tickets: tickets, _inv: S.invSnap, _collections: S.collections });
  const D = buildDocuments(cfg, T);
  const V = validate(cfg, T, D, all);
  return { cfg, events: all, T, D, V, lost: S.lost, ms: Date.now() - t0 };
}

function impact(ds) {
  const { cfg, T } = ds; const out = [];
  for (const ev of ds.events.filter(e => !e.background)) {
    const a = cfg.startMs + ev.start_offset_h * 3600000, b = a + ev.duration_h * 3600000;
    let hit = affected(ev, T.machines);
    if (ev.type === "heatwave") { const cs = new Set(ev.targets.cities); T.machines.forEach(m => { if (hit.has(m.machine_id)) cs.add(m.city); }); hit = new Set(T.machines.filter(m => cs.has(m.city)).map(m => m.machine_id)); }
    const tk = T.maintenance_tickets.filter(t => hit.has(t.machine_id) && t.opened_at >= a - 3600000 && t.opened_at < b + 7200000);
    const tel = T.telemetry.filter(r => hit.has(r.machine_id) && r.ts >= a && r.ts < b);
    out.push({ ev, a, b, machines: hit.size, tickets: tk.length, lost: tk.reduce((x, t) => x + t.lost_vends, 0), risk: tk.reduce((x, t) => x + t.est_lost_revenue, 0),
      peakT: tel.length ? Math.max(...tel.map(r => r.temp_c)) : null, peakA: tel.length ? Math.max(...tel.map(r => r.ambient_c)) : null });
  }
  return out;
}

// ---------------------------------------------------------------- Formatting
function fmtDate(ms, region) { const d = new Date(ms); const dd = String(d.getUTCDate()).padStart(2, "0"), mm = String(d.getUTCMonth() + 1).padStart(2, "0"), yy = d.getUTCFullYear();
  const reg = REGIONS[region || "PK"]; return reg.dateFmt === "mdy" ? `${mm}${reg.sep}${dd}${reg.sep}${yy}` : `${dd}${reg.sep}${mm}${reg.sep}${yy}`; }
function fmtTime(ms) { const d = new Date(ms); return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0"); }
function fmtMoney(x, region, compact) { const reg = REGIONS[region || "PK"];
  if (compact && Math.abs(x) >= 1e6) return reg.currency + " " + (x / 1e6).toFixed(2) + "M";
  if (compact && Math.abs(x) >= 1e4) return reg.currency + " " + (x / 1e3).toFixed(1) + "K";
  return reg.currency + " " + x.toLocaleString("en-US", { minimumFractionDigits: reg.dec, maximumFractionDigits: reg.dec }); }

// ---------------------------------------------------------------- Bring-your-own data: schema inference + synthesis
function parseCSV(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); cur = ""; if (row.some(v => v !== "")) rows.push(row); row = []; }
    else cur += c; }
  row.push(cur); if (row.some(v => v !== "")) rows.push(row);
  const header = rows.shift() || []; return { header: header.map(h => h.trim()), rows: rows.map(r => header.map((_, i) => (r[i] ?? "").trim())) };
}
const isNull = v => v === "" || /^(null|na|n\/a|none|nan)$/i.test(v);
function inferSchema(csv) {
  const cols = csv.header.map((name, ci) => {
    const vals = csv.rows.map(r => r[ci]); const nn = vals.filter(v => !isNull(v)); const n = nn.length; const uniq = new Set(nn); const lname = name.toLowerCase();
    let type = "text", detail = "";
    const num = nn.every(v => /^-?[\d,]*\.?\d+$/.test(v.replace(/[$£€]|pkr|usd|eur|gbp/gi, "").trim()));
    const isInt = num && nn.every(v => /^-?[\d,]+$/.test(v.replace(/[$£€]|pkr|usd|eur|gbp/gi, "").trim()));
    const date = nn.every(v => /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,2}[\/.]\d{1,2}[\/.]\d{4}$/.test(v));
    if (n && nn.every(v => /^[\w.+-]+@[\w-]+\.[\w.]+$/.test(v))) type = "email";
    else if (n && nn.every(v => /^[+\d][\d\s()-]{6,}$/.test(v)) && /phone|mobile|tel/.test(lname)) type = "phone";
    else if (date && n) type = "date";
    else if (/(^|_)id$|^id|code$/.test(lname) && uniq.size === n && n) type = "id";
    else if (/_id$/.test(lname) && n) type = "foreign_key";
    else if (num && n) type = isInt ? "integer" : "decimal";
    else if (/name/.test(lname) && uniq.size > n * 0.6) type = "person_name";
    else if (n && (uniq.size <= Math.max(12, n * 0.5))) type = "category";
    const prefix = type === "id" ? (nn[0].match(/^[^\d]*/) || [""])[0] : "";
    return { name, type, nulls: vals.length - n, n, unique: uniq.size, prefix, sensitive: ["email", "phone", "person_name"].includes(type) };
  });
  const pk = cols.find(c => c.type === "id"); if (pk) pk.pk = true;
  return cols;
}
function toNum(v) { return +String(v).replace(/[^\d.-]/g, ""); }
function synthesize(csv, schema, opts) {
  const R = rngFactory(opts.seed || 7); const N = opts.rows; const out = [];
  const colData = schema.map((c, ci) => { const vals = csv.rows.map(r => r[ci]).filter(v => !isNull(v)); return { c, vals }; });
  const prep = colData.map(({ c, vals }) => {
    if (c.type === "integer" || c.type === "decimal") { const xs = vals.map(toNum); const mean = xs.reduce((a, b) => a + b, 0) / xs.length; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) || 1;
      const dec = c.type === "decimal" ? Math.max(...vals.map(v => (v.split(".")[1] || "").length)) : 0; const cur = (vals[0].match(/^[^\d-]*/) || [""])[0];
      return { xs, mean, sd, min: Math.min(...xs), max: Math.max(...xs), dec, cur }; }
    if (c.type === "date") { const ts = vals.map(v => /^\d{4}/.test(v) ? Date.parse(v.slice(0, 10)) : (() => { const [a, b, y] = v.split(/[\/.]/); return Date.UTC(+y, +b - 1, +a); })()); return { ts, iso: /^\d{4}/.test(vals[0]) }; }
    if (c.type === "id") { const nums = vals.map(v => toNum(v.slice(c.prefix.length))); return { start: Math.max(...nums) + 1, width: vals[0].length - c.prefix.length }; }
    const freq = {}; for (const v of vals) freq[v] = (freq[v] || 0) + 1; return { keys: Object.keys(freq), w: Object.values(freq) };
  });
  const nullRate = schema.map(c => c.nulls / Math.max(1, c.nulls + c.n));
  const used = new Set();
  for (let i = 0; i < N; i++) {
    const given = R.pick(GIVEN), family = R.pick(FAMILY); const row = [];
    schema.forEach((c, ci) => {
      const p = prep[ci];
      if (!c.pk && R.next() < nullRate[ci] + opts.nullRate) { row.push(""); return; }
      let v;
      if (c.type === "id") v = c.prefix + String(p.start + i).padStart(p.width, "0");
      else if (c.type === "integer" || c.type === "decimal") {
        let x = p.xs[Math.floor(R.next() * p.xs.length)] + R.normal(0, p.sd * 0.25);
        if (opts.epsilon > 0) { const scale = (p.max - p.min) / opts.epsilon / 20; const u = R.next() - 0.5; x += -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u)); }
        if (R.next() < opts.outlierRate) x = p.mean + p.sd * (R.next() < 0.5 ? -1 : 1) * R.uni(4, 6);
        else x = Math.min(p.max, Math.max(p.min, x));
        v = p.cur + x.toFixed(p.dec);
      } else if (c.type === "date") { const base = p.ts[Math.floor(R.next() * p.ts.length)] + Math.round(R.normal(0, 6)) * DAY; const d = new Date(base);
        v = p.iso ? d.toISOString().slice(0, 10) : `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`; }
      else if (c.type === "email") v = `${given}.${family}${R.int(1, 99)}`.toLowerCase() + "@example.com";
      else if (c.type === "phone") v = `+1-555-01${String(R.int(0, 100)).padStart(2, "0")}`;
      else if (c.type === "person_name") v = `${given} ${family}`;
      else if (c.type === "text") v = p.keys[R.pickW(p.w)];
      else v = p.keys[R.pickW(p.w)];
      if (opts.mask && c.sensitive) v = c.type === "email" ? v.replace(/^(.).*(@.*)$/, "$1•••$2") : c.type === "phone" ? v.replace(/\d(?=\d{2})/g, "•") : v.split(" ").map(w => w[0] + "•••").join(" ");
      row.push(v);
    });
    out.push(row);
  }
  const srcRows = new Set(csv.rows.map(r => r.join("|"))); const copies = out.filter(r => srcRows.has(r.join("|"))).length;
  return { header: csv.header, rows: out, copies };
}
function fidelity(csv, syn, schema) {
  const res = [];
  schema.forEach((c, ci) => {
    const a = csv.rows.map(r => r[ci]).filter(v => !isNull(v)), b = syn.rows.map(r => r[ci]).filter(v => !isNull(v));
    if (c.type === "integer" || c.type === "decimal") {
      const st = xs => { const m = xs.reduce((x, y) => x + y, 0) / xs.length; return [m, Math.sqrt(xs.reduce((x, y) => x + (y - m) ** 2, 0) / xs.length)]; };
      const [ma, sa] = st(a.map(toNum)), [mb, sb] = st(b.map(toNum));
      const score = Math.max(0, 1 - Math.abs(ma - mb) / (sa || 1) / 2 - Math.abs(sa - sb) / (sa || 1) / 2);
      res.push({ col: c.name, kind: "numeric", real: `mean ${ma.toFixed(1)} · sd ${sa.toFixed(1)}`, synth: `mean ${mb.toFixed(1)} · sd ${sb.toFixed(1)}`, score });
    } else if (c.type === "category" || c.type === "foreign_key") {
      const fa = {}, fb = {}; a.forEach(v => fa[v] = (fa[v] || 0) + 1 / a.length); b.forEach(v => fb[v] = (fb[v] || 0) + 1 / b.length);
      const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]); let tv = 0; keys.forEach(k => tv += Math.abs((fa[k] || 0) - (fb[k] || 0))); tv /= 2;
      const top = Object.entries(fa).sort((x, y) => y[1] - x[1])[0];
      res.push({ col: c.name, kind: "categorical", real: `top “${top[0]}” ${(top[1] * 100).toFixed(0)}%`, synth: `top share ${((fb[top[0]] || 0) * 100).toFixed(0)}%`, score: 1 - tv });
    } else if (c.type === "date") {
      const ta = a.map(v => Date.parse(/^\d{4}/.test(v) ? v : v.split(/[\/.]/).reverse().join("-"))), tb = b.map(v => Date.parse(/^\d{4}/.test(v) ? v : v.split(/[\/.]/).reverse().join("-")));
      const span = x => [Math.min(...x), Math.max(...x)]; const [a0, a1] = span(ta), [b0, b1] = span(tb);
      res.push({ col: c.name, kind: "date range", real: `${new Date(a0).toISOString().slice(0, 10)} → ${new Date(a1).toISOString().slice(0, 10)}`, synth: `${new Date(b0).toISOString().slice(0, 10)} → ${new Date(b1).toISOString().slice(0, 10)}`, score: Math.max(0, 1 - (Math.abs(a0 - b0) + Math.abs(a1 - b1)) / (2 * (a1 - a0 || DAY) * 1.5)) });
    }
  });
  return res;
}


// ---------------------------------------------------------------- Schema metadata (drives the Schema inspector)
// Column: [name, type, constraints[], description]. Constraint kinds: pk, fk:<table.col>, notnull, unique,
// range:<min>:<max>, enum:<a|b>, nullable, rule:<plain-language cross-table rule>.
const SCHEMA = {
  warehouses: { grain: "one row per depot", layer: "Relational", generatedBy: "Fleet builder", derivedFrom: [],
    desc: "Regional depots that hold stock and dispatch delivery routes.",
    cols: [["warehouse_id", "string", ["pk", "notnull"], "W-01, W-02 …"], ["name", "string", ["notnull"], "Depot display name"],
      ["city", "string", ["notnull", "enum:region cities"], "One of the selected region's cities"], ["lat", "float", ["range:-90:90"], "Latitude (jittered if the privacy rule is on)"],
      ["lon", "float", ["range:-180:180"], "Longitude"], ["capacity_units", "integer", ["range:20000:59000"], "Storage capacity in units"]] },
  routes: { grain: "one row per delivery route", layer: "Relational", generatedBy: "Fleet builder", derivedFrom: [],
    desc: "Delivery routes; each belongs to one warehouse and is serviced on fixed weekdays.",
    cols: [["route_id", "string", ["pk", "notnull"], "R-<depot>-<n>"], ["warehouse_id", "string", ["fk:warehouses.warehouse_id", "notnull"], "Owning depot"],
      ["route_name", "string", ["notnull"], "Display name"], ["driver", "string", ["notnull"], "DRV-### code or synthetic name, per privacy rule"],
      ["service_days", "string", ["notnull"], "Restock weekdays, e.g. Mon,Thu"], ["vehicle", "string", ["notnull"], "Van code"]] },
  machines: { grain: "one row per vending machine", layer: "Relational", generatedBy: "Fleet builder", derivedFrom: [],
    desc: "Smart vending machines; each sits at one stop on one route.",
    cols: [["machine_id", "integer", ["pk", "notnull", "range:1:99999"], "Machine number; ids named in a prompt are guaranteed to exist"],
      ["route_id", "string", ["fk:routes.route_id", "notnull"], "Route serving this machine"], ["route_stop", "integer", ["range:1:10"], "Order of the stop on the route"],
      ["site_name", "string", ["notnull"], "Synthetic site label"], ["location_type", "string", ["enum:university|hospital|office|mall|metro_station|petrol_station"], "Drives demand profile and planogram"],
      ["city", "string", ["notnull", "rule:equals the city of the route's warehouse"], "Machine city"], ["lat", "float", ["range:-90:90"], "Latitude"], ["lon", "float", ["range:-180:180"], "Longitude"],
      ["model", "string", ["enum:ColdVend CV-24|ColdVend CV-30|ComboVend CB-24"], "Hardware model; sets power draw and slot count"],
      ["install_date", "datetime", ["rule:before the simulation start"], "Installation date"], ["slot_count", "integer", ["enum:24|30"], "Number of spiral slots"]] },
  products: { grain: "one row per SKU", layer: "Relational", generatedBy: "Catalogue", derivedFrom: [],
    desc: "Product catalogue shared by the fleet; prices are converted to the region's currency.",
    cols: [["product_id", "string", ["pk", "notnull"], "SKU"], ["name", "string", ["notnull"], "Product name"],
      ["category", "string", ["enum:beverage|dairy|snack|confectionery|bakery|fresh_food"], "Category; dairy and fresh food are perishable"],
      ["unit_cost", "float", ["range:0:100000"], "Supplier cost"], ["unit_price", "float", ["range:0:100000", "rule:greater than unit_cost"], "Shelf price, tax included"],
      ["chilled", "boolean", ["notnull"], "Locks out above 8 °C"]] },
  slots: { grain: "one row per spiral slot", layer: "Relational", generatedBy: "Planogram builder", derivedFrom: ["machines", "products"],
    desc: "Slots inside a machine; each holds one product. Location type shapes the product mix.",
    cols: [["slot_id", "string", ["pk", "notnull"], "<machine>-<code>"], ["machine_id", "integer", ["fk:machines.machine_id", "notnull"], "Machine"],
      ["slot_code", "string", ["notnull"], "A1 … E6"], ["product_id", "string", ["fk:products.product_id", "notnull"], "Product stocked"],
      ["capacity", "integer", ["range:6:15"], "Maximum units"], ["par_level", "integer", ["rule:at most capacity"], "Reorder threshold"]] },
  transactions: { grain: "one row per vend", layer: "Tabular", generatedBy: "Fleet simulator (demand model)", derivedFrom: ["slots", "products", "telemetry"],
    desc: "Individual vends. Demand follows site type, hour, weekday, heat and injected spikes; lockouts and outages suppress sales.",
    cols: [["txn_id", "string", ["pk", "notnull"], "TX-0000001 …, in time order"], ["ts", "datetime", ["notnull", "rule:inside the simulated period"], "Vend time"],
      ["machine_id", "integer", ["fk:machines.machine_id", "notnull"], "Machine"], ["slot_id", "string", ["fk:slots.slot_id", "notnull", "rule:slot belongs to machine_id"], "Slot"],
      ["product_id", "string", ["fk:products.product_id", "notnull", "rule:equals the slot's product"], "Product"], ["qty", "integer", ["range:1:2"], "Units"],
      ["unit_price", "float", ["rule:equals products.unit_price"], "Price per unit"], ["amount", "float", ["rule:equals qty × unit_price"], "Line value"],
      ["payment_method", "string", ["enum:card|cash"], "card = any cashless channel; none while the terminal is offline"],
      ["channel", "string", ["enum:cash|qr_code|mobile_nfc|rfid_card|contactless_card", "rule:matches the approved payment's channel"], "How the customer paid"], ["card_token", "string", ["nullable", "rule:empty for cash"], "Random surrogate, never a card number"]] },
  payments: { grain: "one row per cashless payment attempt", layer: "Tabular", generatedBy: "Payment terminal simulator", derivedFrom: ["transactions", "telemetry"],
    desc: "QR code, mobile NFC wallet, RFID card and contactless card attempts. Approved attempts link to exactly one vend; declined ones never do.",
    cols: [["payment_id", "string", ["pk", "notnull"], "PM-0000001 …"], ["ts", "datetime", ["notnull", "rule:approved before its vend"], "Authorisation time"],
      ["machine_id", "integer", ["fk:machines.machine_id", "notnull"], "Machine"], ["txn_id", "string", ["nullable", "rule:set only when approved; resolves to transactions"], "Vend paid for"],
      ["channel", "string", ["enum:qr_code|mobile_nfc|rfid_card|contactless_card"], "Cashless channel"], ["provider", "string", ["notnull"], "Synthetic processor"],
      ["token", "string", ["notnull"], "Random surrogate or masked last-4, never a real identifier"], ["amount", "float", ["range:0:100000", "rule:equals the vend amount"], "Charged amount"],
      ["status", "string", ["enum:approved|declined"], "Outcome"], ["decline_reason", "string", ["nullable"], "terminal_offline, insufficient_funds, network_timeout …"],
      ["auth_code", "string", ["nullable"], "6-character approval code"], ["settlement_batch", "string", ["nullable", "rule:matches a settlement line on the bank statement"], "ACQ-<day>"],
      ["latency_ms", "integer", ["range:0:10000"], "Terminal round trip"]] },
  restocks: { grain: "one row per slot movement", layer: "Tabular", generatedBy: "Fleet simulator (route visits, spoilage)", derivedFrom: ["routes", "slots"],
    desc: "Scheduled refills (+) by drivers and perishable write-offs (−) after a warm spell.",
    cols: [["restock_id", "string", ["pk", "notnull"], "RS-000001 …"], ["ts", "datetime", ["notnull"], "Visit or write-off time"],
      ["route_id", "string", ["fk:routes.route_id", "notnull"], "Route"], ["machine_id", "integer", ["fk:machines.machine_id", "notnull"], "Machine"],
      ["slot_id", "string", ["fk:slots.slot_id", "notnull"], "Slot"], ["product_id", "string", ["fk:products.product_id", "notnull"], "Product"],
      ["qty_added", "integer", ["notnull"], "Negative for write-offs"], ["stock_before", "integer", ["range:0:15"], "Stock before"],
      ["stock_after", "integer", ["range:0:15", "rule:stock_before + qty_added"], "Stock after"], ["reason", "string", ["enum:scheduled|spoilage_writeoff"], "Why stock moved"]] },
  telemetry: { grain: "one row per machine per 15 minutes", layer: "Tabular", generatedBy: "Thermal and electrical model", derivedFrom: ["machines", "slots"],
    key: "machine_id + ts", desc: "IoT telemetry. Every row is labelled with the events active at that time.",
    cols: [["ts", "datetime", ["notnull"], "Interval start"], ["machine_id", "integer", ["fk:machines.machine_id", "notnull"], "Machine"],
      ["ambient_c", "float", ["range:-10:60"], "Outside or indoor air temperature"], ["temp_c", "float", ["range:-5:60"], "Cabinet temperature; above 8 °C locks chilled slots"],
      ["compressor_on_pct", "float", ["range:0:100"], "Compressor duty"], ["compressor_cycles", "integer", ["range:0:20"], "Starts in the interval; 6+ means short-cycling"],
      ["power_w", "float", ["range:0:1000"], "0 W means no power"], ["door_open", "boolean", ["notnull"], "Door sensor"],
      ["card_reader_ok", "boolean", ["notnull"], "Card terminal state"], ["total_stock", "integer", ["range:0:500", "rule:sum of slot stock"], "Units in the machine"],
      ["active_events", "string", ["nullable"], "Ground-truth labels for anomaly detection"]] },
  inventory: { grain: "one row per slot per hour", layer: "Tabular", generatedBy: "Derived from vends and restocks", derivedFrom: ["transactions", "restocks", "slots"],
    key: "slot_id + ts", desc: "Hourly stock snapshots; reconcile exactly with vends and restocks.",
    cols: [["ts", "datetime", ["notnull"], "Snapshot hour"], ["machine_id", "integer", ["fk:machines.machine_id", "notnull"], "Machine"],
      ["slot_id", "string", ["fk:slots.slot_id", "notnull"], "Slot"], ["stock", "integer", ["range:0:15", "rule:start + restocks − vends"], "Units in the slot"]] },
  maintenance_tickets: { grain: "one row per detected incident", layer: "Tabular", generatedBy: "Anomaly detector over telemetry", derivedFrom: ["telemetry", "machines", "restocks"],
    desc: "Opened automatically when telemetry shows a sustained fault.",
    cols: [["ticket_id", "string", ["pk", "notnull"], "MT-00001 …"], ["machine_id", "integer", ["fk:machines.machine_id", "notnull"], "Machine"],
      ["route_id", "string", ["fk:routes.route_id", "notnull", "rule:equals the machine's route"], "Route"], ["opened_at", "datetime", ["notnull"], "Detection time"],
      ["closed_at", "datetime", ["notnull", "rule:after opened_at"], "Repair confirmed"], ["fault_type", "string", ["enum:Refrigeration failure|Door left open|Power loss|Payment terminal fault"], "Fault"],
      ["priority", "string", ["enum:P1|P2|P3"], "Severity"], ["technician", "string", ["notnull"], "Code or synthetic name"],
      ["evidence", "string", ["notnull"], "Telemetry evidence text"], ["lost_vends", "integer", ["range:0:100000"], "Customers turned away"], ["est_lost_revenue", "float", ["range:0:1e9"], "lost_vends × average slot price"]] },
};
const DOC_LINEAGE = {
  invoice: { from: ["transactions", "payments", "machines"], fields: [["lines[].amount", "Σ transactions.amount per product"], ["gross_sales", "Σ transactions.amount for the machine"], ["card_total", "Σ approved payments.amount for the machine"], ["channels.*", "Σ vends per cashless channel"], ["tax_included", "gross × rate ÷ (1 + rate)"], ["site_commission", "12% of gross"]] },
  purchase_order: { from: ["restocks", "products", "routes", "warehouses"], fields: [["restocked_units", "Σ scheduled restocks.qty_added per product per depot"], ["order_units", "restocked × 1.1, rounded up to case packs"], ["total_amount", "subtotal + tax"]] },
  service_ticket: { from: ["maintenance_tickets", "machines", "routes"], fields: [["evidence", "Summary of the telemetry run"], ["warehouse_id", "via routes.warehouse_id"]] },
  bank_statement: { from: ["payments", "transactions", "restocks", "maintenance_tickets", "purchase_order", "invoice"], fields: [["Cashless settlement", "Σ approved payments in batch ACQ-n"], ["Cash deposit", "cash collected at restock visits"], ["Supplier payment", "purchase order totals"], ["Field service", "one per closed ticket"]] },
};

// Short, stable fingerprint of a generated dataset, used to prove a restored checkpoint is identical.
function fingerprint(ds) {
  let h = 0x811c9dc5; const mix = (s) => { s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } };
  const T = ds.T; mix(T.machines.map(m => m.machine_id).join(","));
  for (let i = 0; i < T.transactions.length; i += 7) { const t = T.transactions[i]; mix(t.ts + t.slot_id + t.amount); }
  for (let i = 0; i < T.telemetry.length; i += 11) mix(T.telemetry[i].temp_c);
  mix(T.restocks.length); mix((T.payments || []).length); mix(T.maintenance_tickets.map(t => t.ticket_id + t.machine_id).join());
  mix(ds.D.bank_statement[0].closing_balance);
  return h.toString(16).padStart(8, "0");
}

root.VG = { REGIONS, LOCATION_TYPES, EVENT_TYPES, EXAMPLES, generate, parseIntent, normalizeEvent, impact, queryStatement, fmtDate, fmtTime, fmtMoney,
  parseCSV, inferSchema, synthesize, fidelity, DAY, STEP, SCHEMA, DOC_LINEAGE, fingerprint, CHANNELS };
})(typeof window !== "undefined" ? window : globalThis);
