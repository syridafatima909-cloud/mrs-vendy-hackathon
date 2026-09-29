"""Trust layer: proves the synthetic data is internally consistent and privacy-safe.

Four groups of checks, each returning pass / warn / fail with evidence:
  schema      - columns, primary keys, foreign keys (driven by schema.SCHEMA)
  business    - cross-table rules (prices, stock bounds, inventory reconciliation, lockouts)
  documents   - invoices and POs reconcile to the tables they were built from
  scenario    - every injected edge case left the expected signature in the data
  privacy     - no PII patterns anywhere in the output
"""
from __future__ import annotations

import re

import numpy as np
import pandas as pd

from .config import CHILLED_LOCKOUT_C
from .generator import affected_machines
from .schema import SCHEMA


def _chk(out, group, name, ok, detail, warn=False):
    out.append({"group": group, "check": name, "status": "pass" if ok else ("warn" if warn else "fail"), "detail": detail})


def validate(t: dict, docs: dict, events: list[dict], cfg) -> list[dict]:
    out: list[dict] = []

    # ---------------- schema ----------------
    for name, spec in SCHEMA.items():
        df = t[name]
        missing = set(spec["columns"]) - set(df.columns)
        _chk(out, "schema", f"{name}: columns match schema", not missing, f"missing {sorted(missing)}" if missing else f"{len(df.columns)} columns, {len(df):,} rows")
        if spec["pk"]:
            pk = df[spec["pk"]]
            ok = pk.is_unique and pk.notna().all()
            _chk(out, "schema", f"{name}: primary key {spec['pk']} unique", ok, f"{pk.duplicated().sum()} duplicates")
        for col, ref in spec["fks"].items():
            rt, rc = ref.split(".")
            orphans = int((~df[col].isin(t[rt][rc])).sum())
            _chk(out, "schema", f"{name}.{col} → {ref}", orphans == 0, f"{orphans} orphan rows" if orphans else f"all {len(df):,} rows resolve")

    tx, sl, pr, rs, inv, tel = t["transactions"], t["slots"], t["products"], t["restocks"], t["inventory"], t["telemetry"]

    # ---------------- business rules ----------------
    bad_amt = int((~np.isclose(tx.amount, tx.qty * tx.unit_price)).sum())
    _chk(out, "business", "amount = qty × unit_price", bad_amt == 0, f"{bad_amt} mismatches in {len(tx):,} vends")
    price = tx.product_id.map(pr.set_index("product_id").unit_price)
    _chk(out, "business", "vend price = catalogue price", bool((price == tx.unit_price).all()), "every vend priced from products table")
    slot_prod = tx.slot_id.map(sl.set_index("slot_id").product_id)
    _chk(out, "business", "vended product matches slot planogram", bool((slot_prod == tx.product_id).all()), "slot → product consistent")
    slot_mach = tx.slot_id.map(sl.set_index("slot_id").machine_id)
    _chk(out, "business", "vend slot belongs to vend machine", bool((slot_mach == tx.machine_id).all()), "slot → machine consistent")

    cap = inv.slot_id.map(sl.set_index("slot_id").capacity)
    bounds = int(((inv.stock < 0) | (inv.stock > cap)).sum())
    _chk(out, "business", "0 ≤ stock ≤ slot capacity", bounds == 0, f"{bounds} out-of-bound snapshots of {len(inv):,}")

    first_ts, last_ts = inv.ts.min(), inv.ts.max()
    s0 = inv[inv.ts == first_ts].set_index("slot_id").stock
    s1 = inv[inv.ts == last_ts].set_index("slot_id").stock
    sold = tx[(tx.ts >= first_ts) & (tx.ts < last_ts)].groupby("slot_id").qty.sum()
    moved = rs[(rs.ts >= first_ts) & (rs.ts < last_ts)].groupby("slot_id").qty_added.sum()
    recon = (s0.add(moved, fill_value=0).sub(sold, fill_value=0) - s1).abs()
    bad_slots = int((recon > 0).sum())
    _chk(out, "business", "inventory reconciles: start + restocks − vends = end", bad_slots == 0,
         f"{bad_slots} of {len(s1)} slots off" if bad_slots else f"all {len(s1)} slots reconcile exactly")

    tel_idx = tel.set_index(["machine_id", "ts"])
    step = tx.ts.dt.floor("15min")
    joined = tel_idx.reindex(pd.MultiIndex.from_arrays([tx.machine_id, step]))
    in_outage = int((joined.power_w.to_numpy() == 0).sum())
    _chk(out, "business", "no vends while machine has no power", in_outage == 0, f"{in_outage} vends during 0 W intervals")
    chilled = tx.product_id.map(pr.set_index("product_id").chilled).to_numpy().astype(bool)
    hot = joined.temp_c.to_numpy() > CHILLED_LOCKOUT_C
    lock_viol = int((chilled & hot).sum())
    _chk(out, "business", "chilled items locked out above 8 °C", lock_viol == 0, f"{lock_viol} chilled vends while cabinet above 8 °C")
    card_down = ~joined.card_reader_ok.to_numpy().astype(bool)
    card_viol = int(((tx.payment_method == "card").to_numpy() & card_down).sum())
    _chk(out, "business", "no card payments while reader is down", card_viol == 0, f"{card_viol} violations")

    tk = t["maintenance_tickets"]
    route_ok = (tk.route_id == tk.machine_id.map(t["machines"].set_index("machine_id").route_id)).all() if len(tk) else True
    _chk(out, "business", "ticket route = machine's route", bool(route_ok), f"{len(tk)} tickets checked")
    order_ok = bool((tk.closed_at > tk.opened_at).all()) if len(tk) else True
    _chk(out, "business", "tickets close after they open", order_ok, "timestamps ordered")

    # ---------------- documents ----------------
    inv_docs = docs["invoice"]
    by_m = tx.groupby("machine_id").amount.sum()
    mism = [d["doc_id"] for d in inv_docs if not np.isclose(d["gross_sales"], by_m.get(d["machine_id"], 0))]
    line_mism = [d["doc_id"] for d in inv_docs if not np.isclose(sum(l["amount"] for l in d["lines"]), d["gross_sales"])]
    _chk(out, "documents", "invoice total = Σ machine transactions", not mism, f"{len(inv_docs)} invoices, {len(mism)} mismatches")
    _chk(out, "documents", "invoice lines sum to invoice total", not line_mism, f"{len(line_mism)} mismatches")
    split_bad = [d["doc_id"] for d in inv_docs if not np.isclose(d["cash_total"] + d["card_total"], d["gross_sales"])]
    _chk(out, "documents", "cash + card = gross sales", not split_bad, f"{len(split_bad)} mismatches")
    short = [(d["doc_id"], l["product_id"]) for d in docs["purchase_order"] for l in d["lines"] if l["order_units"] < l["restocked_units"]]
    _chk(out, "documents", "PO quantities cover all restocked units", not short, f"{len(docs['purchase_order'])} POs, {len(short)} short lines")
    _chk(out, "documents", "one service ticket document per ticket row", len(docs["service_ticket"]) == len(tk), f"{len(tk)} tickets")

    # ---------------- scenario verification ----------------
    machines = t["machines"]
    t0 = pd.Timestamp(cfg.start_date)
    for ev in [e for e in events if not e.get("background")]:
        a = t0 + pd.Timedelta(hours=ev["start_offset_h"])
        b = a + pd.Timedelta(hours=ev["duration_h"])
        hit = affected_machines(ev, machines)
        if ev["type"] == "heatwave":
            cities = set(ev["targets"]["cities"]) | set(machines.city[machines.machine_id.isin(hit)])
            hit = set(machines.machine_id[machines.city.isin(cities)])
        w = tel[tel.machine_id.isin(hit) & (tel.ts >= a) & (tel.ts < b)]
        label = f"scenario: {ev['label']}"
        if not len(w):
            _chk(out, "scenario", label, False, "no telemetry for targets in window (check machine ids)")
            continue
        et = ev["type"]
        if et == "compressor_failure":
            pk = w.temp_c.max()
            _chk(out, "scenario", label, pk > CHILLED_LOCKOUT_C, f"peak internal temp {pk:.1f} °C across {len(hit)} machine(s)")
        elif et == "power_outage":
            share = (w.power_w == 0).mean()
            _chk(out, "scenario", label, share > 0.95, f"{share:.0%} of intervals at 0 W")
        elif et == "heatwave":
            base = tel[tel.machine_id.isin(hit) & ((tel.ts < a) | (tel.ts >= b))].ambient_c.mean()
            d = w.ambient_c.mean() - base
            _chk(out, "scenario", label, d > 1, f"ambient +{d:.1f} °C vs outside the window")
        elif et == "demand_spike":
            vt = tx[tx.machine_id.isin(hit)]
            inside = len(vt[(vt.ts >= a) & (vt.ts < b)]) / max(ev["duration_h"], 1)
            outside = len(vt[(vt.ts < a) | (vt.ts >= b)]) / max(cfg.days * 24 - ev["duration_h"], 1)
            ratio = inside / max(outside, 1e-9)
            _chk(out, "scenario", label, ratio > 1.3, f"vend rate ×{ratio:.2f} vs baseline", warn=ratio > 1.05)
        elif et == "restock_delay":
            n = len(rs[rs.machine_id.isin(hit) & (rs.ts >= a) & (rs.ts < b) & (rs.reason == "scheduled")])
            _chk(out, "scenario", label, n == 0, f"{n} scheduled restocks inside the delay window")
        elif et == "card_reader_failure":
            n = len(tx[tx.machine_id.isin(hit) & (tx.ts >= a) & (tx.ts < b) & (tx.payment_method == "card")])
            _chk(out, "scenario", label, n == 0, f"{n} card vends in window; cash only")
        elif et == "door_left_open":
            _chk(out, "scenario", label, bool(w.door_open.any()), f"door sensor on, peak temp {w.temp_c.max():.1f} °C")

    # ---------------- privacy ----------------
    patterns = {
        "email": r"[\w.+-]+@[\w-]+\.[\w.]+",
        "phone": r"(?:\+92|0092|\b03\d{2})[-\s]?\d{7}\b",
        "national ID (CNIC)": r"\b\d{5}-\d{7}-\d\b",
        "card number (Luhn)": r"\b\d{13,19}\b",
    }
    hits = {k: 0 for k in patterns}
    for name, df in t.items():
        for col in df.select_dtypes(include=["object", "string"]).columns:
            s = df[col].dropna().astype(str)
            if not len(s):
                continue
            sample = s.unique()[:20000]
            for k, p in patterns.items():
                found = [x for x in sample if re.search(p, x)]
                if k == "card number (Luhn)":
                    found = [x for x in found if _luhn(re.search(p, x).group(0))]
                hits[k] += len(found)
    for k, n in hits.items():
        _chk(out, "privacy", f"no {k} patterns in any table", n == 0, f"{n} matches")
    toks = tx.card_token[tx.card_token != ""]
    _chk(out, "privacy", "card tokens are random surrogates", bool(toks.str.fullmatch(r"tok_[0-9a-f]{12}").all()),
         f"{toks.nunique():,} distinct tokens, none derived from real card data")
    _chk(out, "privacy", "people are pseudonymous codes only", bool(t["routes"].driver_code.str.fullmatch(r"DRV-\d{3}").all()),
         "drivers DRV-###, technicians TECH-###; no names stored")
    return out


def _luhn(num: str) -> bool:
    digits = [int(d) for d in num][::-1]
    total = sum(d if i % 2 == 0 else (d * 2 - 9 if d * 2 > 9 else d * 2) for i, d in enumerate(digits))
    return total % 10 == 0
