"""Intent-driven scenario engine.

A scenario is a list of *events*. Every event has the same shape:

    {
      "type": "compressor_failure",
      "targets": {"machine_ids": [404], "cities": [], "location_types": [], "route_ids": []},
      "start_offset_h": 50.0,        # hours after the dataset start
      "duration_h": 18.0,
      "params": {"mode": "gradual"},
      "label": "Compressor failure on machine 404"
    }

Prompts are turned into events either by an LLM (when ANTHROPIC_API_KEY is set)
or by the deterministic rule parser below. Both paths go through `normalize_event`,
so the simulator only ever sees validated events.
"""
from __future__ import annotations

import json
import os
import re

from .config import CITIES, LOCATION_TYPES, GenConfig

EVENT_TYPES = {
    "heatwave": {
        "desc": "Ambient temperature rises in the targeted cities; cold-drink demand rises, compressors work harder.",
        "params": {"delta_c": 6.0},
        "default_duration_h": 72,
    },
    "compressor_failure": {
        "desc": "Refrigeration fails; internal temperature drifts to ambient, chilled slots lock out above 8 C.",
        "params": {"mode": "gradual"},
        "default_duration_h": 20,
    },
    "power_outage": {
        "desc": "Machine loses power: no vends, no cooling, telemetry reports 0 W.",
        "params": {},
        "default_duration_h": 6,
    },
    "demand_spike": {
        "desc": "Sales multiply for the targeted machines or categories (exam week, event, festival).",
        "params": {"multiplier": 3.0, "categories": []},
        "default_duration_h": 48,
    },
    "restock_delay": {
        "desc": "Scheduled restocks are skipped for the targeted routes or machines.",
        "params": {},
        "default_duration_h": 96,
    },
    "card_reader_failure": {
        "desc": "Card and wallet payments fail; only cash customers can buy.",
        "params": {},
        "default_duration_h": 24,
    },
    "door_left_open": {
        "desc": "Service door left ajar; temperature climbs and the door sensor stays on.",
        "params": {},
        "default_duration_h": 3,
    },
}

EXAMPLE_PROMPTS = [
    "Simulate a cooling compressor failure on Machine #404 during a heatwave on day 3",
    "Exam week at universities: triple beverage and snack demand from day 2 for 3 days",
    "Power outage in Karachi on day 4 at 2pm for 8 hours",
    "Card reader failure on machine 117 for 2 days and delay restocks on route R-02-1",
    "Heatwave in Lahore and Multan from day 1 for 4 days, +11C",
    "Someone left the door open on machine 130 on day 5 at 9pm",
]

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


# --------------------------------------------------------------------------- #
# Normalisation (shared by rule and LLM paths)
# --------------------------------------------------------------------------- #
def normalize_event(ev: dict, cfg: GenConfig) -> dict:
    etype = ev.get("type")
    if etype not in EVENT_TYPES:
        raise ValueError(f"Unknown event type: {etype!r}")
    spec = EVENT_TYPES[etype]
    t = ev.get("targets") or {}
    targets = {
        "machine_ids": sorted({int(m) for m in t.get("machine_ids", []) if str(m).isdigit()}),
        "cities": [c for c in t.get("cities", []) if c in CITIES],
        "location_types": [l for l in t.get("location_types", []) if l in LOCATION_TYPES],
        "route_ids": [str(r).upper() for r in t.get("route_ids", [])],
    }
    horizon = cfg.days * 24
    start = float(ev.get("start_offset_h", horizon * 0.4))
    start = max(0.0, min(start, horizon - 1))
    duration = float(ev.get("duration_h") or spec["default_duration_h"])
    duration = max(0.25, min(duration, horizon - start))
    params = dict(spec["params"])
    params.update(ev.get("params") or {})
    if etype == "demand_spike":
        params["multiplier"] = float(max(0.1, min(float(params["multiplier"]), 10)))
    if etype == "heatwave":
        params["delta_c"] = float(max(1, min(float(params["delta_c"]), 20)))
    return {
        "type": etype,
        "targets": targets,
        "start_offset_h": round(start, 2),
        "duration_h": round(duration, 2),
        "params": params,
        "label": ev.get("label") or _default_label(etype, targets),
    }


def _default_label(etype: str, targets: dict) -> str:
    where = []
    if targets["machine_ids"]:
        where.append("machine " + ", ".join(f"#{m}" for m in targets["machine_ids"]))
    if targets["cities"]:
        where.append(", ".join(targets["cities"]))
    if targets["location_types"]:
        plural = {"university": "universities", "metro_station": "metro stations", "petrol_station": "petrol stations"}
        where.append(", ".join(plural.get(l, l + "s") for l in targets["location_types"]))
    if targets["route_ids"]:
        where.append("route " + ", ".join(targets["route_ids"]))
    name = etype.replace("_", " ").capitalize()
    if etype == "heatwave" and targets["machine_ids"] and not targets["cities"]:
        return f"{name} — city around machine " + ", ".join(f"#{m}" for m in targets["machine_ids"])
    return f"{name} — {'; '.join(where) if where else 'whole fleet'}"


