"""Smoke tests. Run: pytest -q"""
import pandas as pd
from fastapi.testclient import TestClient

from api.main import app
from engine.config import GenConfig
from engine.documents import render_pdf
from engine.pipeline import generate_dataset
from engine.scenarios import EXAMPLE_PROMPTS, parse_intent

SMALL = GenConfig(n_warehouses=2, routes_per_warehouse=2, machines_per_route=3, days=4, seed=11)


def test_parser_understands_headline_prompt():
    evs = parse_intent("Simulate a cooling compressor failure on Machine #404 during a heatwave on day 2", SMALL, use_llm=False)["events"]
    assert {e["type"] for e in evs} == {"compressor_failure", "heatwave"}
    assert all(404 in e["targets"]["machine_ids"] for e in evs)


def test_every_example_prompt_parses():
    for p in EXAMPLE_PROMPTS:
        assert parse_intent(p, GenConfig(), use_llm=False)["events"], p


def test_dataset_passes_all_checks():
    evs = []
    for p in EXAMPLE_PROMPTS:
        evs += parse_intent(p, SMALL, use_llm=False)["events"]
    ds = generate_dataset(SMALL, evs)
    report = pd.DataFrame(ds.validation)
    failed = report[report.status != "pass"]
    assert failed.empty, failed.to_string()
    assert 404 in set(ds.tables["machines"].machine_id)


def test_pdfs_render():
    ds = generate_dataset(SMALL, [])
    for kind, docs in ds.documents.items():
        if docs:
            assert render_pdf(docs[0])[:4] == b"%PDF"


def test_api_round_trip():
    c = TestClient(app)
    r = c.post("/datasets", json={"config": {"days": 2, "machines_per_route": 2, "n_warehouses": 1},
                                  "prompt": "power outage on machine 250 on day 1 at 3pm for 4 hours", "use_llm": False})
    assert r.status_code == 200, r.text
    ds_id = r.json()["dataset_id"]
    assert c.get(f"/datasets/{ds_id}/validation").json()["passed"] > 0
    rows = c.get(f"/datasets/{ds_id}/tables/telemetry", params={"machine_id": 250}).json()
    assert rows["total"] == 2 * 96
    assert c.get(f"/datasets/{ds_id}/export.zip", params={"pdfs": 1}).status_code == 200


def test_privacy_scan_catches_planted_pii():
    from engine.validate import validate
    ds = generate_dataset(SMALL, [])
    t = {k: v.copy() for k, v in ds.tables.items()}
    t["machines"].loc[0, "site_name"] = "ali@example.com 0300-1234567 12345-1234567-1 4111111111111111"
    priv = [c for c in validate(t, ds.documents, ds.events, SMALL) if c["group"] == "privacy"]
    assert sum(c["status"] == "fail" for c in priv) == 4
