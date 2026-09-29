# Mrs Vendy — Synthetic Data Platform for Smart Vending Fleets

**HackDataV2 submission.** VendGen generates realistic, schema-aware, privacy-safe data for a network of smart vending machines — IoT telemetry, a full supply-chain database, and matching business documents — all from **one simulation**, so every table and every PDF agrees with every other. Describe an edge case in plain English ("*compressor failure on Machine #404 during a heatwave*") and the platform injects it, shows its business impact, and **proves** the result is consistent with 55+ automated checks.

```
Prompt ──► Intent parser (Claude or offline rules) ──► Event plan (human-editable)
                                                            │
     ┌──────────────────────────────────────────────────────┘
     ▼
Relational master data ──► Time-stepped fleet simulator ──► Tickets from telemetry anomalies
(warehouses→routes→         (telemetry, vends, restocks,        │
 machines→slots, products)   inventory, spoilage — one clock)    ▼
                                                   Documents (invoices, POs, service tickets, PDF)
                                                            │
                                                            ▼
                               Validator: schema · business rules · documents · scenario · privacy
                                                            │
                                     ┌──────────────────────┴───────────────────┐
                                     ▼                                          ▼
                              Streamlit UI (app.py)                     FastAPI (api/main.py)
```

---

## 1. Tech stack (and why)

| Layer | Choice | Why it wins a hackathon |
|---|---|---|
| Engine | **Python + NumPy + pandas** | Fast to write, vectorised where it matters, one language end to end |
| UI | **Streamlit** | A polished, interactive app in one file; free one-click hosting on Streamlit Community Cloud |
| API | **FastAPI** | Typed endpoints and auto-generated Swagger docs at `/docs` for the "working APIs" criterion |
| Documents | **ReportLab** | Pure-Python PDFs, no system dependencies, deploys anywhere |
| Charts | **Plotly** | Interactive hover, zoom, map |
| AI layer | **Claude via the Messages API** (optional) + **deterministic rule parser** | Works with or without a key; never breaks during a live demo |
| Deploy | **Docker**, `render.yaml`, Streamlit Cloud | Same image serves UI or API via `SERVICE=ui|api` |

The UI and the API share the same `engine/` package, so there is exactly one implementation of the logic.

---

## 2. File structure

```
vendgen/
├── app.py                  # Streamlit UI (6 tabs)
├── api/
│   └── main.py             # FastAPI REST API
├── engine/
│   ├── config.py           # Region data (cities, products, site types), GenConfig
│   ├── schema.py           # Declarative schema: columns, PKs, FKs → drives validation
│   ├── scenarios.py        # AI layer: event model, rule parser, LLM parser, fallback
│   ├── generator.py        # Relational master data + simulator + ticket detection
│   ├── documents.py        # Invoices / POs / service tickets + PDF rendering
│   ├── validate.py         # Trust layer: 55+ consistency and privacy checks
│   └── pipeline.py         # generate_dataset() → Dataset (summary, impact, ZIP export)
├── tests/test_engine.py    # pytest smoke tests (parser, checks, PDFs, API, PII scan)
├── .streamlit/config.toml  # Theme
├── requirements.txt
├── Dockerfile · docker-compose.yml · render.yaml
└── .env.example
```

---

## 3. How the three data types are generated together

The key design decision: **don't generate tables independently and then try to reconcile them.** Build the relational skeleton, then run one clock over it. Consistency falls out by construction.

### Step 1 — Relational skeleton (`generator.build_master`)

```
warehouses (W-01)          1 ─┐
routes     (R-01-2)          N ◄┘ 1 ─┐
machines   (#404)                  N ◄┘ 1 ─┐
slots      (404-B3) ◄── N products (BEV-003)  N ◄┘ 1 ─┬─► transactions
                                                    ├─► restocks
                                                    └─► inventory (hourly)
machines ─► telemetry (15-min), maintenance_tickets
```

- 3 warehouses × 3 routes × 5 machines = 45 machines, 1,200 slots by default (all sliders in the UI).
- Planograms are location-aware: hospitals and offices stock more fresh food; metro stations more drinks.
- **Any machine number, city or site type named in the prompt is guaranteed to exist** in the generated fleet.

### Step 2 — One simulation clock (`generator.simulate`)

For every machine, every 15 minutes:

1. **Hourly inventory snapshot** of every slot.
2. **Scheduled restock** if the route's driver reaches this stop now (Mon/Thu etc., 09:10 + 18 min per stop) — unless a `restock_delay` or outage is active.
3. **Thermal model** — first-order: cabinet temperature relaxes toward a target. Healthy → 4 °C setpoint, compressor duty rises with ambient heat. Failure → drifts to ambient (τ = 3 h). Gradual failures **short-cycle** at 100 % duty and high power, then **trip on overload** (power drops to idle) — exactly the signature a real technician looks for.
4. **Food-safety lockout** — chilled slots cannot vend above 8 °C. After a warm spell of 2 h+, perishables are **written off** (a negative `restocks` row with `reason = spoilage_writeoff`).
5. **Demand** — Poisson arrivals: site-type base rate × hour-of-day profile × weekday factor × heat effect × any demand spike. Each customer picks a slot by popularity; empty or locked slot → 50 % substitute, else a **lost vend**. Card reader down → most card customers walk away.
6. **Telemetry row** — ambient, cabinet temp, compressor duty & cycles, power, door, card reader, total stock, and **`active_events` labels** (ready-made ground truth for anomaly-detection training).