# --------------------------------------------------------------------------- #
# Rule-based parser (offline, deterministic)
# --------------------------------------------------------------------------- #
_TYPE_PATTERNS = [
    ("compressor_failure", r"compressor|cooling (?:fail|failure|fault|broke)|refrigerat\w* (?:fail|fault)|fridge (?:fail|broke)"),
    ("heatwave", r"heat ?wave|heatwave|extreme heat|hot spell|scorching|\+\s*\d+\s*°?\s*c\b"),
    ("power_outage", r"power (?:outage|cut|failure)|blackout|load ?shedding|outage"),
    ("demand_spike", r"spike|surge|rush|exam week|festival|event|double|triple|\d+(?:\.\d+)?\s*x\b|demand"),
    ("restock_delay", r"restock\w* (?:delay|miss|skip)|delay\w* restock|missed restock|no restock|driver strike|truck breakdown"),
    ("card_reader_failure", r"card reader|payment (?:fail|outage)|card (?:fail|outage)|cashless (?:fail|down)"),
    ("door_left_open", r"door (?:left )?open|door ajar|left the door"),
]

_LOCATION_KEYWORDS = {
    "university": r"universit|campus|student|exam",
    "hospital": r"hospital|clinic",
    "office": r"office|corporate",
    "mall": r"\bmall|shopping",
    "metro_station": r"metro|station|commuter",
    "petrol_station": r"petrol|fuel|gas station",
}

_CATEGORY_KEYWORDS = {
    "beverage": r"beverage|drink|soda|water|juice",
    "snack": r"snack|crisp|chips",
    "confectionery": r"chocolate|candy|confection|sweet",
    "dairy": r"dairy|milk|yog",
    "fresh_food": r"sandwich|fresh food|wrap|meal",
    "bakery": r"bakery|biscuit|cookie",
}


def _split_clauses(text: str) -> list[str]:
    parts = re.split(r"\s*(?:;|\band then\b|\band also\b|\. )\s*|\s+and\s+(?=(?:delay|a |an |heat|power|card|door|triple|double|exam|spike|surge|restock))", text)
    return [p for p in parts if p and p.strip()]


def _parse_time(text: str, cfg: GenConfig) -> tuple[float | None, float | None]:
    start_h = None
    m = re.search(r"day\s*(\d+)", text)
    if m:
        start_h = (int(m.group(1)) - 1) * 24
    else:
        for i, wd in enumerate(WEEKDAYS):
            if wd in text:
                offset = (i - cfg.start_date.weekday()) % 7
                start_h = offset * 24
                break
    if start_h is not None:
        tm = re.search(r"(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)", text)
        if tm:
            hour = int(tm.group(1)) % 12 + (12 if tm.group(3) == "pm" else 0)
            start_h += hour + int(tm.group(2) or 0) / 60
        elif "morning" in text:
            start_h += 8
        elif "evening" in text or "night" in text:
            start_h += 20
        elif "afternoon" in text:
            start_h += 14
        else:
            start_h += 12
    dur_h = None
    d = re.search(r"for\s*(\d+(?:\.\d+)?)\s*(hour|hr|h\b|day|week)", text)
    if d:
        n = float(d.group(1))
        unit = d.group(2)
        dur_h = n * (24 if unit.startswith("day") else 168 if unit.startswith("week") else 1)
    return start_h, dur_h


def _parse_targets(text: str) -> dict:
    machine_ids = [int(x) for x in re.findall(r"(?:machine|vm|unit|kiosk)s?\s*(?:no\.?|number)?\s*#?\s*(\d{2,4})", text)]
    machine_ids += [int(x) for x in re.findall(r"#\s*(\d{2,4})", text)]
    cities = [c for c in CITIES if c.lower() in text]
    loc_types = [lt for lt, pat in _LOCATION_KEYWORDS.items() if re.search(pat, text)]
    routes = [r.upper() for r in re.findall(r"\b(r-\d{2}-\d)\b", text)]
    return {
        "machine_ids": sorted(set(machine_ids)),
        "cities": cities,
        "location_types": loc_types if not machine_ids else [],
        "route_ids": routes,
    }


