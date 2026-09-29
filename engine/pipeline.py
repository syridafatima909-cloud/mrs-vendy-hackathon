"""One call to go from config + scenario to a complete, validated dataset."""
from __future__ import annotations

import io
import json
import time
import zipfile
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .config import CURRENCY, GenConfig
from .documents import build_documents, render_pdf
from .generator import background_events, build_master, derive_tickets, simulate
from .schema import SCHEMA


@dataclass
class Dataset:
    config: GenConfig
    events: list[dict]
    tables: dict[str, pd.DataFrame]
    documents: dict[str, list[dict]]
    validation: list[dict]
    stats: dict = field(default_factory=dict)

    # ---------- summaries ----------
    def summary(self) -> dict:
        t = self.tables
        v = pd.DataFrame(self.validation)
        return {
            "config": self.config.to_dict(),
            "rows": {k: int(len(df)) for k, df in t.items()},
            "documents": {k: len(v_) for k, v_ in self.documents.items()},
            "revenue": float(t["transactions"].amount.sum()),
            "currency": CURRENCY,
            "tickets": int(len(t["maintenance_tickets"])),
            "checks_passed": int((v.status == "pass").sum()),
            "checks_total": int(len(v)),
            "trust_score": round(float((v.status == "pass").mean() * 100), 1) if len(v) else 0.0,
            "events": [e for e in self.events if not e.get("background")],
            "background_events": sum(1 for e in self.events if e.get("background")),
            "generation_seconds": self.stats.get("seconds"),
        }

    def scenario_impact(self) -> list[dict]:
        """Business impact of each injected event, for the UI and the API."""
        from .generator import affected_machines
        t = self.tables
        tx, tk, tel, m = t["transactions"], t["maintenance_tickets"], t["telemetry"], t["machines"]
        t0 = pd.Timestamp(self.config.start_date)
        out = []
        for ev in self.events:
            if ev.get("background"):
                continue
            a = t0 + pd.Timedelta(hours=ev["start_offset_h"])
            b = a + pd.Timedelta(hours=ev["duration_h"])
            hit = affected_machines(ev, m)
            if ev["type"] == "heatwave":
                cities = set(ev["targets"]["cities"]) | set(m.city[m.machine_id.isin(hit)])
                hit = set(m.machine_id[m.city.isin(cities)])
            w_tx = tx[tx.machine_id.isin(hit) & (tx.ts >= a) & (tx.ts < b)]
            w_tk = tk[tk.machine_id.isin(hit) & (tk.opened_at >= a - pd.Timedelta("1h")) & (tk.opened_at < b + pd.Timedelta("2h"))]
            w_tel = tel[tel.machine_id.isin(hit) & (tel.ts >= a) & (tel.ts < b)]
            out.append({
                "label": ev["label"], "type": ev["type"],
                "window": f"{a:%a %d %b %H:%M} → {b:%a %d %b %H:%M}",
                "machines": len(hit),
                "revenue_in_window": float(w_tx.amount.sum()),
                "tickets": int(len(w_tk)),
                "lost_vends": int(w_tk.lost_vends.sum()),
                "est_lost_revenue": float(w_tk.est_lost_revenue.sum()),
                "peak_temp_c": float(w_tel.temp_c.max()) if len(w_tel) else None,
                "peak_ambient_c": float(w_tel.ambient_c.max()) if len(w_tel) else None,
            })
        return out

    # ---------- export ----------
    def table_records(self, name: str, limit: int | None = None, offset: int = 0) -> list[dict]:
        df = self.tables[name].iloc[offset: None if limit is None else offset + limit]
        return json.loads(df.to_json(orient="records", date_format="iso"))

    def to_zip(self, include_pdfs: int = 25) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for name, df in self.tables.items():
                z.writestr(f"tables/{name}.csv", df.to_csv(index=False))
            for kind, docs in self.documents.items():
                z.writestr(f"documents/{kind}s.json", json.dumps(docs, indent=2, default=str))
                for d in docs[:include_pdfs]:
                    z.writestr(f"documents/pdf/{kind}/{d['doc_id']}.pdf", render_pdf(d))
            z.writestr("schema.json", json.dumps(SCHEMA, indent=2))
            z.writestr("scenario.json", json.dumps({"config": self.config.to_dict(), "events": self.events}, indent=2, default=str))
            z.writestr("validation_report.json", json.dumps(self.validation, indent=2))
        return buf.getvalue()


def generate_dataset(cfg: GenConfig, events: list[dict] | None = None) -> Dataset:
    started = time.perf_counter()
    events = list(events or [])
    rng = np.random.default_rng(cfg.seed)
    reserved = sorted({mid for e in events for mid in e["targets"].get("machine_ids", [])})
    cities = list(dict.fromkeys(c for e in events for c in e["targets"].get("cities", [])))
    locs = list(dict.fromkeys(l for e in events for l in e["targets"].get("location_types", [])))
    master = build_master(cfg, rng, reserved, cities, locs)
    all_events = events + (background_events(cfg, master["machines"], rng) if cfg.background_noise else [])
    sim = simulate(cfg, master, all_events, rng)
    tickets = derive_tickets(master, sim, rng)
    tables = {**master, **{k: v for k, v in sim.items() if not k.startswith("_")}, "maintenance_tickets": tickets}
    tables = {k: tables[k] for k in SCHEMA}  # stable order, schema-declared tables only
    from .validate import validate
    docs = build_documents(tables, cfg)
    report = validate(tables, docs, all_events, cfg)
    return Dataset(cfg, all_events, tables, docs, report, {"seconds": round(time.perf_counter() - started, 2)})
