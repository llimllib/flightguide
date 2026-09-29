#!/usr/bin/env python3
"""Build discs.db from Marshall Street's flightguide.html (and flightguide.json).

The HTML contains one `div.disc-item` per disc, with all of its data in
data-* attributes. The disc's position in the chart gives its Marshall Street
stability grade (the `stab-X` column, A = very overstable ... Q = very
understable) and speed row.

The JSON contains only stock information, keyed by a slug of the model name
with no brand, so it's joined in by model name on a best-effort basis.

Usage: build_db.py [html] [json] [db]
"""

import json
import re
import sqlite3
import sys
from datetime import datetime
from html import unescape
from html.parser import HTMLParser
from pathlib import Path

STABILITY_GROUPS = {
    "very-overstable",
    "overstable",
    "stable",
    "understable",
    "very-understable",
}


class FlightGuideParser(HTMLParser):
    """Collect the attributes of every disc-item div, along with the chart
    classes (speed row, stability group, stability letter) of its ancestors."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        # stack of class lists, one per open <div>
        self.divs = []
        self.discs = []

    def handle_starttag(self, tag, attrs):
        if tag != "div":
            return
        attrs = dict(attrs)
        classes = (attrs.get("class") or "").split()
        if "disc-item" in classes:
            self.discs.append((attrs, self.chart_position()))
        self.divs.append(classes)

    def handle_endtag(self, tag):
        if tag == "div" and self.divs:
            self.divs.pop()

    def chart_position(self):
        pos = {}
        for classes in self.divs:
            for c in classes:
                if m := re.fullmatch(r"speed-grade-(\d+)", c):
                    pos["speed_row"] = int(m.group(1))
                elif m := re.fullmatch(r"stab-([a-q])", c):
                    pos["stability"] = m.group(1).upper()
                elif c in STABILITY_GROUPS:
                    pos["stability_group"] = c.replace("-", " ")
        return pos


def num(s):
    if s is None or s.strip() == "":
        return None
    f = float(s)
    return int(f) if f.is_integer() else f


def slug(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def load_stock(json_path):
    if not json_path.exists():
        return {}
    models = json.loads(json_path.read_text())["data"]["models"]
    return {slug(k): v for k, v in models.items()}


def build_rows(html_path, json_path):
    parser = FlightGuideParser()
    parser.feed(html_path.read_text())
    stock = load_stock(json_path)

    rows = []
    for a, pos in parser.discs:
        title = a["data-title"].strip()
        pdga_model = (a.get("data-disc-model") or "").strip() or None
        # OOP marks out of production discs, usually as "(OOP)", which we strip
        # from the model name; others like "Kaxe (Old - OOP)" are left alone
        oop = bool(re.search(r"\bOOP\b", title))
        model = re.sub(r"\s*\(OOP\)\s*", " ", title, flags=re.I).strip()

        st = None
        for candidate in (title, model, pdga_model):
            if candidate and slug(candidate) in stock:
                st = stock[slug(candidate)]
                break

        rows.append(
            {
                "id": int(a["data-id"]),
                "brand": a["data-brand"].strip(),
                "model": model,
                "pdga_model": pdga_model,
                "category": a.get("data-category") or None,
                "speed": num(a["data-speed"]),
                "glide": num(a["data-glide"]),
                "turn": num(a["data-turn"]),
                "fade": num(a["data-fade"]),
                "stability": pos.get("stability"),
                "stability_group": pos.get("stability_group"),
                "out_of_production": oop,
                "diameter_cm": num(a.get("data-diameter")),
                "height_cm": num(a.get("data-height")),
                "rim_depth_cm": num(a.get("data-rim_depth")),
                "rim_thickness_cm": num(a.get("data-rim_thickness")),
                "max_weight_g": num(a.get("data-max_weight")),
                "pdga_approved_date": a.get("data-approved_date") or None,
                "in_stock_products": st["products"] if st else None,
                "in_stock_choices": st["choices"] if st else None,
                "on_sale": st["onSale"] if st else None,
                "description": unescape(a.get("data-disc_desc") or "").strip() or None,
                "link": a.get("data-link") or None,
                "image": a.get("data-pic") or None,
                "bg_color": a.get("data-bg") or None,
                "text_color": a.get("data-text") or None,
            }
        )
    return rows


SCHEMA = """
CREATE TABLE discs (
    id INTEGER PRIMARY KEY,         -- Marshall Street's disc id
    brand TEXT NOT NULL,
    model TEXT NOT NULL,            -- display name, with "(OOP)" removed
    pdga_model TEXT,                -- name as listed by the PDGA, if present
    category TEXT,                  -- Putters, Midrange Drivers, ...
    speed REAL NOT NULL,
    glide REAL NOT NULL,
    turn REAL NOT NULL,
    fade REAL NOT NULL,
    stability TEXT,                 -- Marshall Street grade, A (very overstable) .. Q (very understable)
    stability_group TEXT,           -- very overstable, overstable, stable, understable, very understable
    out_of_production INTEGER NOT NULL,
    diameter_cm REAL,
    height_cm REAL,
    rim_depth_cm REAL,
    rim_thickness_cm REAL,
    max_weight_g REAL,
    pdga_approved_date TEXT,        -- ISO 8601 date
    in_stock_products INTEGER,      -- from flightguide.json, matched by model name only
    in_stock_choices INTEGER,
    on_sale INTEGER,
    description TEXT,               -- HTML
    link TEXT,
    image TEXT,
    bg_color TEXT,
    text_color TEXT
);
CREATE INDEX discs_brand_model ON discs (brand, model);
"""


def iso_date(s):
    if not s:
        return None
    return datetime.strptime(s, "%b %d, %Y").date().isoformat()


def main():
    here = Path(__file__).parent
    html_path = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "flightguide.html"
    json_path = Path(sys.argv[2]) if len(sys.argv) > 2 else here / "flightguide.json"
    db_path = Path(sys.argv[3]) if len(sys.argv) > 3 else here / "discs.db"

    rows = build_rows(html_path, json_path)
    for r in rows:
        r["pdga_approved_date"] = iso_date(r["pdga_approved_date"])

    db_path.unlink(missing_ok=True)
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)
    cols = list(rows[0])
    db.executemany(
        f"INSERT INTO discs ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
        [[r[c] for c in cols] for r in rows],
    )
    db.commit()
    db.close()
    print(f"wrote {len(rows)} discs to {db_path}")


if __name__ == "__main__":
    main()
