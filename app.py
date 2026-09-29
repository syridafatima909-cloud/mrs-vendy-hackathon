"""Mrs Vendy — Streamlit front end.

Run:  streamlit run app.py
"""
from __future__ import annotations

import json
import os
from datetime import date

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st
from plotly.subplots import make_subplots

from engine.config import CITIES, CURRENCY, LOCATION_TYPES, GenConfig
from engine.documents import render_pdf
from engine.pipeline import generate_dataset
from engine.scenarios import EVENT_TYPES, EXAMPLE_PROMPTS, normalize_event, parse_intent
from engine.schema import RELATIONSHIPS, SCHEMA

st.set_page_config(page_title="Mrs Vendy · Synthetic Fleet Data", page_icon="🧊", layout="wide")

# Palette (validated categorical slots + reserved status colours)
BLUE, ORANGE, AQUA, RED, GREY = "#2a78d6", "#eb6834", "#1baf7a", "#e34948", "#8a8a85"
EVENT_TINT = {"compressor_failure": "rgba(227,73,72,0.13)", "power_outage": "rgba(60,60,60,0.12)",
              "heatwave": "rgba(235,104,52,0.10)", "demand_spike": "rgba(42,120,214,0.10)",
              "restock_delay": "rgba(237,161,0,0.12)", "card_reader_failure": "rgba(74,58,167,0.10)",
              "door_left_open": "rgba(232,123,164,0.14)"}

st.markdown("""
<style>
.block-container {padding-top: 1.6rem; max-width: 1400px;}
div[data-testid="stMetric"] {background: var(--secondary-background-color); border-radius: 10px; padding: 12px 14px;}
div[data-testid="stMetricLabel"] p {font-size: 0.8rem;}
.event-card {border-left: 4px solid #0f766e; background: var(--secondary-background-color); border-radius: 8px; padding: 10px 14px; margin-bottom: 8px;}
.event-card b {font-size: 0.95rem;} .event-card span {color: #6b7280; font-size: 0.82rem;}
.pill {display:inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.75rem; margin-right: 4px; background:#e6f2f1; color:#0f766e;}
</style>""", unsafe_allow_html=True)


# --------------------------------------------------------------------------- #
# State helpers
# --------------------------------------------------------------------------- #
@st.cache_resource(max_entries=4, show_spinner=False)
def _generate(cfg_json: str, events_json: str):
    return generate_dataset(GenConfig.from_dict(json.loads(cfg_json)), json.loads(events_json))


