#!/usr/bin/env python3
"""Build discs.db from the pages fetch.py saved in sources/.

Marshall Street's flight guide is the base dataset: every disc in discs.db is
one of theirs. It holds one `div.disc-item` per disc, with all of its data in
data-* attributes. The disc's position in the chart gives its Marshall Street
stability grade (the `stab-X` column, A = very overstable ... Q = very
understable) and speed row. The page also embeds a snapshot of their stock,
keyed by a slug of the model name with no brand, which is joined in by model
name on a best-effort basis.

A retailer copies flight numbers from manufacturers, and sometimes gets them
wrong or doesn't pick up a revision, so a manufacturer's own page overrides
the four numbers of each disc it lists. Only the numbers: Marshall Street's
stability grade is their judgement of the disc, not a function of its numbers,
so it stays theirs. discs.numbers_source says which source a disc's numbers
came from, and source_numbers keeps every source's numbers for every disc, so
disagreements stay queryable after the merge.

The PDGA's list of approved discs is loaded as published into pdga_discs. It
has no flight numbers, and isn't yet linked to discs.

Building is offline and repeatable: run fetch.py to update sources/.

Usage: build_db.py [sources_dir] [db]
"""

import csv
import json
import re
import sqlite3
import sys
import unicodedata
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
    """Fold a name for matching across sources: RPM writes Tākapu where
    Marshall Street writes Takapu, so accents go before punctuation does."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


def marshall_stock(text):
    """The stock snapshot embedded in the page, in the flightGuideSettings
    object a script assigns."""
    marker = "var flightGuideSettings = "
    start = text.find(marker)
    if start < 0:
        return {}
    settings, _ = json.JSONDecoder().raw_decode(text, start + len(marker))
    models = settings.get("catalogSnapshot", {}).get("models", {})
    return {slug(k): v for k, v in models.items()}


def iso_date(s):
    if not s:
        return None
    return datetime.strptime(s, "%b %d, %Y").date().isoformat()


def parse_marshall(path):
    text = path.read_text()
    parser = FlightGuideParser()
    parser.feed(text)
    stock = marshall_stock(text)

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
                "numbers_source": "marshall",
                "stability": pos.get("stability"),
                "stability_group": pos.get("stability_group"),
                "out_of_production": oop,
                "diameter_cm": num(a.get("data-diameter")),
                "height_cm": num(a.get("data-height")),
                "rim_depth_cm": num(a.get("data-rim_depth")),
                "rim_thickness_cm": num(a.get("data-rim_thickness")),
                "max_weight_g": num(a.get("data-max_weight")),
                "pdga_approved_date": iso_date(a.get("data-approved_date")),
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


class WooCommerceParser(HTMLParser):
    """Collect the product cards of a WooCommerce shop listing: each one's
    link, title, subtitle, and product_cat-* categories."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.cards = []
        self.card = None
        self.depth = 0  # of <li> inside the current card
        self.field = None  # the card field text is being collected into

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = (attrs.get("class") or "").split()
        if tag == "li" and self.card is not None:
            self.depth += 1
        elif tag == "li" and "type-product" in classes:
            cats = {c.removeprefix("product_cat-") for c in classes if c.startswith("product_cat-")}
            self.card = {"categories": cats, "url": None, "title": "", "subtitle": ""}
        elif self.card is None:
            return
        elif tag == "a" and self.card["url"] is None:
            self.card["url"] = attrs.get("href")
        elif tag == "h2" and "woocommerce-loop-product__title" in classes:
            self.field = "title"
        elif tag == "i" and "product-subtitle" in classes:
            self.field = "subtitle"

    def handle_endtag(self, tag):
        if self.card is None:
            return
        if tag in ("h2", "i"):
            self.field = None
        elif tag == "li" and self.depth:
            self.depth -= 1
        elif tag == "li":
            self.cards.append(self.card)
            self.card = None

    def handle_data(self, data):
        if self.card is not None and self.field:
            self.card[self.field] += data


NUMBERS = re.compile(r"\s*(-?[\d.]+)\s*/\s*(-?[\d.]+)\s*/\s*(-?[\d.]+)\s*/\s*(-?[\d.]+)\s*")

# RPM's shop categories for its stock molds
RPM_DISCS = {"golf-drivers", "golf-fairway-drivers", "golf-mid-range", "golf-putt-approach"}
# special editions, which carry a mold's numbers under a name of their own:
# signature discs, prototypes, and the Atua series named for Māori gods
RPM_EDITIONS = {"atua-series", "collectables", "custom-disc", "sigdiscs", "starterpacks"}


