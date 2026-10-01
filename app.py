"""FreeZer - a tiny freezer inventory app.

Runs on Flask + stdlib sqlite3. No dependencies beyond Flask.

    python3 app.py            # http://127.0.0.1:5177
    python3 app.py --port 8000
"""

from __future__ import annotations

import argparse
import calendar
import os
import sqlite3
from datetime import date, datetime, timedelta

from flask import Flask, g, jsonify, render_template, request

DB_PATH = os.environ.get("FREEZER_DB") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "freezer.db"
)

# Rule-of-thumb freezer shelf life at -18 C, in months. Used to pre-fill the
# best-before date when an item is added; always overridable per item.
CATEGORIES: list[dict] = [
    {"name": "Okse / lam (bøffer, steg)", "months": 12},
    {"name": "Svin (koteletter, steg)", "months": 6},
    {"name": "Hakket kød", "months": 4},
    {"name": "Fjerkræ, hel", "months": 12},
    {"name": "Fjerkræ, stykker", "months": 9},
    {"name": "Bacon / pølser / pålæg", "months": 2},
    {"name": "Tilberedt kød & rester", "months": 3},
    {"name": "Fisk, mager (torsk, kuller)", "months": 6},
    {"name": "Fisk, fed (laks, makrel)", "months": 3},
    {"name": "Skaldyr / rejer", "months": 6},
    {"name": "Grøntsager", "months": 12},
    {"name": "Frugt & bær", "months": 12},
    {"name": "Krydderurter", "months": 6},
    {"name": "Brød & bagværk", "months": 3},
    {"name": "Dej", "months": 3},
    {"name": "Smør & fløde", "months": 9},
    {"name": "Ost, hård", "months": 6},
    {"name": "Suppe, gryderet & sovs", "months": 3},
    {"name": "Færdigretter", "months": 3},
    {"name": "Fond / bouillon", "months": 6},
    {"name": "Is", "months": 2},
    {"name": "Nødder & kerner", "months": 6},
    {"name": "Andet", "months": 6},
]
CATEGORY_MONTHS = {c["name"]: c["months"] for c in CATEGORIES}

UNITS = ["portioner", "stk", "g", "kg", "ml", "l", "poser", "pakker"]

# Items within this many days of their best-before date count as "use soon".
SOON_DAYS = 21

SCHEMA = """
CREATE TABLE IF NOT EXISTS locations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    category       TEXT NOT NULL DEFAULT 'Other',
    location_id    INTEGER REFERENCES locations(id) ON DELETE SET NULL,
    amount         REAL NOT NULL DEFAULT 1,
    initial_amount REAL NOT NULL DEFAULT 1,
    unit           TEXT NOT NULL DEFAULT 'portions',
    frozen_on      TEXT NOT NULL,
    best_before    TEXT,
    notes          TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at      TEXT
);

CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    delta      REAL NOT NULL DEFAULT 0,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_best_before ON items(best_before);
CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id);
"""

# Databases created before the Danish translation still hold English values.
ENGLISH_TO_DANISH = {
    "Beef / lamb (steaks, roasts)": "Okse / lam (bøffer, steg)",
    "Pork (chops, roasts)": "Svin (koteletter, steg)",
    "Ground meat": "Hakket kød",
    "Poultry, whole": "Fjerkræ, hel",
    "Poultry, pieces": "Fjerkræ, stykker",
    "Bacon / sausages / cured": "Bacon / pølser / pålæg",
    "Cooked meat & leftovers": "Tilberedt kød & rester",
    "Fish, lean (cod, haddock)": "Fisk, mager (torsk, kuller)",
    "Fish, fatty (salmon, mackerel)": "Fisk, fed (laks, makrel)",
    "Shellfish / prawns": "Skaldyr / rejer",
    "Vegetables": "Grøntsager",
    "Fruit & berries": "Frugt & bær",
    "Herbs": "Krydderurter",
    "Bread & baked goods": "Brød & bagværk",
    "Dough & pastry": "Dej",
    "Butter & cream": "Smør & fløde",
    "Cheese, hard": "Ost, hård",
    "Soup, stew & sauce": "Suppe, gryderet & sovs",
    "Ready meals": "Færdigretter",
    "Stock / broth": "Fond / bouillon",
    "Ice cream": "Is",
    "Nuts & seeds": "Nødder & kerner",
    "Other": "Andet",
    "portions": "portioner",
    "pcs": "stk",
    "bags": "poser",
    "packs": "pakker",
}