### Step 3 — Tickets and documents (`derive_tickets`, `documents.build_documents`)

- **Maintenance tickets** are *detected* from telemetry runs (temp > 8 °C for 30 min+, 0 W, card reader down for 1 h+), with evidence text, priority, lost vends and revenue at risk. Door-open vs. refrigeration failure is inferred from the door sensor.
- **Sales invoices** — one per machine: line items aggregated from `transactions`, so **invoice total = Σ transactions**, with cash/card split and site commission.
- **Purchase orders** — one per warehouse: every unit its routes restocked + 10 % safety stock, rounded up to case packs.
- **Service tickets** — one per ticket, joined to machine, route and depot, with a technician checklist.

### Step 4 — Validation (`validate.py`)

| Group | Examples |
|---|---|
| Schema | columns match, PKs unique, **every FK resolves** (driven by `schema.py`) |
| Business | amount = qty × price; vend price = catalogue; slot ↔ product ↔ machine; 0 ≤ stock ≤ capacity; **start + restocks − vends = end for every slot**; no vends at 0 W; no chilled vends above 8 °C; no card vends while reader is down |
| Documents | invoice total = Σ transactions; lines sum; cash + card = gross; PO covers restocks |
| Scenario | each injected event left its signature (peak temp, 0 W share, vend-rate ratio …) |
| Privacy | no emails, phone numbers, CNICs or Luhn-valid card numbers anywhere; tokens are random surrogates; people are pseudonymous codes |

The **trust score** is the share of checks passed. It is 100 % across every configuration in the test suite.

---

## 4. The AI / edge-case engine

Every edge case is the same small, validated structure:

```python
{
  "type": "compressor_failure",            # 7 types: heatwave, compressor_failure, power_outage,
                                           # demand_spike, restock_delay, card_reader_failure, door_left_open
  "targets": {"machine_ids": [404], "cities": [], "location_types": [], "route_ids": []},
  "start_offset_h": 60.0,                  # hours after dataset start (day 3, noon)
  "duration_h": 20.0,
  "params": {"mode": "gradual"},           # heatwave: delta_c; demand_spike: multiplier, categories
  "label": "Compressor failure — machine #404"
}
```

`scenarios.parse_intent()` turns a prompt into events:

```python
def parse_intent(prompt, cfg, use_llm=True):
    if use_llm and os.environ.get("ANTHROPIC_API_KEY"):
        try:
            events = llm_parse(prompt, cfg)          # Claude returns JSON in the schema above
            if events:
                return {"events": events, "engine": "llm", "notes": []}
        except Exception as exc:                      # network, quota, bad JSON → never crash the demo
            notes = [f"LLM parser unavailable ({type(exc).__name__}); used rule parser."]
    return {"events": rule_parse(prompt, cfg), "engine": "rules", ...}
```

- **Both paths go through `normalize_event()`** — unknown types are rejected, targets filtered to valid values, times clamped to the horizon, params bounded. The simulator only ever sees safe input.
- The rule parser handles clauses, machine numbers (`#404`, `machine 117`), cities, site types, routes, days/weekdays/times, durations, `+11C`, `double/triple/3x`, product categories — and knows that *"failure **during** a heatwave"* means **two** events, with the heatwave starting a day earlier.
- In the UI the plan appears in an **editable table** before generation (human-in-the-loop), so judges can see exactly what the AI decided and tweak it.

Adding a new edge case = one entry in `EVENT_TYPES`, one regex in `_TYPE_PATTERNS`, one branch in the simulator loop, one check in `validate.py`.

---

## 5. Run it locally

```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt

streamlit run app.py                                    # UI → http://localhost:8501
uvicorn api.main:app --reload --port 8000               # API → http://localhost:8000/docs
pytest -q                                               # 6 tests
```

Optional AI parser: `export ANTHROPIC_API_KEY=...` (and optionally `ANTHROPIC_MODEL`). Without it, the offline rule parser is used automatically.

