"""Relational master data + time-stepped fleet simulator.

Order of work:
  1. build_master()  -> warehouses, routes, machines, products, slots   (FK-linked)
  2. simulate()      -> telemetry, transactions, restocks, inventory     (one clock)
  3. derive_tickets() -> maintenance tickets detected from telemetry anomalies

Because vends, refills, temperatures and faults are produced by the same loop,
cross-table rules hold by construction: stock never goes negative, no vends
happen during an outage, chilled slots lock out above 8 C, and so on.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

from .config import (CHILLED_LOCKOUT_C, CITIES, INVENTORY_STEP_MIN, LOCATION_TYPES,
                     MACHINE_MODELS, PRODUCTS, SETPOINT_C, TELEMETRY_STEP_MIN, GenConfig)

STEP = TELEMETRY_STEP_MIN
STEPS_PER_H = 60 // STEP
PERISHABLE = {"dairy", "fresh_food"}


# --------------------------------------------------------------------------- #
# 1. Relational master data
# --------------------------------------------------------------------------- #
def build_master(cfg: GenConfig, rng: np.random.Generator, reserved_ids: list[int],
                 reserved_cities: list[str] | None = None, reserved_locs: list[str] | None = None) -> dict:
    city_names = list(CITIES)
    # Cities named in the scenario get a depot first; the rest are drawn at random.
    forced = [c for c in (reserved_cities or []) if c in CITIES][: cfg.n_warehouses]
    rest = [c for c in city_names if c not in forced]
    n_rest = cfg.n_warehouses - len(forced)
    wh_cities = forced + list(rng.choice(rest if n_rest <= len(rest) else city_names, size=n_rest, replace=n_rest > len(rest)))

    warehouses = []
    for i, city in enumerate(wh_cities, 1):
        lat, lon, *_ = CITIES[city]
        warehouses.append({
            "warehouse_id": f"W-{i:02d}",
            "name": f"{city} Depot {i}",
            "city": city,
            "lat": round(lat + rng.normal(0, 0.03), 5),
            "lon": round(lon + rng.normal(0, 0.03), 5),
            "capacity_units": int(rng.integers(20, 60)) * 1000,
        })

    routes = []
    drivers = rng.permutation(np.arange(100, 999))
    for w in warehouses:
        for k in range(1, cfg.routes_per_warehouse + 1):
            shift = (k - 1) % 3
            days = sorted({(d + shift) % 6 for d in cfg.restock_days})  # spread across Mon-Sat
            routes.append({
                "route_id": f"R-{w['warehouse_id'][2:]}-{k}",
                "warehouse_id": w["warehouse_id"],
                "route_name": f"{w['city']} Route {k}",
                "driver_code": f"DRV-{drivers[len(routes)]}",
                "service_days": ",".join(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d] for d in days),
                "vehicle": f"VAN-{int(rng.integers(10, 99))}",
            })

    n = cfg.n_machines
    ids = [int(x) for x in rng.choice(np.arange(101, 1000), size=n, replace=False)]
    # Make sure machines named in the scenario prompt exist in the fleet.
    for rid in reserved_ids:
        if rid not in ids and 1 <= rid <= 99999:
            swap = next(i for i in range(n) if ids[i] not in reserved_ids)
            ids[swap] = rid
    ids = sorted(ids)
    order = rng.permutation(n)

    machines = []
    loc_names = list(LOCATION_TYPES)
    loc_p = np.array([0.22, 0.14, 0.2, 0.16, 0.16, 0.12])
    wh_by_id = {w["warehouse_id"]: w for w in warehouses}
    idx = 0
    for r in routes:
        city = wh_by_id[r["warehouse_id"]]["city"]
        lat0, lon0, *_ = CITIES[city]
        for stop in range(1, cfg.machines_per_route + 1):
            mid = ids[order[idx]]
            idx += 1
            loc = str(rng.choice(loc_names, p=loc_p))
            model = str(rng.choice(list(MACHINE_MODELS)))
            machines.append({
                "machine_id": mid,
                "route_id": r["route_id"],
                "route_stop": stop,
                "site_name": f"{city} {loc.replace('_', ' ').title()} Site {mid}",
                "location_type": loc,
                "city": city,
                "lat": round(lat0 + rng.normal(0, 0.06), 5),
                "lon": round(lon0 + rng.normal(0, 0.06), 5),
                "model": model,
                "install_date": (cfg.start_date - timedelta(days=int(rng.integers(60, 1100)))).isoformat(),
                "slot_count": MACHINE_MODELS[model][2],
            })

    # Guarantee at least two sites of every location type the scenario names.
    for k, lt in enumerate(reserved_locs or []):
        have = [m for m in machines if m["location_type"] == lt]
        for m in [m for m in machines if m["location_type"] not in (reserved_locs or [])][k * 2:k * 2 + max(0, 2 - len(have))]:
            m["location_type"] = lt
            m["site_name"] = f"{m['city']} {lt.replace('_', ' ').title()} Site {m['machine_id']}"

    products = [{
        "product_id": sku, "name": name, "category": cat,
        "unit_cost": float(cost), "unit_price": float(price), "chilled": bool(chilled),
    } for sku, name, cat, cost, price, chilled, _ in PRODUCTS]
    pop = {p[0]: p[6] for p in PRODUCTS}

    slots = []
    skus = [p[0] for p in PRODUCTS]
    base_w = np.array([pop[s] for s in skus])
    for m in machines:
        n_slots = m["slot_count"]
        # Location tweaks: hospitals and offices stock more fresh food and dairy.
        w = base_w.copy()
        for j, s in enumerate(skus):
            cat = PRODUCTS[j][2]
            if m["location_type"] in ("hospital", "office") and cat in PERISHABLE:
                w[j] *= 1.8
            if m["location_type"] in ("metro_station", "petrol_station") and cat == "beverage":
                w[j] *= 1.4
        w = w / w.sum()
        # Every product at most twice; the best sellers get the second facing.
        picks = list(rng.choice(skus, size=min(n_slots, len(skus)), replace=False, p=w))
        while len(picks) < n_slots:
            extra = str(rng.choice(skus, p=w))
            if picks.count(extra) < 2:
                picks.append(extra)
        rows = "ABCDE"
        for k, sku in enumerate(picks):
            code = f"{rows[k // 6]}{k % 6 + 1}"
            cat = PRODUCTS[skus.index(sku)][2]
            cap = int(rng.integers(8, 11)) if cat in ("beverage", "dairy") else int(rng.integers(6, 9)) if cat == "fresh_food" else int(rng.integers(10, 16))
            slots.append({
                "slot_id": f"{m['machine_id']}-{code}",
                "machine_id": m["machine_id"],
                "slot_code": code,
                "product_id": sku,
                "capacity": cap,
                "par_level": max(2, math.ceil(cap * 0.35)),
            })

    return {
        "warehouses": pd.DataFrame(warehouses),
        "routes": pd.DataFrame(routes),
        "machines": pd.DataFrame(machines),
        "products": pd.DataFrame(products),
        "slots": pd.DataFrame(slots),
    }


# --------------------------------------------------------------------------- #
# Event helpers
# --------------------------------------------------------------------------- #
def affected_machines(ev: dict, machines: pd.DataFrame) -> set[int]:
    t = ev["targets"]
    if not any(t.values()):
        return set(machines.machine_id)
    mask = pd.Series(False, index=machines.index)
    if t["machine_ids"]:
        mask |= machines.machine_id.isin(t["machine_ids"])
    if t["cities"]:
        mask |= machines.city.isin(t["cities"])
    if t["route_ids"]:
        mask |= machines.route_id.isin(t["route_ids"])
    if t["location_types"]:
        lt = machines.location_type.isin(t["location_types"])
        # When cities are also given, location types narrow within those cities.
        mask = (mask & lt) if (t["cities"] and not t["machine_ids"]) else (mask | lt)
    return set(machines.machine_id[mask])


def _step_window(ev: dict, n_steps: int) -> tuple[int, int]:
    s0 = int(ev["start_offset_h"] * STEPS_PER_H)
    s1 = int(math.ceil((ev["start_offset_h"] + ev["duration_h"]) * STEPS_PER_H))
    return max(0, s0), min(n_steps, s1)


def background_events(cfg: GenConfig, machines: pd.DataFrame, rng: np.random.Generator) -> list[dict]:
    """Small, realistic faults so the baseline is not unrealistically clean."""
    evs = []
    horizon = cfg.days * 24
    for mid in machines.machine_id:
        if rng.random() < 0.06 * cfg.days / 7:
            evs.append({"type": "card_reader_failure", "targets": {"machine_ids": [int(mid)], "cities": [], "location_types": [], "route_ids": []},
                        "start_offset_h": float(rng.uniform(0, horizon - 8)), "duration_h": float(rng.uniform(2, 6)),
                        "params": {}, "label": f"Background: card reader glitch #{mid}", "background": True})
        if rng.random() < 0.03 * cfg.days / 7:
            evs.append({"type": "door_left_open", "targets": {"machine_ids": [int(mid)], "cities": [], "location_types": [], "route_ids": []},
                        "start_offset_h": float(rng.uniform(0, horizon - 3)), "duration_h": float(rng.uniform(0.75, 1.5)),
                        "params": {}, "label": f"Background: door ajar #{mid}", "background": True})
    outdoor = machines[machines.location_type.map(lambda l: not LOCATION_TYPES[l]["indoor"])]
    for mid in outdoor.machine_id:
        if rng.random() < 0.08 * cfg.days / 7:
            evs.append({"type": "power_outage", "targets": {"machine_ids": [int(mid)], "cities": [], "location_types": [], "route_ids": []},
                        "start_offset_h": float(rng.uniform(0, horizon - 3)), "duration_h": float(rng.choice([1.0, 1.5, 2.0])),
                        "params": {}, "label": f"Background: load-shedding #{mid}", "background": True})
    return evs


# --------------------------------------------------------------------------- #
# 2. Simulation
# --------------------------------------------------------------------------- #
def _hour_profiles() -> dict[str, np.ndarray]:
    prof = {}
    for loc, spec in LOCATION_TYPES.items():
        h = np.arange(24) + 0.5
        p = 0.25 + sum(np.exp(-((h - pk) ** 2) / (2 * 1.6 ** 2)) for pk in spec["peaks"])
        o0, o1 = spec["open"]
        p[(np.arange(24) < o0) | (np.arange(24) >= o1)] = 0.0
        prof[loc] = p / p.mean()
    return prof


def _dow_factor(loc: str, dow: int) -> float:
    if loc in ("office", "university"):
        return {5: 0.5, 6: 0.2}.get(dow, 1.0)
    if loc == "mall":
        return {4: 1.1, 5: 1.35, 6: 1.4}.get(dow, 1.0)
    return 1.0


def simulate(cfg: GenConfig, master: dict, events: list[dict], rng: np.random.Generator) -> dict:
    machines, slots, products, routes = master["machines"], master["slots"], master["products"], master["routes"]
    n_steps = cfg.days * 24 * STEPS_PER_H
    t0 = datetime.combine(cfg.start_date, datetime.min.time())
    times = [t0 + timedelta(minutes=STEP * s) for s in range(n_steps)]
    hours = np.array([t.hour for t in times])
    dows = np.array([t.weekday() for t in times])

    prod = products.set_index("product_id")
    profiles = _hour_profiles()

    # Outdoor ambient per city: diurnal sine + daily drift + heatwave ramps.
    hw_delta = {c: np.zeros(n_steps) for c in CITIES}
    per_machine_events: dict[int, list[tuple[dict, int, int]]] = {int(m): [] for m in machines.machine_id}
    for ev in events:
        s0, s1 = _step_window(ev, n_steps)
        hit = affected_machines(ev, machines)
        if ev["type"] == "heatwave":
            cities = set(ev["targets"]["cities"]) | set(machines.city[machines.machine_id.isin(hit)])
            ramp = np.zeros(n_steps)
            span = np.arange(s0, s1)
            r = np.minimum(1, np.minimum((span - s0 + 1) / (6 * STEPS_PER_H), (s1 - span) / (6 * STEPS_PER_H)))
            ramp[s0:s1] = r * ev["params"]["delta_c"]
            for c in cities:
                hw_delta[c] = np.maximum(hw_delta[c], ramp)
            hit = set(machines.machine_id[machines.city.isin(cities)])
        for mid in hit:
            per_machine_events[int(mid)].append((ev, s0, s1))

    outdoor_amb = {}
    frac_h = np.arange(n_steps) / STEPS_PER_H
    for c, (_, _, mean, swing) in CITIES.items():
        daily = np.repeat(rng.normal(0, 1.4, cfg.days + 1), 24 * STEPS_PER_H)[:n_steps]
        diurnal = swing * np.sin(2 * np.pi * ((frac_h % 24) - 9) / 24)
        outdoor_amb[c] = mean + diurnal + daily + rng.normal(0, 0.35, n_steps) + hw_delta[c]

    # Token pools per city: random surrogates so repeat customers look realistic.
    token_pool = {c: [f"tok_{rng.bytes(6).hex()}" for _ in range(300)] for c in CITIES}
    zipf_w = 1 / np.arange(1, 301) ** 0.8
    zipf_w /= zipf_w.sum()

    txns, restocks, telemetry, inventory = [], [], [], []
    lost_log = []  # (machine_id, step, lost)

    route_days = {r.route_id: {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].index(d) for d in r.service_days.split(",")}
                  for r in routes.itertuples()}

    for m in machines.itertuples():
        mid = int(m.machine_id)
        loc = m.location_type
        idle_w, comp_w, _ = MACHINE_MODELS[m.model]
        ms = slots[slots.machine_id == mid].reset_index(drop=True)
        cap = ms.capacity.to_numpy()
        stock = np.maximum(1, np.round(cap * rng.uniform(0.6, 1.0, len(ms)))).astype(int)
        cats = ms.product_id.map(prod.category).to_numpy()
        chilled = ms.product_id.map(prod.chilled).to_numpy().astype(bool)
        perish = np.isin(cats, list(PERISHABLE))
        prices = ms.product_id.map(prod.unit_price).to_numpy()
        pop = ms.product_id.map({p[0]: p[6] for p in PRODUCTS}).to_numpy().astype(float)
        mfac = float(rng.lognormal(0, 0.28))
        indoor = LOCATION_TYPES[loc]["indoor"]
        amb_out = outdoor_amb[m.city]
        amb = 24 + 0.3 * (amb_out - 24) + rng.normal(0, 0.25, n_steps) if indoor else amb_out

        # Per-step fault arrays for this machine.
        fail = np.zeros(n_steps, bool); fail_phase = np.zeros(n_steps)
        fail_sudden = np.zeros(n_steps, bool)
        outage = np.zeros(n_steps, bool); card_down = np.zeros(n_steps, bool)
        door = np.zeros(n_steps, bool); no_restock = np.zeros(n_steps, bool)
        spike = np.ones(n_steps); spike_cats: list[tuple[int, int, float, list]] = []
        labels = [[] for _ in range(n_steps)]
        for ev, s0, s1 in per_machine_events[mid]:
            et = ev["type"]
            tag = ("bg:" if ev.get("background") else "") + et
            for s in range(s0, s1):
                labels[s].append(tag)
            if et == "compressor_failure":
                fail[s0:s1] = True
                fail_phase[s0:s1] = (np.arange(s0, s1) - s0) / max(1, s1 - s0)
                if ev["params"].get("mode") == "sudden":
                    fail_sudden[s0:s1] = True
            elif et == "power_outage":
                outage[s0:s1] = True
            elif et == "card_reader_failure":
                card_down[s0:s1] = True
            elif et == "door_left_open":
                door[s0:s1] = True
            elif et == "restock_delay":
                no_restock[s0:s1] = True
            elif et == "demand_spike":
                spike_cats.append((s0, s1, ev["params"]["multiplier"], ev["params"].get("categories") or []))

        temp = SETPOINT_C + rng.normal(0, 0.3)
        warm_steps = 0
        cycles_phase_trip = 0.25  # gradual failure: short-cycling for first quarter, then trips
        visit_min = 9 * 60 + 10 + 18 * (m.route_stop - 1)   # driver reaches this stop at 09:10 + 18 min/stop

        for s in range(n_steps):
            ts = times[s]
            h, dow = hours[s], dows[s]
            min_sale_sec = 0

            # Hourly inventory snapshot, taken at the very start of the step.
            if ts.minute == 0:
                for j in range(len(ms)):
                    inventory.append((ts, mid, ms.slot_id[j], int(stock[j])))

            # ---- scheduled restock ----
            step_min = ts.hour * 60 + ts.minute
            if (step_min <= visit_min < step_min + STEP and dow in route_days[m.route_id] and s > 0
                    and not no_restock[s] and not outage[s]):
                visit = ts + timedelta(minutes=visit_min - step_min, seconds=1)
                min_sale_sec = (visit - ts).seconds + 1
                for j in range(len(ms)):
                    if stock[j] < cap[j]:
                        add = int(cap[j] - stock[j])
                        restocks.append((visit, m.route_id, mid, ms.slot_id[j], ms.product_id[j], add, int(stock[j]), int(cap[j]), "scheduled"))
                        stock[j] = cap[j]

            # ---- thermal + electrical model ----
            a = amb[s]
            if outage[s]:
                target, tau_h = a, 4.0
                duty, cycles, power = 0.0, 0, 0.0
            elif fail[s]:
                target, tau_h = a, 3.0
                if not fail_sudden[s] and fail_phase[s] < cycles_phase_trip:
                    duty, cycles = 1.0, int(rng.integers(6, 11))  # short-cycling, not cooling
                else:
                    duty, cycles = 0.0, 0                          # thermal overload trip
                power = idle_w + duty * comp_w * 1.15 + rng.normal(0, 6)
            elif door[s]:
                target, tau_h = a - 4, 1.0
                duty, cycles = 1.0, int(rng.integers(1, 3))
                power = idle_w + comp_w + rng.normal(0, 8)
            else:
                target = SETPOINT_C + 0.04 * (a - 25)
                pulling_down = temp > SETPOINT_C + 1.5
                duty = 1.0 if pulling_down else float(np.clip(0.28 + 0.022 * (a - 20) + rng.normal(0, 0.05), 0.12, 0.97))
                cycles = int(rng.poisson(0.8 + 1.4 * duty)) if not pulling_down else 1
                power = idle_w + duty * comp_w + rng.normal(0, 6)
                tau_h = 0.35 if pulling_down else 0.25
            alpha = 1 - math.exp(-(STEP / 60) / tau_h)
            temp = temp + (target - temp) * alpha + rng.normal(0, 0.12)
            locked = temp > CHILLED_LOCKOUT_C

            # ---- spoilage: perishables written off once a warm spell of 2h+ ends ----
            if locked:
                warm_steps += 1
            else:
                if warm_steps >= 2 * STEPS_PER_H:
                    wo_ts = ts + timedelta(seconds=max(60, min_sale_sec))
                    for j in np.where(perish & (stock > 0))[0]:
                        restocks.append((wo_ts, m.route_id, mid, ms.slot_id[j], ms.product_id[j],
                                         -int(stock[j]), int(stock[j]), 0, "spoilage_writeoff"))
                        stock[j] = 0
                    min_sale_sec = (wo_ts - ts).seconds + 1
                warm_steps = 0

            # ---- demand ----
            heat = max(0.0, amb_out[s] - 30)
            w = pop.copy()
            w[np.isin(cats, ["beverage", "dairy"])] *= 1 + 0.07 * heat
            rate_mult = 1 + 0.015 * heat
            for (a0, a1, mult, spc) in spike_cats:
                if a0 <= s < a1:
                    if spc:
                        sel = np.isin(cats, spc)
                        share = w[sel].sum() / w.sum()
                        w[sel] *= mult
                        rate_mult *= 1 + (mult - 1) * share
                    else:
                        rate_mult *= mult
            lam = LOCATION_TYPES[loc]["base_rate"] * profiles[loc][h] * _dow_factor(loc, dow) * mfac * rate_mult / STEPS_PER_H
            n_cust = int(rng.poisson(lam))
            lost = 0
            if outage[s]:
                lost = n_cust
                n_cust = 0
            if n_cust:
                p = w / w.sum()
                for _ in range(n_cust):
                    j = int(rng.choice(len(ms), p=p))
                    avail = (stock > 0) & ~(chilled & locked)
                    if not avail[j]:
                        if avail.any() and rng.random() < 0.5:
                            pa = p * avail
                            j = int(rng.choice(len(ms), p=pa / pa.sum()))
                        else:
                            lost += 1
                            continue
                    card = rng.random() < cfg.card_share
                    if card and card_down[s]:
                        if rng.random() < 0.6:
                            lost += 1
                            continue
                        card = False
                    qty = 2 if (stock[j] >= 2 and rng.random() < 0.04) else 1
                    stock[j] -= qty
                    t_sale = ts + timedelta(seconds=int(rng.integers(min_sale_sec, STEP * 60)))
                    token = token_pool[m.city][int(rng.choice(300, p=zipf_w))] if card else ""
                    txns.append((t_sale, mid, ms.slot_id[j], ms.product_id[j], qty, float(prices[j]),
                                 float(prices[j] * qty), "card" if card else "cash", token))
            if lost:
                lost_log.append((mid, s, lost))

            telemetry.append((ts, mid, round(float(a), 2), round(float(temp), 2), round(duty * 100, 1), int(cycles),
                              round(max(0.0, float(power)), 1), bool(door[s]), not bool(card_down[s] or outage[s]),
                              int(stock.sum()), ",".join(labels[s])))

    tx = pd.DataFrame(txns, columns=["ts", "machine_id", "slot_id", "product_id", "qty", "unit_price", "amount", "payment_method", "card_token"])
    tx = tx.sort_values("ts").reset_index(drop=True)
    tx.insert(0, "txn_id", [f"TX-{i:07d}" for i in range(1, len(tx) + 1)])
    rs = pd.DataFrame(restocks, columns=["ts", "route_id", "machine_id", "slot_id", "product_id", "qty_added", "stock_before", "stock_after", "reason"])
    rs = rs.sort_values("ts").reset_index(drop=True)
    rs.insert(0, "restock_id", [f"RS-{i:06d}" for i in range(1, len(rs) + 1)])
    tel = pd.DataFrame(telemetry, columns=["ts", "machine_id", "ambient_c", "temp_c", "compressor_on_pct", "compressor_cycles",
                                           "power_w", "door_open", "card_reader_ok", "total_stock", "active_events"])
    inv = pd.DataFrame(inventory, columns=["ts", "machine_id", "slot_id", "stock"])
    lost_df = pd.DataFrame(lost_log, columns=["machine_id", "step", "lost"])
    return {"transactions": tx, "restocks": rs, "telemetry": tel, "inventory": inv, "_lost": lost_df, "_times": times}


# --------------------------------------------------------------------------- #
# 3. Maintenance tickets derived from telemetry
# --------------------------------------------------------------------------- #
def _runs(mask: np.ndarray, min_len: int) -> list[tuple[int, int]]:
    out, start = [], None
    for i, v in enumerate(np.append(mask, False)):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= min_len:
                out.append((start, i))
            start = None
    return out


def derive_tickets(master: dict, sim: dict, rng: np.random.Generator) -> pd.DataFrame:
    tel, machines, slots, products = sim["telemetry"], master["machines"], master["slots"], master["products"]
    lost = sim["_lost"]
    times = sim["_times"]
    route_of = machines.set_index("machine_id").route_id
    wh_of = master["routes"].set_index("route_id").warehouse_id
    price_map = products.set_index("product_id").unit_price
    avg_price = slots.assign(p=slots.product_id.map(price_map)).groupby("machine_id").p.mean()
    rs = sim["restocks"]
    tickets = []
    for mid, g in tel.groupby("machine_id", sort=True):
        g = g.reset_index(drop=True)
        lost_m = lost[lost.machine_id == mid]
        candidates = []
        power_off = (g.power_w == 0).to_numpy()
        for a, b in _runs(power_off, 2):
            candidates.append(("Power loss", a, b))
        warm = ((g.temp_c > CHILLED_LOCKOUT_C) & ~power_off).to_numpy()
        for a, b in _runs(warm, 2):
            door_share = g.door_open.iloc[a:b].mean()
            # Skip warm tails that are just the machine recovering after a power cut.
            if a > 0 and power_off[max(0, a - 1)]:
                continue
            candidates.append(("Door left open" if door_share > 0.5 else "Refrigeration failure", a, b))
        card = (~g.card_reader_ok & ~power_off).to_numpy()
        for a, b in _runs(card, 4):
            candidates.append(("Payment terminal fault", a, b))
        for fault, a, b in candidates:
            seg = g.iloc[a:b]
            hrs = (b - a) / STEPS_PER_H
            lv = int(lost_m[(lost_m.step >= a) & (lost_m.step < b + 2 * STEPS_PER_H)].lost.sum())
            opened = times[a] + timedelta(minutes=int(rng.integers(5, 16)))
            closed = times[min(b, len(times) - 1)] + timedelta(minutes=int(rng.integers(10, 40)))
            if fault == "Refrigeration failure":
                peak_cycles = int(seg.compressor_cycles.max())
                ev = f"Internal temp peaked at {seg.temp_c.max():.1f} C (ambient {seg.ambient_c.max():.1f} C); above 8 C for {hrs:.1f} h"
                if peak_cycles >= 6:
                    ev += f"; compressor short-cycling up to {peak_cycles} starts per 15 min before overload trip"
                prio = "P1" if seg.temp_c.max() > 15 or hrs > 4 else "P2"
            elif fault == "Door left open":
                ev = f"Door sensor open for {hrs:.1f} h; internal temp reached {seg.temp_c.max():.1f} C"
                prio = "P2" if hrs > 1.5 else "P3"
            elif fault == "Power loss":
                ev = f"0 W reported for {hrs:.1f} h; no vends possible"
                prio = "P1" if hrs >= 4 else "P2"
            else:
                ev = f"Card/wallet payments unavailable for {hrs:.1f} h"
                prio = "P3"
            spoiled = rs[(rs.machine_id == mid) & (rs.reason == "spoilage_writeoff") &
                         (rs.ts >= times[a]) & (rs.ts <= times[min(b + 1, len(times) - 1)] + timedelta(minutes=20))]
            if len(spoiled):
                ev += f"; {int(-spoiled.qty_added.sum())} perishable units written off"
            route = route_of[mid]
            tickets.append({
                "machine_id": int(mid), "route_id": route, "opened_at": opened, "closed_at": closed,
                "fault_type": fault, "priority": prio,
                "technician_code": f"TECH-{wh_of[route][2:]}{int(rng.integers(1, 4))}",
                "evidence": ev, "lost_vends": lv, "est_lost_revenue": round(lv * float(avg_price[mid]), 0),
            })
    df = pd.DataFrame(tickets, columns=["machine_id", "route_id", "opened_at", "closed_at", "fault_type", "priority",
                                        "technician_code", "evidence", "lost_vends", "est_lost_revenue"])
    df = df.sort_values("opened_at").reset_index(drop=True)
    df.insert(0, "ticket_id", [f"MT-{i:05d}" for i in range(1, len(df) + 1)])
    return df