def parse_rpm(path):
    parser = WooCommerceParser()
    parser.feed(path.read_text())

    rows = {}
    for card in parser.cards:
        cats = card["categories"]
        if not cats & RPM_DISCS or cats & RPM_EDITIONS or card["url"] in rows:
            continue
        m = NUMBERS.fullmatch(card["subtitle"])
        if not m:
            raise ValueError(f"rpm: no flight numbers for {card['title']!r}: {card['subtitle']!r}")
        speed, glide, turn, fade = (num(n) for n in m.groups())
        rows[card["url"]] = {
            "brand": "RPM",
            "model": card["title"].strip(),
            "speed": speed,
            "glide": glide,
            "turn": turn,
            "fade": fade,
            "url": card["url"],
        }
    return list(rows.values())


# the export's columns, and ours. The CSV is read by header, so a renamed or
# missing column fails the build rather than shifting values into the wrong one
PDGA_COLUMNS = {
    "Manufacturer / Distributor": "manufacturer",
    "Disc Model": "model",
    "Certification Number": "certification_number",
    "Approved Date": "approved_date",
    "Max Weight (gr)": "max_weight_g",
    "Diameter (cm)": "diameter_cm",
    "Height (cm)": "height_cm",
    "Rim Depth (cm)": "rim_depth_cm",
    "Inside Rim Diameter (cm)": "inside_rim_diameter_cm",
    "Rim Thickness (cm)": "rim_thickness_cm",
    "Rim Depth / Diameter Ratio (%)": "rim_depth_diameter_pct",
    "Rim Configuration": "rim_configuration",
    "Flexibility (kg)": "flexibility_kg",
    "Class": "class",
    "Max Weight Vint (gr)": "max_weight_vintage_g",
    "Last Year Production": "last_year_production",
}
PDGA_TEXT = {"manufacturer", "model", "certification_number", "approved_date", "class"}


def parse_pdga(path):
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if missing := set(PDGA_COLUMNS) - set(reader.fieldnames or ()):
            raise ValueError(f"pdga: export has no column {', '.join(sorted(missing))}")
        rows = []
        for r in reader:
            row = {}
            for col, key in PDGA_COLUMNS.items():
                v = r[col].strip()
                row[key] = (v or None) if key in PDGA_TEXT else num(v)
            row["approved_date"] = iso_date(row["approved_date"])
            rows.append(row)
    return rows


# the manufacturers fetch.py downloads, whose numbers override Marshall
# Street's, and the parser for each
MANUFACTURERS = {"rpm": parse_rpm}

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
    numbers_source TEXT NOT NULL,   -- the source of the four numbers above, a sources.name
    stability TEXT,                 -- Marshall Street grade, A (very overstable) .. Q (very understable)
    stability_group TEXT,           -- very overstable, overstable, stable, understable, very understable
    out_of_production INTEGER NOT NULL,
    diameter_cm REAL,
    height_cm REAL,
    rim_depth_cm REAL,
    rim_thickness_cm REAL,
    max_weight_g REAL,
    pdga_approved_date TEXT,        -- ISO 8601 date
    in_stock_products INTEGER,      -- Marshall Street's stock, matched by model name only
    in_stock_choices INTEGER,
    on_sale INTEGER,
    description TEXT,               -- HTML
    link TEXT,
    image TEXT,
    bg_color TEXT,
    text_color TEXT
);
CREATE INDEX discs_brand_model ON discs (brand, model);

-- the pages discs.db was built from, as recorded by fetch.py
CREATE TABLE sources (
    name TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    file TEXT NOT NULL,             -- path under sources/
    fetched TEXT NOT NULL,          -- ISO 8601 timestamp
    sha256 TEXT NOT NULL
);

-- every source's flight numbers, as published, whether or not they won
CREATE TABLE source_numbers (
    source TEXT NOT NULL REFERENCES sources (name),
    disc_id INTEGER REFERENCES discs (id),  -- null if no disc matched
    brand TEXT NOT NULL,
    model TEXT NOT NULL,            -- as the source names it
    speed REAL NOT NULL,
    glide REAL NOT NULL,
    turn REAL NOT NULL,
    fade REAL NOT NULL,
    url TEXT
);
CREATE INDEX source_numbers_disc ON source_numbers (disc_id);