### API quick reference

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/schema` | Tables, columns, PK/FKs, relationships |
| GET | `/scenarios/catalog` | Event types + example prompts |
| POST | `/scenarios/parse` | Prompt → event plan (no generation) |
| POST | `/datasets` | Generate from `config` + `prompt` *or* explicit `events` → `dataset_id`, summary, impact |
| GET | `/datasets/{id}/tables/{table}` | Paged JSON or `?format=csv`; filter `?machine_id=404` |
| GET | `/datasets/{id}/validation` | Trust score + every check |
| GET | `/datasets/{id}/documents/{type}` | All invoices / purchase_orders / service_tickets |
| GET | `/datasets/{id}/documents/{type}/{doc_id}?format=pdf` | One document as JSON or PDF |
| GET | `/datasets/{id}/export.zip` | CSVs, JSON docs, PDFs, schema, scenario, validation report |

```bash
curl -X POST localhost:8000/datasets -H 'content-type: application/json' -d '{
  "config": {"seed": 42, "days": 7},
  "prompt": "Simulate a cooling compressor failure on Machine #404 during a heatwave on day 3"
}'
```

Datasets are cached in memory (last 8). Same seed + same events → identical data, so anything can be reproduced.

---

## 6. Deploy

**Fastest (UI): Streamlit Community Cloud** — push the repo to GitHub → share.streamlit.io → *New app* → main file `app.py` → Deploy. For the AI parser add `ANTHROPIC_API_KEY = "..."` under *Settings → Secrets*.

**UI + API together: Render** — *New → Blueprint* → select the repo. `render.yaml` creates `vendgen-ui` and `vendgen-api` from the same Dockerfile. Set `ANTHROPIC_API_KEY` in each service's environment if wanted. (Free instances sleep when idle; open both URLs a few minutes before judging.)

**Anywhere with Docker**
```bash
docker compose up --build        # UI on :8501, API on :8000
# or one service:
docker build -t vendgen . && docker run -p 8501:8501 vendgen
docker run -e SERVICE=api -e PORT=8000 -p 8000:8000 vendgen
```

**Hugging Face Spaces** — create a *Docker* Space, push the repo, and add `app_port: 8501` to the Space's README front matter.

### Pre-demo checklist
- [ ] `pytest -q` passes
- [ ] Open the deployed UI once to warm it up (first generation ≈ 8–10 s for 45 machines × 7 days)
- [ ] Open `/docs` on the API
- [ ] Download one invoice PDF and one service ticket PDF to show offline if Wi-Fi fails

---

## 7. Three-minute demo script

1. **Problem (20 s).** Vending operators can't share real data — card tokens, site contracts, revenue — and real fleets rarely contain the failures you most need to test.
2. **Prompt (30 s).** Type *"Simulate a cooling compressor failure on Machine #404 during a heatwave on day 3"*. Show the event plan the AI produced — two events, heatwave first. Click **Generate**.
3. **Overview (30 s).** Edge-case cards: P1 ticket, lost vends, revenue at risk. Fleet map with #404 in red. The heatwave and failure bands on the fleet sales curve.
4. **Telemetry (30 s).** Machine #404: cabinet temperature climbs past the 8 °C lockout toward ambient; power shows short-cycling then the overload trip; stock stops falling because chilled slots locked out.
5. **Supply chain + documents (40 s).** Drill W → route → #404 → slots. Open ticket MT-000xx: evidence, spoiled units, checklist, PDF. Open #404's invoice: the traceability line shows *invoice total = Σ vends in `transactions`* ✅.
6. **Trust (20 s).** Validation tab: 58/58 — FKs, inventory reconciliation, invoice ties, scenario signatures, PII scan. Export ZIP; show `/docs`.
7. **Close (10 s).** Same engine, any fleet, any failure — reproducible from a seed.

---

## 8. Stretch ideas if time allows

- **Custom schema upload** — `schema.py` is already declarative; let users add columns or tables and have the validator pick them up.
- **Statistical fidelity report** — compare distributions against a small real sample (KS test per column) to prove realism.
- **Differential-privacy mode** — add calibrated noise to aggregates before release.
- **More regions** — `config.py` holds every region-specific value (cities, currency, products).
- **Scheduled "live" feed** — stream telemetry over WebSocket to show a real-time dashboard.

All names, sites, drivers, technicians, card tokens and companies are synthetic. Every PDF carries a synthetic-data footer.

---

## 9. The website (`site/index.html`)

A single self-contained page: the pitch (problem, how it works, judging criteria) plus a live demo that runs a JavaScript port of the engine entirely in the browser — no server needed. It includes the Tabular / Relational / Documents workspace, a bank statement with query-style filtering, region/currency/tax switching, privacy rules, and "Your data" (upload a CSV → inferred schema → synthetic rows + fidelity report).

Host it for free: drag the `site/` folder onto Netlify Drop, or enable GitHub Pages on the repo and point it at `/site`. `site/engine.js` is the same engine as a standalone file (usable from Node: `require("./site/engine.js"); VG.generate({...}, [])`).


### Website pages (`site/`)
Six separate pages share one navigation bar: `index.html` (Home), `products.html`, `features.html`, `vending-cards.html` (Vending Card Management), `contact.html` and `generator.html`. Your fleet settings, prompt and injected faults carry over as you move between pages (browser session storage), and saved checkpoints are kept in the browser. Host the folder as-is on Netlify Drop or GitHub Pages.
