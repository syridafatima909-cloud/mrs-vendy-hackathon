"""Structured business documents derived from the relational tables, plus PDF rendering.

- Sales invoices: one per machine for the period. Line items are aggregated from
  `transactions`, so the invoice total equals the machine's transaction sum.
- Purchase orders: one per warehouse. Quantities cover everything that warehouse's
  routes put into machines (`restocks`, reason = scheduled), rounded up to case packs.
- Service tickets: one per `maintenance_tickets` row, enriched with machine, route
  and warehouse details.
"""
from __future__ import annotations

import io
import math

import pandas as pd
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from .config import CURRENCY

OPERATOR = {"name": "VendGrid Fleet Services (Synthetic)", "address": "Plot 00, Synthetic Industrial Area", "ntn": "SYN-0000000"}
SITE_COMMISSION = 0.12
CASE_PACK = {"beverage": 24, "dairy": 12, "snack": 24, "confectionery": 36, "bakery": 12, "fresh_food": 6}
SUPPLIERS = {"beverage": "Synthetic Beverages Ltd", "dairy": "Synthetic Dairy Co", "snack": "Synthetic Snacks Pvt",
             "confectionery": "Synthetic Snacks Pvt", "bakery": "Synthetic Bakers", "fresh_food": "Synthetic Kitchens"}


def build_documents(t: dict, cfg) -> dict:
    machines = t["machines"].set_index("machine_id")
    routes = t["routes"].set_index("route_id")
    whs = t["warehouses"].set_index("warehouse_id")
    prods = t["products"].set_index("product_id")
    period_start = pd.Timestamp(cfg.start_date)
    period_end = period_start + pd.Timedelta(days=cfg.days) - pd.Timedelta(seconds=1)

    # ---- Sales invoices ----
    invoices = []
    tx = t["transactions"]
    for mid, g in tx.groupby("machine_id", sort=True):
        m = machines.loc[mid]
        lines = (g.groupby(["product_id", "unit_price"], as_index=False)
                  .agg(qty=("qty", "sum"), amount=("amount", "sum"), vends=("txn_id", "count")))
        lines["description"] = lines.product_id.map(prods.name)
        lines = lines.sort_values("amount", ascending=False)
        gross = float(lines.amount.sum())
        commission = round(gross * SITE_COMMISSION, 2)
        invoices.append({
            "doc_id": f"INV-{cfg.start_date:%Y%m}-{mid}",
            "doc_type": "invoice",
            "machine_id": int(mid),
            "site_name": m.site_name,
            "city": m.city,
            "route_id": m.route_id,
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "lines": [{"product_id": r.product_id, "description": r.description, "qty": int(r.qty),
                       "unit_price": float(r.unit_price), "amount": float(r.amount)} for r in lines.itertuples()],
            "vend_count": int(len(g)),
            "cash_total": float(g.loc[g.payment_method == "cash", "amount"].sum()),
            "card_total": float(g.loc[g.payment_method == "card", "amount"].sum()),
            "gross_sales": gross,
            "site_commission_rate": SITE_COMMISSION,
            "site_commission": commission,
            "net_to_operator": round(gross - commission, 2),
            "first_txn": g.txn_id.iloc[0],
            "last_txn": g.txn_id.iloc[-1],
        })

    # ---- Purchase orders ----
    pos = []
    rs = t["restocks"]
    sched = rs[rs.reason == "scheduled"].copy()
    sched["warehouse_id"] = sched.route_id.map(routes.warehouse_id)
    for wid, g in sched.groupby("warehouse_id", sort=True):
        need = g.groupby("product_id").qty_added.sum()
        lines = []
        for pid, q in need.items():
            cat = prods.category[pid]
            pack = CASE_PACK[cat]
            cases = math.ceil(q * 1.1 / pack)   # 10% safety stock, whole cases
            lines.append({"product_id": pid, "description": prods.name[pid], "supplier": SUPPLIERS[cat],
                          "restocked_units": int(q), "cases": cases, "case_pack": pack, "order_units": cases * pack,
                          "unit_cost": float(prods.unit_cost[pid]), "amount": float(cases * pack * prods.unit_cost[pid])})
        lines.sort(key=lambda x: (x["supplier"], x["product_id"]))
        w = whs.loc[wid]
        pos.append({
            "doc_id": f"PO-{cfg.start_date:%Y%m%d}-{wid}",
            "doc_type": "purchase_order",
            "warehouse_id": wid,
            "warehouse_name": w["name"],
            "city": w.city,
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "routes": sorted(g.route_id.unique().tolist()),
            "lines": lines,
            "total_units": int(sum(l["order_units"] for l in lines)),
            "total_amount": float(sum(l["amount"] for l in lines)),
        })

    # ---- Service tickets ----
    tickets = []
    for r in t["maintenance_tickets"].itertuples():
        m = machines.loc[r.machine_id]
        route = routes.loc[r.route_id]
        tickets.append({
            "doc_id": r.ticket_id,
            "doc_type": "service_ticket",
            "machine_id": int(r.machine_id),
            "site_name": m.site_name,
            "model": m.model,
            "city": m.city,
            "route_id": r.route_id,
            "warehouse_id": route.warehouse_id,
            "fault_type": r.fault_type,
            "priority": r.priority,
            "opened_at": pd.Timestamp(r.opened_at).isoformat(),
            "closed_at": pd.Timestamp(r.closed_at).isoformat(),
            "technician_code": r.technician_code,
            "evidence": r.evidence,
            "lost_vends": int(r.lost_vends),
            "est_lost_revenue": float(r.est_lost_revenue),
            "actions": _actions(r.fault_type),
        })
    return {"invoice": invoices, "purchase_order": pos, "service_ticket": tickets}