-- the PDGA's approved discs, as published
CREATE TABLE pdga_discs (
    manufacturer TEXT NOT NULL,     -- the PDGA's name, often a legal or distributor name
    model TEXT NOT NULL,            -- as approved, aliases in parentheses: "Kahu (DGD2)"
    certification_number TEXT NOT NULL,  -- not unique: the PDGA reuses a few
    approved_date TEXT NOT NULL,    -- ISO 8601 date
    max_weight_g REAL,
    diameter_cm REAL,
    height_cm REAL,
    rim_depth_cm REAL,
    inside_rim_diameter_cm REAL,
    rim_thickness_cm REAL,
    rim_depth_diameter_pct REAL,
    rim_configuration REAL,
    flexibility_kg REAL,
    class TEXT,                     -- Super Class, Vintage Class, or both
    max_weight_vintage_g REAL,
    last_year_production INTEGER,   -- empty for every disc as of October 2026
    PRIMARY KEY (manufacturer, model)
);
"""

FLIGHT = ("speed", "glide", "turn", "fade")


def flight(r):
    return " / ".join(str(r[k]) for k in FLIGHT)


def merge(discs, name, rows):
    """Override discs' numbers with a manufacturer's, and report how its
    listing lines up with Marshall Street's. Returns rows' disc ids."""
    by_name = {}
    for d in discs:
        by_name.setdefault((slug(d["brand"]), slug(d["model"])), []).append(d)

    ids, unmatched, changed = [], [], []
    for r in rows:
        matches = by_name.get((slug(r["brand"]), slug(r["model"])), [])
        if len(matches) > 1:
            raise ValueError(f"{name}: {r['brand']} {r['model']} matches discs {[d['id'] for d in matches]}")
        d = matches[0] if matches else None
        ids.append(d and d["id"])
        if not d:
            unmatched.append(r["model"])
            continue
        if any(d[k] != r[k] for k in FLIGHT):
            changed.append(f"{d['model']}: {flight(d)} -> {flight(r)}")
        d.update({k: r[k] for k in FLIGHT}, numbers_source=name)

    brands = {slug(r["brand"]) for r in rows}
    listed = set(filter(None, ids))
    missing = [d["model"] for d in discs if slug(d["brand"]) in brands and d["id"] not in listed]

    print(f"{name}: {len(rows)} discs listed, {len(listed)} matched, {len(changed)} with different numbers")
    for line in changed:
        print(f"  {line}")
    if unmatched:
        print(f"  not in Marshall Street's guide: {', '.join(sorted(unmatched))}")
    if missing:
        print(f"  only in Marshall Street's guide: {', '.join(sorted(missing))}")
    return ids


def insert(db, table, rows):
    cols = list(rows[0])
    db.executemany(
        f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
        [[r[c] for c in cols] for r in rows],
    )


def main():
    here = Path(__file__).parent
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "sources"
    db_path = Path(sys.argv[2]) if len(sys.argv) > 2 else here / "discs.db"

    manifest_path = src / "fetched.json"
    if not manifest_path.exists():
        sys.exit(f"no {manifest_path}: run fetch.py first")
    manifest = json.loads(manifest_path.read_text())
    if unknown := set(manifest) - {"marshall", "pdga", *MANUFACTURERS}:
        sys.exit(f"no parser for source {', '.join(sorted(unknown))}")

    discs = parse_marshall(src / manifest["marshall"]["file"])
    numbers = [
        {"source": "marshall", "disc_id": d["id"], **{k: d[k] for k in ("brand", "model", *FLIGHT)}, "url": d["link"]}
        for d in discs
    ]
    print(f"marshall: {len(discs)} discs")

    for name, parse in MANUFACTURERS.items():
        if name not in manifest:
            continue
        rows = parse(src / manifest[name]["file"])
        if not rows:
            sys.exit(f"{name}: found no discs; has the page's layout changed?")
        for r, disc_id in zip(rows, merge(discs, name, rows)):
            numbers.append({"source": name, "disc_id": disc_id, **r})

    pdga = parse_pdga(src / manifest["pdga"]["file"]) if "pdga" in manifest else []
    if pdga:
        print(f"pdga: {len(pdga)} approved discs from {len({r['manufacturer'] for r in pdga})} manufacturers")

    db_path.unlink(missing_ok=True)
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)
    insert(db, "discs", discs)
    insert(db, "sources", [{"name": k, **v} for k, v in manifest.items()])
    insert(db, "source_numbers", numbers)
    if pdga:
        insert(db, "pdga_discs", pdga)
    db.commit()
    db.close()
    print(f"wrote {len(discs)} discs to {db_path}")


if __name__ == "__main__":
    main()