def rule_parse(prompt: str, cfg: GenConfig) -> list[dict]:
    text = prompt.lower()
    events: list[dict] = []
    for clause in _split_clauses(text):
        types = [t for t, pat in _TYPE_PATTERNS if re.search(pat, clause)]
        # "during a heatwave" should not also trigger a demand spike.
        if "demand_spike" in types and len(types) > 1 and not re.search(r"spike|surge|rush|exam|festival|double|triple|\d\s*x\b", clause):
            types.remove("demand_spike")
        if not types:
            continue
        start_h, dur_h = _parse_time(clause, cfg)
        targets = _parse_targets(clause)
        for etype in types:
            ev = {"type": etype, "targets": dict(targets), "params": {}}
            if start_h is not None:
                ev["start_offset_h"] = start_h
            if dur_h is not None:
                ev["duration_h"] = dur_h
            if etype == "heatwave":
                dm = re.search(r"\+\s*(\d+(?:\.\d+)?)\s*°?\s*c", clause)
                if dm:
                    ev["params"]["delta_c"] = float(dm.group(1))
                # Heatwave rolls in before a failure and outlasts it.
                if "compressor_failure" in types:
                    if start_h is not None:
                        ev["start_offset_h"] = max(0, start_h - 24)
                    ev["duration_h"] = dur_h or 72
            if etype == "compressor_failure" and "heatwave" in types and start_h is None:
                ev["start_offset_h"] = cfg.days * 24 * 0.4 + 14
            if etype == "demand_spike":
                mult = 3.0
                if "double" in clause:
                    mult = 2.0
                elif "triple" in clause:
                    mult = 3.0
                elif "quadruple" in clause:
                    mult = 4.0
                mm = re.search(r"(\d+(?:\.\d+)?)\s*x\b", clause)
                if mm:
                    mult = float(mm.group(1))
                ev["params"]["multiplier"] = mult
                ev["params"]["categories"] = [c for c, p in _CATEGORY_KEYWORDS.items() if re.search(p, clause)]
            events.append(ev)
    return [normalize_event(e, cfg) for e in events]


# --------------------------------------------------------------------------- #
# LLM parser (optional)
# --------------------------------------------------------------------------- #
LLM_SYSTEM = """You convert a natural-language request into edge-case events for a vending-machine fleet simulator.
Return ONLY a JSON object: {"events": [ ... ]}. Each event:
{"type": one of %(types)s,
 "targets": {"machine_ids": [int], "cities": [str], "location_types": [str], "route_ids": [str]},
 "start_offset_h": number (hours after dataset start; day N starts at (N-1)*24),
 "duration_h": number,
 "params": object,
 "label": short human description}
Event meanings: %(desc)s
Params: heatwave {"delta_c": number}; demand_spike {"multiplier": number, "categories": [%(cats)s]}; compressor_failure {"mode": "gradual"|"sudden"}.
Valid cities: %(cities)s. Valid location types: %(locs)s. Route ids look like R-01-2.
The dataset covers %(days)d days. Leave targets empty to affect the whole fleet.
If a failure happens "during" a heatwave, emit both events and start the heatwave earlier than the failure."""


def llm_parse(prompt: str, cfg: GenConfig, timeout: float = 25.0) -> list[dict]:
    import httpx

    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    system = LLM_SYSTEM % {
        "types": list(EVENT_TYPES),
        "desc": "; ".join(f"{k}: {v['desc']}" for k, v in EVENT_TYPES.items()),
        "cats": ", ".join(_CATEGORY_KEYWORDS),
        "cities": ", ".join(CITIES),
        "locs": ", ".join(LOCATION_TYPES),
        "days": cfg.days,
    }
    resp = httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={
            "model": os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
            "max_tokens": 1200,
            "system": system,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=timeout,
    )
    resp.raise_for_status()
    text = "".join(b.get("text", "") for b in resp.json().get("content", []))
    match = re.search(r"\{.*\}", text, re.S)
    data = json.loads(match.group(0) if match else text)
    return [normalize_event(e, cfg) for e in data.get("events", [])]


def parse_intent(prompt: str, cfg: GenConfig, use_llm: bool = True) -> dict:
    """Return {"events": [...], "engine": "llm"|"rules", "notes": [...]}."""
    notes = []
    if not prompt or not prompt.strip():
        return {"events": [], "engine": "none", "notes": ["Empty prompt: baseline data only."]}
    if use_llm and os.environ.get("ANTHROPIC_API_KEY"):
        try:
            events = llm_parse(prompt, cfg)
            if events:
                return {"events": events, "engine": "llm", "notes": notes}
            notes.append("LLM returned no events; used rule parser.")
        except Exception as exc:  # network, quota, bad JSON
            notes.append(f"LLM parser unavailable ({type(exc).__name__}); used rule parser.")
    events = rule_parse(prompt, cfg)
    if not events:
        notes.append("No known edge case recognised. Try words like heatwave, compressor, outage, spike, restock delay, card reader.")
    return {"events": events, "engine": "rules", "notes": notes}
