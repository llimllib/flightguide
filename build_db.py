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
has no flight numbers. Each disc is linked to its approval where we can find
one, and takes its specs from it; molds.toml covers what the build can't
work out itself.

brands.toml lists the brands we chart and the PDGA manufacturer names of
each, and moves discs Marshall Street files under the wrong brand. The build
fails on a brand it doesn't list.

Building is offline and repeatable: run fetch.py to update sources/.

Usage: build_db.py [sources_dir] [db]
"""

import csv
import json
import re
import sqlite3
import sys
import tomllib
import unicodedata
from collections import Counter, defaultdict
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
                "pdga_manufacturer": None,
                "certification_number": None,
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


def disc_index(discs):
    """Discs by the keys brands.toml and molds.toml name them with: "Brand |
    Model", or "Brand | Model #id" with Marshall Street's id, for when two
    discs share a name."""
    names = Counter(f"{d['brand']} | {d['model']}" for d in discs)
    index = {}
    for d in discs:
        key = f"{d['brand']} | {d['model']}"
        index[f"{key} #{d['id']}"] = d
        if names[key] == 1:
            index[key] = d
    return index


def apply_brands(discs, config):
    """Move discs to their right brand, give every disc its brand's colors,
    and return the brands table's rows. Fails on a brand config doesn't list,
    and on a reassignment that names no disc."""
    brands = config["brands"]

    # Marshall Street's colors for each brand, taken before discs move between
    # brands so that, say, Divergent doesn't take on the colors of "Other"
    marshall_colors = {d["brand"]: [d["bg_color"], d["text_color"]] for d in discs}

    by_key = disc_index(discs)
    for key, to in config.get("reassign", {}).items():
        if key not in by_key:
            raise ValueError(f"brands.toml: reassign {key!r} matches no disc, or more than one")
        to = to if isinstance(to, dict) else {"brand": to}
        by_key[key].update(to)
    print(f"brands: moved or renamed {len(config.get('reassign', {}))} discs Marshall Street misfiled")

    dupes = Counter(f"{d['brand']} | {d['model']}" for d in discs)
    if dupes := sorted(k for k, n in dupes.items() if n > 1):
        print(f"warning: more than one disc named {', '.join(dupes)}; rename them in brands.toml")

    if unknown := sorted({d["brand"] for d in discs} - set(brands)):
        raise ValueError(f"brands.toml: no entry for brand {', '.join(unknown)}")

    rows = []
    for name, b in brands.items():
        colors = b.get("colors") or marshall_colors.get(name)
        if not colors:
            raise ValueError(f"brands.toml: {name} needs colors, which Marshall Street doesn't have")
        rows.append({"name": name, "website": b.get("website"), "bg_color": colors[0], "text_color": colors[1]})
    colors = {r["name"]: r for r in rows}
    for d in discs:
        d["bg_color"], d["text_color"] = colors[d["brand"]]["bg_color"], colors[d["brand"]]["text_color"]
    return rows


def check_pdga_names(brands, pdga):
    """Fail on a PDGA manufacturer name in brands.toml that the PDGA's list
    doesn't have, which is how a renamed manufacturer shows up, and report
    the manufacturers we don't chart."""
    have = {r["manufacturer"] for r in pdga}
    ours = {m for b in brands.values() for m in b["pdga"]}
    if missing := sorted(ours - have):
        raise ValueError(f"brands.toml: the PDGA has no manufacturer {', '.join(map(repr, missing))}")
    print(f"pdga: {len(have - ours)} of {len(have)} manufacturers aren't brands we chart")


# what a disc takes from its PDGA approval: discs' column, pdga_discs' column
PDGA_SPECS = {
    "diameter_cm": "diameter_cm",
    "height_cm": "height_cm",
    "rim_depth_cm": "rim_depth_cm",
    "rim_thickness_cm": "rim_thickness_cm",
    "max_weight_g": "max_weight_g",
    "pdga_approved_date": "approved_date",
}
# words in the PDGA's parentheses that aren't another name for the disc
PDGA_NOT_NAMES = {"new", "retooled"}


def name_slug(s):
    return slug(re.sub(r"^the\s+", "", s.strip(), flags=re.I))


def pdga_aliases(model):
    """The names a PDGA approval goes by, lowercased. The PDGA puts aliases
    and codes in parentheses: "Piwakawaka (MR1, originally Arcturus)" is also
    the MR1 and the Arcturus, and "Flying Squirrel (Brachiosaurus variant)"
    is also the Brachiosaurus."""
    names = {model, model.split("(")[0]}
    for inner in re.findall(r"\(([^)]*)\)", model):
        for part in inner.split(","):
            part = re.sub(r"^(aka|originally|formerly|former|renamed from)\s+", "", part.strip(), flags=re.I)
            names.add(re.sub(r"\s+variant$", "", part, flags=re.I))
    return {n.strip().lower() for n in names}