def _actions(fault: str) -> list[str]:
    return {
        "Refrigeration failure": ["Inspect compressor start relay and overload protector",
                                  "Check condenser coil and fan; clean if blocked",
                                  "Verify refrigerant pressure; recharge or replace compressor",
                                  "Discard perishable stock exposed above 8 C for 2 h+"],
        "Door left open": ["Close and latch service door", "Check door switch and gasket seal",
                           "Confirm pull-down to 4 C within 90 minutes"],
        "Power loss": ["Confirm site supply restored", "Check machine fuse and surge protector",
                       "Verify telemetry resumes and temperature recovers"],
        "Payment terminal fault": ["Power-cycle card reader", "Check reader cable and SIM signal",
                                   "Replace reader if fault persists"],
    }.get(fault, ["Inspect machine"])


# --------------------------------------------------------------------------- #
# PDF rendering
# --------------------------------------------------------------------------- #
INK = colors.HexColor("#1f2937")
ACCENT = colors.HexColor("#0f766e")
SHADE = colors.HexColor("#e6f2f1")
RULE = colors.HexColor("#cbd5e1")


def _money(x: float) -> str:
    return f"{CURRENCY} {x:,.2f}"


def _styles():
    ss = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("t", parent=ss["Title"], fontSize=18, textColor=ACCENT, alignment=0, spaceAfter=2),
        "sub": ParagraphStyle("s", parent=ss["Normal"], fontSize=9, textColor=colors.HexColor("#64748b")),
        "body": ParagraphStyle("b", parent=ss["Normal"], fontSize=9.5, textColor=INK, leading=13),
        "h": ParagraphStyle("h", parent=ss["Heading3"], fontSize=11, textColor=INK, spaceBefore=8, spaceAfter=4),
        "cell": ParagraphStyle("c", parent=ss["Normal"], fontSize=8.5, textColor=INK, leading=11),
    }