DEFAULT_LOCATIONS = ["Øverste skuffe", "Midterste skuffe", "Nederste skuffe"]

app = Flask(__name__)


# --------------------------------------------------------------------------- db


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db() -> None:
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    if conn.execute("SELECT COUNT(*) FROM locations").fetchone()[0] == 0:
        conn.executemany(
            "INSERT INTO locations (name, sort_order) VALUES (?, ?)",
            [(n, i) for i, n in enumerate(DEFAULT_LOCATIONS)],
        )
    for en, da in ENGLISH_TO_DANISH.items():
        conn.execute("UPDATE items SET category = ? WHERE category = ?", (da, en))
        conn.execute("UPDATE items SET unit = ? WHERE unit = ?", (da, en))
    conn.commit()
    conn.close()


# ------------------------------------------------------------------------ dates


def add_months(d: date, months: int) -> date:
    """Add whole months, clamping to the last valid day (31 Jan + 1 = 28 Feb)."""
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def parse_date(value, fallback=None):
    if not value:
        return fallback
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return fallback


def suggest_best_before(category: str, frozen_on: date) -> date:
    return add_months(frozen_on, CATEGORY_MONTHS.get(category, 6))


# ------------------------------------------------------------------ serializing


def spoilage(best_before: date | None, today: date) -> tuple[str, int | None]:
    """Return (state, days_left). State is one of ok / soon / expired / unknown."""
    if best_before is None:
        return "unknown", None
    days_left = (best_before - today).days
    if days_left < 0:
        return "expired", days_left
    if days_left <= SOON_DAYS:
        return "soon", days_left
    return "ok", days_left


def item_to_dict(row: sqlite3.Row, today: date) -> dict:
    best_before = parse_date(row["best_before"])
    frozen_on = parse_date(row["frozen_on"], today)
    state, days_left = spoilage(best_before, today)
    return {
        "id": row["id"],
        "name": row["name"],
        "category": row["category"],
        "location_id": row["location_id"],
        "location": row["location_name"],
        "amount": round(row["amount"], 3),
        "initial_amount": round(row["initial_amount"], 3),
        "unit": row["unit"],
        "frozen_on": frozen_on.isoformat(),
        "best_before": best_before.isoformat() if best_before else None,
        "notes": row["notes"],
        "status": row["status"],
        "days_frozen": (today - frozen_on).days,
        "days_left": days_left,
        "state": state,
        "closed_at": row["closed_at"],
    }


ITEM_SELECT = """
SELECT items.*, locations.name AS location_name
FROM items LEFT JOIN locations ON locations.id = items.location_id
"""


def fetch_item(db, item_id: int):
    return db.execute(ITEM_SELECT + " WHERE items.id = ?", (item_id,)).fetchone()


def log(db, item_id: int, kind: str, delta: float = 0, note: str = "") -> None:
    db.execute(
        "INSERT INTO events (item_id, kind, delta, note) VALUES (?, ?, ?, ?)",
        (item_id, kind, delta, note),
    )


def touch(db, item_id: int) -> None:
    db.execute(
        "UPDATE items SET updated_at = datetime('now') WHERE id = ?", (item_id,)
    )


class BadRequest(Exception):
    pass


@app.errorhandler(BadRequest)
def handle_bad_request(exc):
    return jsonify({"error": str(exc)}), 400


def payload() -> dict:
    return request.get_json(silent=True) or {}