def pdga_names(model):
    return {name_slug(n) for n in pdga_aliases(model)} - PDGA_NOT_NAMES - {""}


def disc_names(d):
    """The names a disc goes by: its own, and Marshall Street's name for its
    approval, each also without any parenthesized suffix like "(GStar)"."""
    names = set()
    for n in (d["model"], d["pdga_model"]):
        if n:
            names |= {name_slug(n), name_slug(n.split("(")[0])}
    return names - {""}


def same_specs(d, r):
    keys = ("diameter_cm", "height_cm", "rim_depth_cm", "rim_thickness_cm")
    return d["pdga_approved_date"] is not None and d["pdga_approved_date"] == r["approved_date"] and all(
        d[k] is not None and d[k] == r[k] for k in keys
    )


def narrow(d, rows):
    """Choose among several approvals a disc's names match."""
    # one named exactly as the disc is: F Model OS rather than F Model OS+,
    # which fold to the same slug, and Rook (renamed from P Model US) rather
    # than P Model US+
    named = {n.strip().lower() for n in (d["model"], d["pdga_model"]) if n}
    if len(c := [r for r in rows if r["model"].lower() in named]) == 1:
        return c
    if len(c := [r for r in rows if pdga_aliases(r["model"]) & named]) == 1:
        return c
    # the one Marshall Street copied their specs from, going by its date
    if len(c := [r for r in rows if r["approved_date"] == d["pdga_approved_date"]]) == 1:
        return c
    # a mold approved again when retooled, as DD2 (Frenzy, Distance Driver),
    # DD2 (new) and DD2 (2025): the latest
    if len({name_slug(r["model"].split("(")[0]) for r in rows}) == 1:
        return [max(rows, key=lambda r: r["approved_date"])]
    return rows


def find_approval(d, rows):
    """The approval among rows that d is, and how it was found. Returns
    (None, candidates) if it's ambiguous."""
    if d["pdga_model"] and (c := [r for r in rows if r["model"] == d["pdga_model"]]):
        how = "Marshall Street's PDGA name"
    else:
        names = disc_names(d)
        c = [r for r in rows if pdga_names(r["model"]) & names]
        how = "name"
    if len(c) > 1:
        c = narrow(d, c)
    # Marshall Street copies specs from the PDGA, so identical specs and
    # approval date identify a disc whose name doesn't match
    if not c:
        c = [r for r in rows if same_specs(d, r)]
        how = "specs"
    if len(c) == 1:
        return c[0], how
    return None, c


def link_pdga(discs, pdga, brands, molds):
    """Link each disc to its PDGA approval, among those of its brand's PDGA
    manufacturers, and take its specs from it. Many discs can share one
    approval: the Aviar Classic and the KC Pro Aviar are both the Aviar."""
    by_key = {(r["manufacturer"], r["model"]): r for r in pdga}
    by_maker = defaultdict(list)
    for r in pdga:
        by_maker[r["manufacturer"]].append(r)

    links = molds.get("link", {})
    not_approved = set(molds.get("not_approved", []))
    index = disc_index(discs)
    if stale := sorted((set(links) | not_approved) - set(index)):
        raise ValueError(f"molds.toml: no disc, or more than one, is {', '.join(map(repr, stale))}")
    keys = {id(d): k for k, d in index.items() if k in links or k in not_approved}
    for key, to in links.items():
        if tuple(to.split(" | ", 1)) not in by_key:
            raise ValueError(f"molds.toml: {key!r} links to {to!r}, which the PDGA doesn't list")

    found, ambiguous, unlinked, changed = Counter(), [], [], []
    for d in discs:
        key = keys.get(id(d), f"{d['brand']} | {d['model']}")
        if key in not_approved:
            found["not approved"] += 1
            continue
        if key in links:
            r, how = by_key[tuple(links[key].split(" | ", 1))], "molds.toml"
        else:
            r, how = find_approval(d, [r for m in brands[d["brand"]]["pdga"] for r in by_maker[m]])
        if r is None:
            if how:
                ambiguous.append(f"{key}: {' / '.join(c['model'] for c in how)}")
            else:
                unlinked.append(key)
            continue
        found[how] += 1
        diff = [k for k, col in PDGA_SPECS.items() if d[k] is not None and d[k] != r[col]]
        if diff:
            changed.append(f"{key}: {', '.join(f'{k} {d[k]} -> {r[PDGA_SPECS[k]]}' for k in diff)}")
        d.update({k: r[col] for k, col in PDGA_SPECS.items()})
        d.update(pdga_manufacturer=r["manufacturer"], pdga_model=r["model"], certification_number=r["certification_number"])

    linked = sum(n for how, n in found.items() if how != "not approved")
    print(f"pdga: linked {linked} of {len(discs)} discs to their approval; {found['not approved']} aren't approved")
    for how, n in sorted(found.items()):
        if how != "not approved":
            print(f"  by {how}: {n}")
    if changed:
        print(f"  specs that differ from Marshall Street's: {len(changed)}")
        for line in changed:
            print(f"    {line}")
    if ambiguous:
        print("  matching more than one approval; link them in molds.toml:")
        for line in ambiguous:
            print(f"    {line}")
    if unlinked:
        print(f"  not linked; link them in molds.toml, or mark them not_approved: {', '.join(unlinked)}")

