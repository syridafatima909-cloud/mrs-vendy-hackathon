"""Static reference data and generation settings.

Everything region-specific lives here, so switching the platform to another
country is a matter of editing this one file.
"""
from dataclasses import dataclass, field
from datetime import date

CURRENCY = "PKR"

# City -> (lat, lon, mean summer temperature in C, daily swing in C)
CITIES = {
    "Islamabad": (33.6844, 73.0479, 31.0, 7.0),
    "Rawalpindi": (33.5651, 73.0169, 32.0, 7.0),
    "Lahore": (31.5204, 74.3587, 34.0, 6.5),
    "Karachi": (24.8607, 67.0011, 31.5, 4.5),
    "Peshawar": (34.0151, 71.5249, 33.5, 7.5),
    "Multan": (30.1575, 71.5249, 36.0, 7.0),
}

# Location type -> average vends per hour, demand peaks (hour of day), open hours, indoor?
LOCATION_TYPES = {
    "university": {"base_rate": 2.0, "peaks": (10, 13, 16), "open": (7, 22), "indoor": True},
    "hospital": {"base_rate": 1.6, "peaks": (9, 14, 20), "open": (0, 24), "indoor": True},
    "office": {"base_rate": 1.4, "peaks": (9, 13, 17), "open": (7, 21), "indoor": True},
    "mall": {"base_rate": 2.2, "peaks": (15, 19, 21), "open": (10, 23), "indoor": True},
    "metro_station": {"base_rate": 2.6, "peaks": (8, 13, 18), "open": (5, 24), "indoor": False},
    "petrol_station": {"base_rate": 1.2, "peaks": (8, 14, 22), "open": (0, 24), "indoor": False},
}

MACHINE_MODELS = {
    # model -> (idle watts, compressor watts, slots). All are refrigerated combo units.
    "ColdVend CV-24": (70, 320, 24),
    "ColdVend CV-30": (80, 360, 30),
    "ComboVend CB-24": (65, 300, 24),
}

# (sku, name, category, unit_cost, unit_price, chilled, popularity)
PRODUCTS = [
    ("BEV-001", "Mineral Water 500ml", "beverage", 45, 80, True, 1.6),
    ("BEV-002", "Mineral Water 1.5L", "beverage", 75, 130, True, 0.8),
    ("BEV-003", "Cola 345ml Can", "beverage", 85, 150, True, 1.5),
    ("BEV-004", "Lemon Lime 345ml Can", "beverage", 85, 150, True, 1.0),
    ("BEV-005", "Orange Soda 345ml Can", "beverage", 85, 150, True, 0.8),
    ("BEV-006", "Iced Tea Peach 330ml", "beverage", 90, 160, True, 0.9),
    ("BEV-007", "Energy Drink 250ml", "beverage", 180, 300, True, 1.1),
    ("BEV-008", "Mango Juice 200ml", "beverage", 55, 100, True, 1.2),
    ("BEV-009", "Apple Juice 200ml", "beverage", 55, 100, True, 0.7),
    ("BEV-010", "Sports Drink 500ml", "beverage", 120, 210, True, 0.8),
    ("DRY-001", "Flavoured Milk 225ml", "dairy", 70, 130, True, 0.9),
    ("DRY-002", "Yogurt Drink 250ml", "dairy", 60, 110, True, 0.7),
    ("DRY-003", "Cold Coffee 240ml", "dairy", 140, 240, True, 0.8),
    ("SNK-001", "Salted Crisps 45g", "snack", 45, 80, False, 1.3),
    ("SNK-002", "Masala Crisps 45g", "snack", 45, 80, False, 1.4),
    ("SNK-003", "Nimko Mix 60g", "snack", 40, 70, False, 0.9),
    ("SNK-004", "Popcorn Butter 40g", "snack", 50, 90, False, 0.6),
    ("SNK-005", "Roasted Peanuts 50g", "snack", 35, 60, False, 0.5),
    ("CON-001", "Chocolate Bar 40g", "confectionery", 70, 120, False, 1.2),
    ("CON-002", "Wafer Bar 35g", "confectionery", 30, 50, False, 1.0),
    ("CON-003", "Chewing Gum Pack", "confectionery", 25, 40, False, 0.6),
    ("CON-004", "Caramel Toffee Pack", "confectionery", 40, 70, False, 0.5),
    ("BAK-001", "Chocolate Chip Cookies", "bakery", 55, 100, False, 1.0),
    ("BAK-002", "Cake Rusk 150g", "bakery", 60, 110, False, 0.5),
    ("BAK-003", "Digestive Biscuits", "bakery", 50, 90, False, 0.7),
    ("SAN-001", "Chicken Sandwich", "fresh_food", 150, 280, True, 0.9),
    ("SAN-002", "Vegetable Wrap", "fresh_food", 130, 250, True, 0.6),
    ("SAN-003", "Fruit Cup 200g", "fresh_food", 110, 200, True, 0.5),
]

CHILLED_LOCKOUT_C = 8.0   # food-safety lockout threshold for chilled slots
SETPOINT_C = 4.0          # healthy internal temperature
TELEMETRY_STEP_MIN = 15   # telemetry resolution
INVENTORY_STEP_MIN = 60   # inventory snapshot resolution


@dataclass
class GenConfig:
    seed: int = 42
    n_warehouses: int = 3
    routes_per_warehouse: int = 3
    machines_per_route: int = 5
    days: int = 7
    start_date: date = field(default_factory=lambda: date(2026, 6, 1))
    card_share: float = 0.55           # share of card/wallet payments
    restock_days: tuple = (0, 3)       # weekdays each route is serviced (Mon, Thu)
    background_noise: bool = True      # small random real-world faults (brief outages, glitches)

    @property
    def n_machines(self) -> int:
        return self.n_warehouses * self.routes_per_warehouse * self.machines_per_route

    def to_dict(self) -> dict:
        return {
            "seed": self.seed,
            "n_warehouses": self.n_warehouses,
            "routes_per_warehouse": self.routes_per_warehouse,
            "machines_per_route": self.machines_per_route,
            "days": self.days,
            "start_date": self.start_date.isoformat(),
            "card_share": self.card_share,
            "restock_days": list(self.restock_days),
            "background_noise": self.background_noise,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "GenConfig":
        d = dict(d or {})
        if "start_date" in d and isinstance(d["start_date"], str):
            d["start_date"] = date.fromisoformat(d["start_date"])
        if "restock_days" in d:
            d["restock_days"] = tuple(d["restock_days"])
        allowed = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(**allowed)