def _kv_table(pairs, st):
    data = [[Paragraph(f"<b>{k}</b>", st["cell"]), Paragraph(str(v), st["cell"])] for k, v in pairs]
    tbl = Table(data, colWidths=[42 * mm, 128 * mm])
    tbl.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.4, RULE), ("BACKGROUND", (0, 0), (0, -1), SHADE),
                             ("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 3),
                             ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    return tbl


def _line_table(header, rows, widths, st, total_rows=0):
    data = [[Paragraph(f"<b>{h}</b>", st["cell"]) for h in header]] + [[Paragraph(str(c), st["cell"]) for c in r] for r in rows]
    tbl = Table(data, colWidths=widths, repeatRows=1)
    style = [("GRID", (0, 0), (-1, -1), 0.4, RULE), ("BACKGROUND", (0, 0), (-1, 0), SHADE),
             ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]
    if total_rows:
        style.append(("BACKGROUND", (0, -total_rows), (-1, -1), colors.HexColor("#f1f5f9")))
    tbl.setStyle(TableStyle(style))
    return tbl


def _footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(colors.HexColor("#94a3b8"))
    canvas.drawString(18 * mm, 10 * mm, "SYNTHETIC DATA — generated for testing and demonstration. Contains no real persons or transactions.")
    canvas.drawRightString(192 * mm, 10 * mm, f"Page {doc.page}")
    canvas.restoreState()


def render_pdf(doc: dict) -> bytes:
    st = _styles()
    buf = io.BytesIO()
    pdf = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=18 * mm,
                            title=doc["doc_id"], author=OPERATOR["name"])
    story = []
    dt = doc["doc_type"]
    if dt == "invoice":
        story += [Paragraph("Sales Settlement Invoice", st["title"]),
                  Paragraph(f"{OPERATOR['name']} · {OPERATOR['address']} · NTN {OPERATOR['ntn']}", st["sub"]), Spacer(1, 8)]
        story.append(_kv_table([("Invoice no.", doc["doc_id"]), ("Machine", f"#{doc['machine_id']} — {doc['site_name']}"),
                                ("City / route", f"{doc['city']} / {doc['route_id']}"),
                                ("Period", f"{doc['period_start'][:10]} to {doc['period_end'][:10]}"),
                                ("Transactions", f"{doc['vend_count']} vends ({doc['first_txn']} … {doc['last_txn']})")], st))
        story.append(Paragraph("Line items (aggregated from transaction log)", st["h"]))
        rows = [[l["product_id"], l["description"], l["qty"], _money(l["unit_price"]), _money(l["amount"])] for l in doc["lines"]]
        rows += [["", "Gross sales", "", "", _money(doc["gross_sales"])],
                 ["", f"Site commission ({doc['site_commission_rate']:.0%}) payable to host", "", "", _money(doc["site_commission"])],
                 ["", "Net to operator", "", "", _money(doc["net_to_operator"])]]
        story.append(_line_table(["SKU", "Description", "Qty", "Unit price", "Amount"], rows,
                                 [22 * mm, 72 * mm, 14 * mm, 30 * mm, 32 * mm], st, total_rows=3))
        story.append(Spacer(1, 6))
        story.append(Paragraph(f"Payment split: cash {_money(doc['cash_total'])} · card/wallet {_money(doc['card_total'])}", st["body"]))
    elif dt == "purchase_order":
        story += [Paragraph("Restock Purchase Order", st["title"]),
                  Paragraph(f"{OPERATOR['name']} · {OPERATOR['address']}", st["sub"]), Spacer(1, 8)]
        story.append(_kv_table([("PO no.", doc["doc_id"]), ("Deliver to", f"{doc['warehouse_name']} ({doc['warehouse_id']}), {doc['city']}"),
                                ("Covers routes", ", ".join(doc["routes"])),
                                ("Basis", f"Units restocked {doc['period_start'][:10]} to {doc['period_end'][:10]} + 10% safety stock, rounded to case packs")], st))
        story.append(Paragraph("Order lines", st["h"]))
        rows = [[l["product_id"], l["description"], l["supplier"], l["restocked_units"], f"{l['cases']} × {l['case_pack']}",
                 _money(l["unit_cost"]), _money(l["amount"])] for l in doc["lines"]]
        rows.append(["", "Total", "", "", f"{doc['total_units']} units", "", _money(doc["total_amount"])])
        story.append(_line_table(["SKU", "Description", "Supplier", "Used", "Cases", "Unit cost", "Amount"], rows,
                                 [18 * mm, 42 * mm, 34 * mm, 13 * mm, 18 * mm, 21 * mm, 28 * mm], st, total_rows=1))
    else:
        story += [Paragraph(f"Maintenance Service Ticket — {doc['priority']}", st["title"]),
                  Paragraph(f"{OPERATOR['name']} · Field Service", st["sub"]), Spacer(1, 8)]
        story.append(_kv_table([("Ticket no.", doc["doc_id"]), ("Fault", doc["fault_type"]),
                                ("Machine", f"#{doc['machine_id']} — {doc['model']}"), ("Site", f"{doc['site_name']}, {doc['city']}"),
                                ("Route / depot", f"{doc['route_id']} / {doc['warehouse_id']}"),
                                ("Opened", doc["opened_at"].replace("T", " ")[:16]), ("Closed", doc["closed_at"].replace("T", " ")[:16]),
                                ("Technician", doc["technician_code"]), ("Telemetry evidence", doc["evidence"]),
                                ("Business impact", f"{doc['lost_vends']} lost vends, est. {_money(doc['est_lost_revenue'])}")], st))
        story.append(Paragraph("Checklist", st["h"]))
        for a in doc["actions"]:
            story.append(Paragraph(f"[&nbsp;&nbsp;] {a}", st["body"]))
        story.append(Spacer(1, 18))
        story.append(Paragraph("Technician signature: ______________________   Site sign-off: ______________________", st["body"]))
    pdf.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return buf.getvalue()