SCHEMA = """
CREATE TABLE discs (
    id INTEGER PRIMARY KEY,         -- Marshall Street's disc id
    brand TEXT NOT NULL REFERENCES brands (name),
    model TEXT NOT NULL,            -- display name, with "(OOP)" removed
    pdga_model TEXT,                -- name as approved by the PDGA, if known
    pdga_manufacturer TEXT,         -- with pdga_model, the disc's pdga_discs row; null if not linked
    certification_number TEXT,
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
    -- the specs above are the PDGA's for linked discs, Marshall Street's otherwise
    in_stock_products INTEGER,      -- Marshall Street's stock, matched by model name only
    in_stock_choices INTEGER,
    on_sale INTEGER,
    description TEXT,               -- HTML
    link TEXT,
    image TEXT,
    bg_color TEXT,                  -- the brand's colors, copied here for build_json.py
    text_color TEXT,
    FOREIGN KEY (pdga_manufacturer, pdga_model) REFERENCES pdga_discs (manufacturer, model)
);
CREATE INDEX discs_brand_model ON discs (brand, model);

-- the brands we chart, from brands.toml
CREATE TABLE brands (
    name TEXT PRIMARY KEY,          -- what the brand's discs are marketed as
    website TEXT,
    bg_color TEXT NOT NULL,
    text_color TEXT NOT NULL
);

-- the PDGA manufacturer names each brand's discs are approved under
CREATE TABLE brand_pdga (
    brand TEXT NOT NULL REFERENCES brands (name),
    manufacturer TEXT NOT NULL,     -- a pdga_discs.manufacturer
    PRIMARY KEY (brand, manufacturer)
);

-- what we know of who makes a brand's discs, or who it's related to
CREATE TABLE brand_lineage (
    brand TEXT NOT NULL REFERENCES brands (name),
    related TEXT NOT NULL,          -- a company, which may or may not be a brand we chart
    note TEXT NOT NULL,
    source TEXT NOT NULL            -- where we know it from; "unverified" if from memory
);

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
    config = tomllib.loads((here / "brands.toml").read_text())
    molds = tomllib.loads((here / "molds.toml").read_text())

    manifest_path = src / "fetched.json"
    if not manifest_path.exists():
        sys.exit(f"no {manifest_path}: run fetch.py first")
    manifest = json.loads(manifest_path.read_text())
    if unknown := set(manifest) - {"marshall", "pdga", *MANUFACTURERS}:
        sys.exit(f"no parser for source {', '.join(sorted(unknown))}")

    discs = parse_marshall(src / manifest["marshall"]["file"])
    print(f"marshall: {len(discs)} discs")
    # recorded before brands.toml moves any, so they're as Marshall Street has them
    numbers = [
        {"source": "marshall", "disc_id": d["id"], **{k: d[k] for k in ("brand", "model", *FLIGHT)}, "url": d["link"]}
        for d in discs
    ]
    brands = apply_brands(discs, config)

    for name, parse in MANUFACTURERS.items():
        if name not in manifest:
            continue
        rows = parse(src / manifest[name]["file"])
        if not rows:
            sys.exit(f"{name}: found no discs; has the page's layout changed?")
        if unknown := sorted({r["brand"] for r in rows} - set(config["brands"])):
            sys.exit(f"{name}: brands.toml has no entry for brand {', '.join(unknown)}")
        for r, disc_id in zip(rows, merge(discs, name, rows)):
            numbers.append({"source": name, "disc_id": disc_id, **r})

    pdga = parse_pdga(src / manifest["pdga"]["file"]) if "pdga" in manifest else []
    if pdga:
        print(f"pdga: {len(pdga)} approved discs from {len({r['manufacturer'] for r in pdga})} manufacturers")
        check_pdga_names(config["brands"], pdga)
        link_pdga(discs, pdga, config["brands"], molds)

    db_path.unlink(missing_ok=True)
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)
    insert(db, "brands", brands)
    insert(db, "brand_pdga", [{"brand": k, "manufacturer": m} for k, b in config["brands"].items() for m in b["pdga"]])
    lineage = [{"brand": k, "related": e["with"], "note": e["note"], "source": e["source"]}
               for k, b in config["brands"].items() for e in b.get("lineage", [])]  # fmt: skip
    if lineage:
        insert(db, "brand_lineage", lineage)
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