# -------------------------------------------------------------------- endpoints


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/meta")
def api_meta():
    db = get_db()
    locations = db.execute(
        "SELECT id, name FROM locations ORDER BY sort_order, name"
    ).fetchall()
    return jsonify(
        {
            "categories": CATEGORIES,
            "units": UNITS,
            "soon_days": SOON_DAYS,
            "today": date.today().isoformat(),
            "locations": [dict(r) for r in locations],
        }
    )


@app.get("/api/items")
def api_items():
    db = get_db()
    today = date.today()
    status = request.args.get("status", "active")
    sql = ITEM_SELECT
    params: list = []
    if status != "all":
        sql += " WHERE items.status = ?"
        params.append(status)
    sql += """
        ORDER BY CASE WHEN items.best_before IS NULL THEN 1 ELSE 0 END,
                 items.best_before, items.name
    """
    rows = db.execute(sql, params).fetchall()
    items = [item_to_dict(r, today) for r in rows]
    summary = {
        "total": len(items),
        "expired": sum(1 for i in items if i["state"] == "expired"),
        "soon": sum(1 for i in items if i["state"] == "soon"),
    }
    return jsonify({"items": items, "summary": summary, "today": today.isoformat()})


@app.post("/api/items")
def api_create_item():
    data = payload()
    name = (data.get("name") or "").strip()
    if not name:
        raise BadRequest("Navn mangler")

    category = data.get("category") or "Andet"
    if category not in CATEGORY_MONTHS:
        category = "Andet"

    today = date.today()
    frozen_on = parse_date(data.get("frozen_on"), today)
    if frozen_on > today:
        raise BadRequest("Indfrysningsdatoen kan ikke ligge i fremtiden")

    best_before = parse_date(data.get("best_before"))
    if best_before is None:
        best_before = suggest_best_before(category, frozen_on)

    raw_amount = data.get("amount")
    try:
        amount = 1.0 if raw_amount in (None, "") else float(raw_amount)
    except (TypeError, ValueError):
        raise BadRequest("Mængden skal være et tal")
    if amount <= 0:
        raise BadRequest("Mængden skal være større end nul")

    unit = (data.get("unit") or "portioner").strip() or "portioner"
    location_id = data.get("location_id") or None

    db = get_db()
    cur = db.execute(
        """INSERT INTO items
           (name, category, location_id, amount, initial_amount, unit,
            frozen_on, best_before, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            name,
            category,
            location_id,
            amount,
            amount,
            unit,
            frozen_on.isoformat(),
            best_before.isoformat(),
            (data.get("notes") or "").strip(),
        ),
    )
    log(db, cur.lastrowid, "added", amount, f"{amount:g} {unit}")
    db.commit()
    return jsonify(item_to_dict(fetch_item(db, cur.lastrowid), today)), 201


@app.patch("/api/items/<int:item_id>")
def api_update_item(item_id: int):
    db = get_db()
    row = fetch_item(db, item_id)
    if row is None:
        return jsonify({"error": "Varen findes ikke"}), 404

    data = payload()
    fields: dict = {}

    if "name" in data:
        name = (data["name"] or "").strip()
        if not name:
            raise BadRequest("Navn mangler")
        fields["name"] = name
    if "category" in data:
        fields["category"] = (
            data["category"] if data["category"] in CATEGORY_MONTHS else "Andet"
        )
    if "location_id" in data:
        fields["location_id"] = data["location_id"] or None
    if "unit" in data:
        fields["unit"] = (data["unit"] or "portioner").strip() or "portioner"
    if "notes" in data:
        fields["notes"] = (data["notes"] or "").strip()
    if "amount" in data:
        try:
            amount = float(data["amount"])
        except (TypeError, ValueError):
            raise BadRequest("Mængden skal være et tal")
        if amount < 0:
            raise BadRequest("Mængden kan ikke være negativ")
        fields["amount"] = amount
        if amount > row["initial_amount"]:
            fields["initial_amount"] = amount
    if "frozen_on" in data:
        frozen = parse_date(data["frozen_on"])
        if frozen is None:
            raise BadRequest("Ugyldig indfrysningsdato")
        fields["frozen_on"] = frozen.isoformat()
    if "best_before" in data:
        bb = parse_date(data["best_before"])
        fields["best_before"] = bb.isoformat() if bb else None
    if "status" in data:
        if data["status"] not in ("active", "used", "discarded"):
            raise BadRequest("Ukendt status")
        fields["status"] = data["status"]
        fields["closed_at"] = (
            None if data["status"] == "active" else datetime.now().isoformat(" ", "seconds")
        )

    if fields:
        assignments = ", ".join(f"{k} = ?" for k in fields)
        db.execute(
            f"UPDATE items SET {assignments}, updated_at = datetime('now') WHERE id = ?",
            [*fields.values(), item_id],
        )
        log(db, item_id, "edited", 0, ", ".join(sorted(fields)))
        db.commit()
    return jsonify(item_to_dict(fetch_item(db, item_id), date.today()))


@app.post("/api/items/<int:item_id>/take")
def api_take(item_id: int):
    """Take some (or all) of an item out of the freezer."""
    db = get_db()
    row = fetch_item(db, item_id)
    if row is None:
        return jsonify({"error": "Varen findes ikke"}), 404

    data = payload()
    raw = data.get("amount")
    try:
        amount = float(row["amount"] if raw in (None, "") else raw)
    except (TypeError, ValueError):
        raise BadRequest("Mængden skal være et tal")
    if amount <= 0:
        raise BadRequest("Mængden skal være større end nul")

    remaining = max(0.0, round(row["amount"] - amount, 3))
    taken = round(row["amount"] - remaining, 3)
    status = "used" if remaining <= 0 else "active"
    db.execute(
        """UPDATE items
           SET amount = ?, status = ?, updated_at = datetime('now'),
               closed_at = CASE WHEN ? = 'used' THEN datetime('now') ELSE NULL END
           WHERE id = ?""",
        (remaining, status, status, item_id),
    )
    log(db, item_id, "taken", -taken, f"{taken:g} {row['unit']}")
    db.commit()
    return jsonify(item_to_dict(fetch_item(db, item_id), date.today()))


@app.post("/api/items/<int:item_id>/discard")
def api_discard(item_id: int):
    db = get_db()
    row = fetch_item(db, item_id)
    if row is None:
        return jsonify({"error": "Varen findes ikke"}), 404
    db.execute(
        """UPDATE items SET status = 'discarded', amount = 0,
           updated_at = datetime('now'), closed_at = datetime('now') WHERE id = ?""",
        (item_id,),
    )
    log(db, item_id, "discarded", -row["amount"], (payload().get("note") or "").strip())
    db.commit()
    return jsonify(item_to_dict(fetch_item(db, item_id), date.today()))


@app.post("/api/items/<int:item_id>/restore")
def api_restore(item_id: int):
    """Put a used/discarded item back in the freezer (undo)."""
    db = get_db()
    row = fetch_item(db, item_id)
    if row is None:
        return jsonify({"error": "Varen findes ikke"}), 404
    amount = row["amount"] if row["amount"] > 0 else row["initial_amount"]
    db.execute(
        """UPDATE items SET status = 'active', amount = ?, closed_at = NULL,
           updated_at = datetime('now') WHERE id = ?""",
        (amount, item_id),
    )
    log(db, item_id, "restored", amount)
    db.commit()
    return jsonify(item_to_dict(fetch_item(db, item_id), date.today()))


@app.delete("/api/items/<int:item_id>")
def api_delete_item(item_id: int):
    db = get_db()
    db.execute("DELETE FROM events WHERE item_id = ?", (item_id,))
    cur = db.execute("DELETE FROM items WHERE id = ?", (item_id,))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "Varen findes ikke"}), 404
    return jsonify({"deleted": item_id})


@app.get("/api/items/<int:item_id>/history")
def api_history(item_id: int):
    db = get_db()
    rows = db.execute(
        "SELECT kind, delta, note, created_at FROM events WHERE item_id = ? ORDER BY id DESC",
        (item_id,),
    ).fetchall()
    return jsonify({"events": [dict(r) for r in rows]})


@app.get("/api/suggest-best-before")
def api_suggest():
    category = request.args.get("category", "Andet")
    frozen_on = parse_date(request.args.get("frozen_on"), date.today())
    return jsonify(
        {
            "best_before": suggest_best_before(category, frozen_on).isoformat(),
            "months": CATEGORY_MONTHS.get(category, 6),
        }
    )


@app.get("/api/locations")
def api_locations():
    db = get_db()
    rows = db.execute(
        """SELECT locations.id, locations.name,
                  (SELECT COUNT(*) FROM items
                   WHERE items.location_id = locations.id AND items.status = 'active')
                  AS item_count
           FROM locations ORDER BY sort_order, name"""
    ).fetchall()
    return jsonify({"locations": [dict(r) for r in rows]})


@app.post("/api/locations")
def api_create_location():
    name = (payload().get("name") or "").strip()
    if not name:
        raise BadRequest("Pladsen skal have et navn")
    db = get_db()
    try:
        cur = db.execute(
            """INSERT INTO locations (name, sort_order)
               VALUES (?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM locations))""",
            (name,),
        )
    except sqlite3.IntegrityError:
        raise BadRequest(f"'{name}' findes allerede")
    db.commit()
    return jsonify({"id": cur.lastrowid, "name": name, "item_count": 0}), 201


@app.patch("/api/locations/<int:loc_id>")
def api_rename_location(loc_id: int):
    name = (payload().get("name") or "").strip()
    if not name:
        raise BadRequest("Pladsen skal have et navn")
    db = get_db()
    try:
        cur = db.execute("UPDATE locations SET name = ? WHERE id = ?", (name, loc_id))
    except sqlite3.IntegrityError:
        raise BadRequest(f"'{name}' findes allerede")
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "Pladsen findes ikke"}), 404
    return jsonify({"id": loc_id, "name": name})


@app.delete("/api/locations/<int:loc_id>")
def api_delete_location(loc_id: int):
    """Deleting a location leaves its items in place, just unassigned."""
    db = get_db()
    cur = db.execute("DELETE FROM locations WHERE id = ?", (loc_id,))
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "Pladsen findes ikke"}), 404
    return jsonify({"deleted": loc_id})


@app.get("/api/stats")
def api_stats():
    db = get_db()
    today = date.today()
    rows = db.execute(ITEM_SELECT + " WHERE items.status = 'active'").fetchall()
    items = [item_to_dict(r, today) for r in rows]
    closed = db.execute(
        "SELECT status, COUNT(*) AS n FROM items WHERE status != 'active' GROUP BY status"
    ).fetchall()
    counts = {r["status"]: r["n"] for r in closed}
    by_location: dict[str, int] = {}
    for i in items:
        by_location[i["location"] or "Uden plads"] = (
            by_location.get(i["location"] or "Uden plads", 0) + 1
        )
    return jsonify(
        {
            "active": len(items),
            "expired": sum(1 for i in items if i["state"] == "expired"),
            "soon": sum(1 for i in items if i["state"] == "soon"),
            "used": counts.get("used", 0),
            "discarded": counts.get("discarded", 0),
            "oldest_days": max((i["days_frozen"] for i in items), default=0),
            "by_location": by_location,
        }
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="FreeZer - freezer inventory")
    parser.add_argument("--port", type=int, default=int(os.environ.get("FREEZER_PORT", 5177)))
    parser.add_argument("--host", default=os.environ.get("FREEZER_HOST", "127.0.0.1"))
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    print(f"FreeZer - database: {DB_PATH}")
    print(f"FreeZer - open http://{args.host}:{args.port}")
    app.run(host=args.host, port=args.port, debug=args.debug)


# Create the schema on import so a WSGI server (gunicorn in the Docker image)
# gets a ready database without going through main().
init_db()

if __name__ == "__main__":
    main()
