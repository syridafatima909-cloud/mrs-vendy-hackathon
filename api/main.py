"""REST API for the synthetic vending-fleet data platform.

Run:  uvicorn api.main:app --reload --port 8000
Docs: http://localhost:8000/docs
"""
from __future__ import annotations

import json
import uuid
from collections import OrderedDict
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from engine.config import GenConfig
from engine.documents import render_pdf
from engine.pipeline import Dataset, generate_dataset
from engine.scenarios import EVENT_TYPES, EXAMPLE_PROMPTS, normalize_event, parse_intent
from engine.schema import RELATIONSHIPS, SCHEMA

app = FastAPI(
    title="Mrs Vendy — Synthetic Vending Fleet Data API",
    version="1.0.0",
    description="Schema-aware, privacy-safe synthetic data for smart vending fleets: telemetry, relational supply chain, documents and AI-driven edge cases.",
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

MAX_DATASETS = 8
STORE: "OrderedDict[str, Dataset]" = OrderedDict()


class ConfigIn(BaseModel):
    seed: int = 42
    n_warehouses: int = Field(3, ge=1, le=6)
    routes_per_warehouse: int = Field(3, ge=1, le=6)
    machines_per_route: int = Field(5, ge=1, le=12)
    days: int = Field(7, ge=1, le=31)
    start_date: str = "2026-06-01"
    card_share: float = Field(0.55, ge=0, le=1)
    background_noise: bool = True


class ParseIn(BaseModel):
    prompt: str
    config: ConfigIn = ConfigIn()
    use_llm: bool = True


class GenerateIn(BaseModel):
    config: ConfigIn = ConfigIn()
    prompt: str | None = Field(None, description="Natural-language edge cases, e.g. 'compressor failure on machine 404 during a heatwave'")
    events: list[dict[str, Any]] | None = Field(None, description="Explicit events (skip the parser). Takes priority over prompt.")
    use_llm: bool = True


def _get(ds_id: str) -> Dataset:
    ds = STORE.get(ds_id)
    if ds is None:
        raise HTTPException(404, f"Dataset {ds_id} not found (datasets live in memory; regenerate with the same seed to reproduce).")
    STORE.move_to_end(ds_id)
    return ds


@app.get("/health")
def health():
    return {"status": "ok", "datasets_cached": len(STORE)}


@app.get("/schema")
def schema():
    return {"tables": SCHEMA, "relationships": [{"parent": a, "child": b, "cardinality": c} for a, b, c in RELATIONSHIPS]}


@app.get("/scenarios/catalog")
def scenario_catalog():
    return {"event_types": EVENT_TYPES, "examples": EXAMPLE_PROMPTS}


@app.post("/scenarios/parse")
def scenario_parse(body: ParseIn):
    cfg = GenConfig.from_dict(body.config.model_dump())
    return parse_intent(body.prompt, cfg, use_llm=body.use_llm)


@app.post("/datasets")
def create_dataset(body: GenerateIn):
    cfg = GenConfig.from_dict(body.config.model_dump())
    parsed = {"engine": "explicit", "notes": []}
    if body.events is not None:
        try:
            events = [normalize_event(e, cfg) for e in body.events]
        except (ValueError, KeyError, TypeError) as exc:
            raise HTTPException(422, f"Invalid event: {exc}")
    elif body.prompt:
        parsed = parse_intent(body.prompt, cfg, use_llm=body.use_llm)
        events = parsed["events"]
    else:
        events = []
    ds = generate_dataset(cfg, events)
    ds_id = uuid.uuid4().hex[:10]
    STORE[ds_id] = ds
    while len(STORE) > MAX_DATASETS:
        STORE.popitem(last=False)
    return {"dataset_id": ds_id, "parser": {"engine": parsed["engine"], "notes": parsed["notes"]},
            "summary": ds.summary(), "scenario_impact": ds.scenario_impact()}


@app.get("/datasets/{ds_id}")
def dataset_summary(ds_id: str):
    ds = _get(ds_id)
    return {"summary": ds.summary(), "scenario_impact": ds.scenario_impact()}


@app.get("/datasets/{ds_id}/tables/{table}")
def get_table(ds_id: str, table: str, format: Literal["json", "csv"] = "json",
              limit: int = Query(500, ge=1, le=100_000), offset: int = Query(0, ge=0),
              machine_id: int | None = None):
    ds = _get(ds_id)
    if table not in ds.tables:
        raise HTTPException(404, f"Unknown table. Choose from {list(ds.tables)}")
    df = ds.tables[table]
    if machine_id is not None and "machine_id" in df.columns:
        df = df[df.machine_id == machine_id]
    total = len(df)
    df = df.iloc[offset: offset + limit]
    if format == "csv":
        return Response(df.to_csv(index=False), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="{table}.csv"'})
    return JSONResponse({"table": table, "total": total, "offset": offset, "limit": limit,
                         "rows": json.loads(df.to_json(orient="records", date_format="iso"))})


@app.get("/datasets/{ds_id}/validation")
def get_validation(ds_id: str):
    ds = _get(ds_id)
    s = ds.summary()
    return {"trust_score": s["trust_score"], "passed": s["checks_passed"], "total": s["checks_total"], "checks": ds.validation}


@app.get("/datasets/{ds_id}/documents/{doc_type}")
def list_documents(ds_id: str, doc_type: Literal["invoice", "purchase_order", "service_ticket"]):
    ds = _get(ds_id)
    return {"doc_type": doc_type, "count": len(ds.documents[doc_type]), "documents": ds.documents[doc_type]}


@app.get("/datasets/{ds_id}/documents/{doc_type}/{doc_id}")
def get_document(ds_id: str, doc_type: Literal["invoice", "purchase_order", "service_ticket"], doc_id: str,
                 format: Literal["json", "pdf"] = "json"):
    ds = _get(ds_id)
    doc = next((d for d in ds.documents[doc_type] if d["doc_id"] == doc_id), None)
    if doc is None:
        raise HTTPException(404, "Document not found")
    if format == "pdf":
        return Response(render_pdf(doc), media_type="application/pdf",
                        headers={"Content-Disposition": f'inline; filename="{doc_id}.pdf"'})
    return doc


@app.get("/datasets/{ds_id}/export.zip")
def export_zip(ds_id: str, pdfs: int = Query(25, ge=0, le=500)):
    ds = _get(ds_id)
    return Response(ds.to_zip(include_pdfs=pdfs), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="mrs_vendy_{ds_id}.zip"'})