def events_to_df(events: list[dict]) -> pd.DataFrame:
    rows = []
    for e in events:
        t = e["targets"]
        rows.append({
            "type": e["type"],
            "machine_ids": ", ".join(map(str, t["machine_ids"])),
            "cities": ", ".join(t["cities"]),
            "location_types": ", ".join(t["location_types"]),
            "route_ids": ", ".join(t["route_ids"]),
            "start_day": int(e["start_offset_h"] // 24) + 1,
            "start_hour": round(e["start_offset_h"] % 24, 2),
            "duration_h": e["duration_h"],
            "params": json.dumps(e["params"]),
        })
    return pd.DataFrame(rows, columns=["type", "machine_ids", "cities", "location_types", "route_ids",
                                       "start_day", "start_hour", "duration_h", "params"])


def df_to_events(df: pd.DataFrame, cfg: GenConfig) -> list[dict]:
    split = lambda s: [x.strip() for x in str(s or "").split(",") if x.strip()]
    events = []
    for r in df.dropna(subset=["type"]).itertuples():
        try:
            params = json.loads(r.params) if isinstance(r.params, str) and r.params.strip() else {}
        except json.JSONDecodeError:
            params = {}
        events.append(normalize_event({
            "type": r.type,
            "targets": {"machine_ids": split(r.machine_ids), "cities": split(r.cities),
                        "location_types": split(r.location_types), "route_ids": split(r.route_ids)},
            "start_offset_h": (int(r.start_day or 1) - 1) * 24 + float(r.start_hour or 0),
            "duration_h": float(r.duration_h or 0) or None,
            "params": params,
        }, cfg))
    return events


def money(x: float) -> str:
    return f"{CURRENCY} {x:,.0f}"


def compact(x: float) -> str:
    for div, suf in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if abs(x) >= div:
            return f"{CURRENCY} {x / div:.2f}{suf}"
    return f"{CURRENCY} {x:,.0f}"


# --------------------------------------------------------------------------- #
# Sidebar: fleet configuration
# --------------------------------------------------------------------------- #
with st.sidebar:
    st.markdown("### 🧊 Mrs Vendy")
    st.caption("Synthetic data platform for smart vending fleets")
    st.divider()
    st.markdown("**Fleet shape**")
    n_wh = st.slider("Warehouses", 1, 6, 3)
    n_rt = st.slider("Routes per warehouse", 1, 6, 3)
    n_mc = st.slider("Machines per route", 1, 12, 5)
    days = st.slider("Days to simulate", 1, 31, 7)
    start = st.date_input("Start date", date(2026, 6, 1))
    st.markdown("**Realism**")
    seed = st.number_input("Random seed", 0, 99999, 42, help="Same seed + same scenario = identical dataset.")
    card_share = st.slider("Card / wallet share", 0.0, 1.0, 0.55, 0.05)
    noise = st.toggle("Background faults", True, help="Occasional door-ajar, card glitches and load-shedding, so baseline data isn't unrealistically clean.")
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY"))
    use_llm = st.toggle("LLM scenario parser", has_key, disabled=not has_key,
                        help="Uses Claude to read the prompt when ANTHROPIC_API_KEY is set; otherwise the offline rule parser.")
    st.caption(f"Fleet size: **{n_wh * n_rt * n_mc} machines** · {days * 96 * n_wh * n_rt * n_mc:,} telemetry rows")

cfg = GenConfig(seed=int(seed), n_warehouses=n_wh, routes_per_warehouse=n_rt, machines_per_route=n_mc,
                days=days, start_date=start, card_share=card_share, background_noise=noise)

# --------------------------------------------------------------------------- #
# Header + scenario composer
# --------------------------------------------------------------------------- #
st.title("Synthetic Vending Fleet Data")
st.caption("Telemetry, a full supply-chain database and matching business documents — generated together, validated together, and bent to any edge case you describe.")

if "prompt" not in st.session_state:
    st.session_state.prompt = EXAMPLE_PROMPTS[0]
if "plan" not in st.session_state:
    st.session_state.plan = None
if "prompt_next" in st.session_state:  # an example chip was clicked on the previous run
    st.session_state.prompt = st.session_state.pop("prompt_next")
    st.session_state.plan = None

c1, c2 = st.columns([3, 1.1], vertical_alignment="bottom")
with c1:
    prompt = st.text_area("Describe the edge cases to inject", key="prompt", height=80,
                          placeholder="e.g. Simulate a cooling compressor failure on Machine #404 during a heatwave on day 3")
with c2:
    parse_clicked = st.button("① Interpret scenario", width="stretch")
    gen_clicked = st.button("② Generate dataset", type="primary", width="stretch")

ex_cols = st.columns(3)
for i, ex in enumerate(EXAMPLE_PROMPTS):
    if ex_cols[i % 3].button(ex, key=f"ex{i}", width="stretch"):
        st.session_state.prompt_next = ex
        st.rerun()

first_load = "ds_key" not in st.session_state
stale_plan = st.session_state.plan is not None and st.session_state.plan.get("prompt") != prompt
if parse_clicked or first_load or st.session_state.plan is None or (gen_clicked and stale_plan):
    with st.spinner("Interpreting…"):
        res = parse_intent(prompt, cfg, use_llm=use_llm)
    res["prompt"] = prompt
    st.session_state.plan = res
    st.session_state.pop("plan_editor", None)
elif stale_plan:
    st.caption("✏️ Prompt changed — click **Interpret scenario** to refresh the plan (Generate will do it automatically).")

plan = st.session_state.plan
events = []
if plan is not None:
    engine_label = {"llm": "Claude (LLM)", "rules": "rule parser", "none": "—"}[plan["engine"]]
    with st.expander(f"Scenario plan · {len(plan['events'])} event(s) · interpreted by {engine_label} — review and edit before generating",
                     expanded=True):
        for n in plan["notes"]:
            st.info(n)
        edited = st.data_editor(
            events_to_df(plan["events"]), num_rows="dynamic", width="stretch", key="plan_editor",
            column_config={
                "type": st.column_config.SelectboxColumn("Event", options=list(EVENT_TYPES), required=True),
                "machine_ids": st.column_config.TextColumn("Machines", help="Comma-separated machine numbers"),
                "cities": st.column_config.TextColumn("Cities", help=", ".join(CITIES)),
                "location_types": st.column_config.TextColumn("Site types", help=", ".join(LOCATION_TYPES)),
                "route_ids": st.column_config.TextColumn("Routes", help="e.g. R-01-2"),
                "start_day": st.column_config.NumberColumn("Day", min_value=1, max_value=31, step=1),
                "start_hour": st.column_config.NumberColumn("Hour", min_value=0, max_value=23.75, step=0.25),
                "duration_h": st.column_config.NumberColumn("Hours", min_value=0.25, step=0.25),
                "params": st.column_config.TextColumn("Params (JSON)"),
            })
        try:
            events = df_to_events(edited, cfg)
        except ValueError as e:
            st.error(str(e))
        st.caption("Empty targets mean the whole fleet. Machines, cities and site types you name are guaranteed to exist in the generated fleet.")

cfg_json = json.dumps(cfg.to_dict())
if gen_clicked or first_load:
    with st.spinner("Simulating fleet, building documents, validating…"):
        st.session_state.ds_key = (cfg_json, json.dumps(events))
        st.session_state.pop("zip", None)
        _generate(*st.session_state.ds_key)

ds = _generate(*st.session_state.ds_key)
if st.session_state.ds_key[0] != cfg_json:
    st.warning("Sidebar settings changed since this dataset was generated. Click **Generate dataset** to apply them.")

T = ds.tables
S = ds.summary()
tx, tel, tk = T["transactions"], T["telemetry"], T["maintenance_tickets"]
t0 = pd.Timestamp(ds.config.start_date)

tabs = st.tabs(["Overview", "Telemetry", "Supply chain", "Documents", "Validation", "Export & API"])

# --------------------------------------------------------------------------- #
# Overview
# --------------------------------------------------------------------------- #
with tabs[0]:
    k = st.columns(6)
    k[0].metric("Machines", len(T["machines"]))
    k[1].metric("Vends", f"{len(tx):,}")
    k[2].metric(f"Gross sales ({CURRENCY})", compact(S["revenue"]).replace(CURRENCY + " ", ""), help=money(S["revenue"]))
    k[3].metric("Service tickets", S["tickets"])
    k[4].metric("Documents", sum(S["documents"].values()))
    k[5].metric("Trust score", f"{S['trust_score']:.0f}%", f"{S['checks_passed']}/{S['checks_total']} checks", delta_color="off")

    impact = ds.scenario_impact()
    left, right = st.columns([1.05, 1])
    with left:
        st.subheader("Injected edge cases")
        if not impact:
            st.caption("Baseline run — no scenario events. Background faults: %d." % S["background_events"])
        for im in impact:
            extra = []
            if im["peak_temp_c"] is not None:
                extra.append(f"peak cabinet {im['peak_temp_c']:.1f} °C")
            if im["peak_ambient_c"] is not None and im["type"] == "heatwave":
                extra.append(f"peak ambient {im['peak_ambient_c']:.1f} °C")
            st.markdown(
                f"<div class='event-card'><b>{im['label']}</b><br><span>{im['window']} · {im['machines']} machine(s)</span><br>"
                f"<span class='pill'>{im['tickets']} ticket(s)</span><span class='pill'>{im['lost_vends']} lost vends</span>"
                f"<span class='pill'>{money(im['est_lost_revenue'])} at risk</span>"
                + "".join(f"<span class='pill'>{e}</span>" for e in extra) + "</div>", unsafe_allow_html=True)
        st.caption(f"Plus {S['background_events']} small background faults · generated in {S['generation_seconds']} s")
    with right:
        st.subheader("Fleet map")
        m = T["machines"].copy()
        faulty = set(tk.machine_id[tk.priority == "P1"])
        m["status"] = m.machine_id.map(lambda x: "P1 incident" if x in faulty else "Healthy")
        m["sales"] = m.machine_id.map(tx.groupby("machine_id").amount.sum()).fillna(0)
        fig = px.scatter_map(m, lat="lat", lon="lon", color="status", size="sales", size_max=16, zoom=4.3,
                             hover_name="site_name", hover_data={"machine_id": True, "route_id": True, "lat": False, "lon": False, "sales": ":,.0f"},
                             color_discrete_map={"Healthy": BLUE, "P1 incident": RED}, height=360)
        fig.update_layout(map_style="carto-positron", margin=dict(l=0, r=0, t=0, b=0), legend=dict(orientation="h", y=1.02, x=0))
        st.plotly_chart(fig, width="stretch")

    st.subheader("Hourly vends across the fleet")
    hourly = tx.set_index("ts").resample("1h").txn_id.count().rename("vends").reset_index()
    fig = px.line(hourly, x="ts", y="vends", height=260, color_discrete_sequence=[BLUE])
    for ev in [e for e in ds.events if not e.get("background")]:
        a = t0 + pd.Timedelta(hours=ev["start_offset_h"])
        fig.add_vrect(x0=a, x1=a + pd.Timedelta(hours=ev["duration_h"]), fillcolor=EVENT_TINT[ev["type"]], line_width=0,
                      annotation_text=ev["type"].replace("_", " "), annotation_position="top left", annotation_font_size=10)
    fig.update_traces(line_width=2)
    fig.update_layout(margin=dict(l=0, r=0, t=10, b=0), xaxis_title=None, yaxis_title="Vends per hour", hovermode="x unified")
    st.plotly_chart(fig, width="stretch")

# --------------------------------------------------------------------------- #
# Telemetry
# --------------------------------------------------------------------------- #
with tabs[1]:
    targeted = [mid for e in ds.events if not e.get("background") for mid in e["targets"]["machine_ids"]]
    mids = sorted(T["machines"].machine_id)
    default = targeted[0] if targeted and targeted[0] in mids else (tk.machine_id.iloc[0] if len(tk) else mids[0])
    c1, c2 = st.columns([1, 3])
    with c1:
        mid = st.selectbox("Machine", mids, index=mids.index(default),
                           format_func=lambda x: f"#{x} · " + T["machines"].set_index("machine_id").site_name[x])
        mrow = T["machines"].set_index("machine_id").loc[mid]
        st.markdown(f"**{mrow.model}**  \n{mrow.location_type.replace('_', ' ').title()} · {mrow.city}  \nRoute {mrow.route_id}, stop {mrow.route_stop}")
        mt = tk[tk.machine_id == mid]
        st.markdown(f"**Tickets:** {len(mt)}")
        for r in mt.itertuples():
            st.caption(f"{r.ticket_id} · {r.priority} · {r.fault_type} · {pd.Timestamp(r.opened_at):%a %H:%M}")
    with c2:
        g = tel[tel.machine_id == mid]
        fig = make_subplots(rows=3, cols=1, shared_xaxes=True, vertical_spacing=0.06, row_heights=[0.45, 0.3, 0.25],
                            subplot_titles=("Temperature (°C)", "Power draw (W)", "Units in stock"))
        fig.add_trace(go.Scatter(x=g.ts, y=g.ambient_c, name="Ambient", line=dict(color=ORANGE, width=2)), 1, 1)
        fig.add_trace(go.Scatter(x=g.ts, y=g.temp_c, name="Cabinet", line=dict(color=BLUE, width=2)), 1, 1)
        fig.add_hline(y=8, line_dash="dot", line_color=GREY, annotation_text="8 °C lockout", annotation_font_size=10, row=1, col=1)
        fig.add_trace(go.Scatter(x=g.ts, y=g.power_w, name="Power", line=dict(color=AQUA, width=1.5), showlegend=False), 2, 1)
        fig.add_trace(go.Scatter(x=g.ts, y=g.total_stock, name="Stock", line=dict(color=GREY, width=2), showlegend=False, line_shape="hv"), 3, 1)
        spans = g[g.active_events != ""]
        if len(spans):
            grp = (spans.active_events != spans.active_events.shift()).cumsum()
            for _, seg in spans.groupby(grp):
                primary = seg.active_events.iloc[0].split(",")[0].replace("bg:", "")
                for row in (1, 2, 3):
                    fig.add_vrect(x0=seg.ts.iloc[0], x1=seg.ts.iloc[-1] + pd.Timedelta("15min"),
                                  fillcolor=EVENT_TINT.get(primary, "rgba(0,0,0,0.06)"), line_width=0, row=row, col=1)
        fig.update_layout(height=560, margin=dict(l=0, r=0, t=30, b=0), hovermode="x unified",
                          legend=dict(orientation="h", y=1.08, x=0))
        st.plotly_chart(fig, width="stretch")
        st.caption("Shaded bands = active events (see the `active_events` column — every row is labelled, ready for anomaly-detection training).")
    st.dataframe(g, width="stretch", height=260, hide_index=True)

# --------------------------------------------------------------------------- #
# Supply chain (relational)
# --------------------------------------------------------------------------- #
with tabs[2]:
    c1, c2 = st.columns([1, 1.4])
    with c1:
        st.subheader("Schema")
        dot = ["digraph G { rankdir=TB; bgcolor=transparent; node [shape=box, style=\"rounded,filled\", fillcolor=\"#e6f2f1\", color=\"#0f766e\", fontname=Helvetica, fontsize=11]; edge [color=\"#64748b\", fontsize=9, fontname=Helvetica];"]
        for name, spec in SCHEMA.items():
            dot.append(f'{name} [label="{name}\\n{len(T[name]):,} rows"];')
        for a, b, card in RELATIONSHIPS:
            dot.append(f'{a} -> {b} [label="{card}"];')
        dot.append("}")
        st.graphviz_chart("\n".join(dot), width="stretch")
    with c2:
        st.subheader("Drill down the hierarchy")
        wh = st.selectbox("Warehouse", T["warehouses"].warehouse_id, format_func=lambda w: f"{w} · " + T["warehouses"].set_index("warehouse_id").name[w])
        rts = T["routes"][T["routes"].warehouse_id == wh]
        rt = st.selectbox("Route", rts.route_id, format_func=lambda r: f"{r} · services {rts.set_index('route_id').service_days[r]} · {rts.set_index('route_id').driver_code[r]}")
        ms = T["machines"][T["machines"].route_id == rt].sort_values("route_stop")
        mc = st.selectbox("Machine", ms.machine_id, format_func=lambda x: f"Stop {ms.set_index('machine_id').route_stop[x]} · #{x} · {ms.set_index('machine_id').site_name[x]}")
        sl = T["slots"][T["slots"].machine_id == mc].merge(T["products"][["product_id", "name", "category", "unit_price"]], on="product_id")
        last_inv = T["inventory"][T["inventory"].machine_id == mc]
        last_inv = last_inv[last_inv.ts == last_inv.ts.max()].set_index("slot_id").stock
        sl["stock_now"] = sl.slot_id.map(last_inv)
        sold = tx[tx.machine_id == mc].groupby("slot_id").agg(vends=("qty", "sum"), sales=("amount", "sum"))
        sl = sl.join(sold, on="slot_id").fillna({"vends": 0, "sales": 0})
        st.dataframe(sl[["slot_code", "name", "category", "capacity", "par_level", "stock_now", "vends", "sales"]],
                     width="stretch", hide_index=True, height=300,
                     column_config={"stock_now": st.column_config.ProgressColumn("Stock now", min_value=0, max_value=int(sl.capacity.max()), format="%d"),
                                    "sales": st.column_config.NumberColumn(f"Sales ({CURRENCY})", format="%,.0f")})
    st.subheader("Browse any table")
    tname = st.selectbox("Table", list(T), index=list(T).index("transactions"))
    st.caption(SCHEMA[tname]["description"] + ("  ·  FKs: " + ", ".join(f"{k} → {v}" for k, v in SCHEMA[tname]["fks"].items()) if SCHEMA[tname]["fks"] else ""))
    st.dataframe(T[tname].head(5000), width="stretch", hide_index=True, height=320)
    st.caption(f"Showing up to 5,000 of {len(T[tname]):,} rows. Full tables are in Export.")

# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #
with tabs[3]:
    kind = st.radio("Document type", ["invoice", "purchase_order", "service_ticket"], horizontal=True,
                    format_func=lambda k: {"invoice": "Sales invoices", "purchase_order": "Purchase orders", "service_ticket": "Service tickets"}[k])
    docs = ds.documents[kind]
    if not docs:
        st.info("No documents of this type in this dataset.")
    else:
        c1, c2 = st.columns([1, 2])
        with c1:
            def _doc_label(d):
                if kind == "invoice":
                    return f"{d['doc_id']} · {money(d['gross_sales'])}"
                if kind == "purchase_order":
                    return f"{d['doc_id']} · {money(d['total_amount'])}"
                return f"{d['doc_id']} · {d['priority']} · {d['fault_type']} · #{d['machine_id']}"
            idx = st.selectbox("Document", range(len(docs)), format_func=lambda i: _doc_label(docs[i]))
            doc = docs[idx]
            st.download_button("⬇ Download PDF", render_pdf(doc), file_name=f"{doc['doc_id']}.pdf", mime="application/pdf", type="primary", width="stretch")
            st.download_button("⬇ Download JSON", json.dumps(doc, indent=2, default=str), file_name=f"{doc['doc_id']}.json", mime="application/json", width="stretch")
            st.markdown("**Traceability**")
            if kind == "invoice":
                live = tx[tx.machine_id == doc["machine_id"]].amount.sum()
                ok = abs(live - doc["gross_sales"]) < 0.01
                st.markdown(f"{'✅' if ok else '❌'} Invoice total {money(doc['gross_sales'])} = Σ {doc['vend_count']} vends in `transactions` ({money(live)})")
            elif kind == "purchase_order":
                st.markdown(f"✅ Every line covers the units routes {', '.join(doc['routes'])} restocked, +10% safety, whole cases")
            else:
                st.markdown("✅ Opened from a telemetry anomaly; route and depot resolved via foreign keys")
        with c2:
            if kind == "invoice":
                st.markdown(f"#### Sales settlement invoice {doc['doc_id']}\nMachine #{doc['machine_id']} — {doc['site_name']} · {doc['period_start'][:10]} to {doc['period_end'][:10]}")
                st.dataframe(pd.DataFrame(doc["lines"]), hide_index=True, width="stretch", height=300)
                a, b, c = st.columns(3)
                a.metric("Gross sales", money(doc["gross_sales"]))
                b.metric(f"Site commission {doc['site_commission_rate']:.0%}", money(doc["site_commission"]))
                c.metric("Net to operator", money(doc["net_to_operator"]))
            elif kind == "purchase_order":
                st.markdown(f"#### Purchase order {doc['doc_id']}\nDeliver to {doc['warehouse_name']} · routes {', '.join(doc['routes'])}")
                st.dataframe(pd.DataFrame(doc["lines"]), hide_index=True, width="stretch", height=300)
                st.metric("PO total", money(doc["total_amount"]), f"{doc['total_units']:,} units", delta_color="off")
            else:
                st.markdown(f"#### Service ticket {doc['doc_id']} · {doc['priority']}\n**{doc['fault_type']}** on machine #{doc['machine_id']} ({doc['model']}), {doc['site_name']}")
                st.markdown(f"- **Opened** {doc['opened_at'][:16].replace('T', ' ')} · **Closed** {doc['closed_at'][:16].replace('T', ' ')}\n"
                            f"- **Route / depot** {doc['route_id']} / {doc['warehouse_id']} · **Technician** {doc['technician_code']}\n"
                            f"- **Evidence** {doc['evidence']}\n- **Impact** {doc['lost_vends']} lost vends, est. {money(doc['est_lost_revenue'])}")
                st.markdown("**Checklist**\n" + "\n".join(f"- [ ] {a}" for a in doc["actions"]))

# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
with tabs[4]:
    v = pd.DataFrame(ds.validation)
    c = st.columns(5)
    for i, grp in enumerate(["schema", "business", "documents", "scenario", "privacy"]):
        sub = v[v.group == grp]
        c[i].metric(grp.title(), f"{(sub.status == 'pass').sum()}/{len(sub)}" if len(sub) else "—")
    v["result"] = v.status.map({"pass": "✅ pass", "warn": "⚠️ warn", "fail": "❌ fail"})
    grp = st.segmented_control("Group", ["all", "schema", "business", "documents", "scenario", "privacy"], default="all")
    view = v if grp in (None, "all") else v[v.group == grp]
    st.dataframe(view[["result", "group", "check", "detail"]], hide_index=True, width="stretch", height=520)

# --------------------------------------------------------------------------- #
# Export & API
# --------------------------------------------------------------------------- #
with tabs[5]:
    c1, c2 = st.columns(2)
    with c1:
        st.subheader("Download")
        n_pdf = st.slider("PDFs per document type in the bundle", 0, 60, 10)
        if st.button("Build ZIP bundle", width="stretch"):
            with st.spinner("Packing tables, documents and reports…"):
                st.session_state.zip = ds.to_zip(include_pdfs=n_pdf)
        if "zip" in st.session_state:
            st.download_button("⬇ Download dataset.zip", st.session_state.zip, file_name="mrs_vendy_dataset.zip", mime="application/zip", type="primary", width="stretch")
        st.caption("Bundle: every table as CSV, all documents as JSON, sample PDFs, schema.json, scenario.json, validation_report.json.")
        tname = st.selectbox("Single table as CSV", list(T))
        st.download_button(f"⬇ {tname}.csv", T[tname].to_csv(index=False), file_name=f"{tname}.csv", mime="text/csv")
    with c2:
        st.subheader("Same engine over REST")
        st.code(f"""# Start the API:  uvicorn api.main:app --port 8000   (docs at /docs)
curl -X POST localhost:8000/datasets -H 'content-type: application/json' -d '{{
  "config": {json.dumps({k: ds.config.to_dict()[k] for k in ("seed", "days", "n_warehouses")})},
  "prompt": "{prompt.replace('"', "'")[:90]}"
}}'
curl localhost:8000/datasets/<id>/tables/telemetry?machine_id=404&format=csv
curl localhost:8000/datasets/<id>/documents/invoice/<doc_id>?format=pdf -o invoice.pdf
curl localhost:8000/datasets/<id>/validation""", language="bash")
        st.markdown("**Reproducibility**: this exact dataset is regenerated from the seed and the scenario below.")
        st.code(json.dumps({"config": ds.config.to_dict(), "events": [e for e in ds.events if not e.get("background")]}, indent=2, default=str), language="json")
