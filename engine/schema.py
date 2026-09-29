"""Declarative schema for every generated table.

The validator reads this to check primary keys, foreign keys, nullability and
value ranges generically, so adding a table means adding it here first.
"""

SCHEMA = {
    "warehouses": {
        "pk": "warehouse_id",
        "columns": {
            "warehouse_id": "str", "name": "str", "city": "str",
            "lat": "float", "lon": "float", "capacity_units": "int",
        },
        "fks": {},
        "description": "Regional depots that hold stock and dispatch delivery routes.",
    },
    "routes": {
        "pk": "route_id",
        "columns": {
            "route_id": "str", "warehouse_id": "str", "route_name": "str",
            "driver_code": "str", "service_days": "str", "vehicle": "str",
        },
        "fks": {"warehouse_id": "warehouses.warehouse_id"},
        "description": "Delivery routes; each belongs to one warehouse.",
    },
    "machines": {
        "pk": "machine_id",
        "columns": {
            "machine_id": "int", "route_id": "str", "route_stop": "int", "site_name": "str",
            "location_type": "str", "city": "str", "lat": "float", "lon": "float",
            "model": "str", "install_date": "date", "slot_count": "int",
        },
        "fks": {"route_id": "routes.route_id"},
        "description": "Smart vending machines; each sits on one delivery route.",
    },
    "products": {
        "pk": "product_id",
        "columns": {
            "product_id": "str", "name": "str", "category": "str",
            "unit_cost": "float", "unit_price": "float", "chilled": "bool",
        },
        "fks": {},
        "description": "Product catalogue shared by the whole fleet.",
    },
    "slots": {
        "pk": "slot_id",
        "columns": {
            "slot_id": "str", "machine_id": "int", "slot_code": "str",
            "product_id": "str", "capacity": "int", "par_level": "int",
        },
        "fks": {"machine_id": "machines.machine_id", "product_id": "products.product_id"},
        "description": "Spiral slots inside a machine; each holds one product.",
    },
    "transactions": {
        "pk": "txn_id",
        "columns": {
            "txn_id": "str", "ts": "datetime", "machine_id": "int", "slot_id": "str",
            "product_id": "str", "qty": "int", "unit_price": "float", "amount": "float",
            "payment_method": "str", "card_token": "str",
        },
        "fks": {
            "machine_id": "machines.machine_id",
            "slot_id": "slots.slot_id",
            "product_id": "products.product_id",
        },
        "description": "Individual vends. card_token is a random surrogate, never a card number.",
    },
    "restocks": {
        "pk": "restock_id",
        "columns": {
            "restock_id": "str", "ts": "datetime", "route_id": "str", "machine_id": "int",
            "slot_id": "str", "product_id": "str", "qty_added": "int",
            "stock_before": "int", "stock_after": "int", "reason": "str",
        },
        "fks": {
            "route_id": "routes.route_id", "machine_id": "machines.machine_id",
            "slot_id": "slots.slot_id", "product_id": "products.product_id",
        },
        "description": "Stock movements other than vends: scheduled refills (+) and spoilage write-offs (-).",
    },
    "telemetry": {
        "pk": None,
        "columns": {
            "ts": "datetime", "machine_id": "int", "ambient_c": "float", "temp_c": "float",
            "compressor_on_pct": "float", "compressor_cycles": "int", "power_w": "float",
            "door_open": "bool", "card_reader_ok": "bool", "total_stock": "int",
            "active_events": "str",
        },
        "fks": {"machine_id": "machines.machine_id"},
        "description": "15-minute IoT telemetry per machine.",
    },
    "inventory": {
        "pk": None,
        "columns": {"ts": "datetime", "machine_id": "int", "slot_id": "str", "stock": "int"},
        "fks": {"machine_id": "machines.machine_id", "slot_id": "slots.slot_id"},
        "description": "Hourly per-slot stock snapshots, derived from vends and restocks.",
    },
    "maintenance_tickets": {
        "pk": "ticket_id",
        "columns": {
            "ticket_id": "str", "machine_id": "int", "route_id": "str", "opened_at": "datetime",
            "closed_at": "datetime", "fault_type": "str", "priority": "str",
            "technician_code": "str", "evidence": "str", "lost_vends": "int",
            "est_lost_revenue": "float",
        },
        "fks": {"machine_id": "machines.machine_id", "route_id": "routes.route_id"},
        "description": "Service tickets opened automatically from telemetry anomalies.",
    },
}

# Plain-language relationship list for the ER diagram and the /schema endpoint.
RELATIONSHIPS = [
    ("warehouses", "routes", "1:N"),
    ("routes", "machines", "1:N"),
    ("machines", "slots", "1:N"),
    ("products", "slots", "1:N"),
    ("slots", "transactions", "1:N"),
    ("slots", "restocks", "1:N"),
    ("machines", "telemetry", "1:N"),
    ("slots", "inventory", "1:N"),
    ("machines", "maintenance_tickets", "1:N"),
]
