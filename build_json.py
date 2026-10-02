#!/usr/bin/env python3
"""Export discs.db to the JSON the frontend loads.

discs.db is the canonical data, built by build_db.py; this derives from it the
two files static/data/ serves:

    discs.json         every disc, except its description
    descriptions.json  descriptions as plain text, keyed by disc id

Descriptions are two thirds of the database and are only needed when a disc is
clicked, so they're kept apart and fetched on demand. They're stored as HTML
but only ever displayed as text, so the markup is stripped here.

Usage: build_json.py [db] [outdir]
"""

import json
import re
import sqlite3
import sys
from html.parser import HTMLParser
from pathlib import Path

# every column but description and in_stock_choices, which nothing displays
COLUMNS = """id, brand, model, pdga_model, category, speed, glide, turn, fade,
    stability, stability_group, out_of_production, in_stock_products, on_sale,
    bg_color, text_color, link, image, diameter_cm, height_cm, rim_depth_cm,
    rim_thickness_cm, max_weight_g, pdga_approved_date"""

# the order the chart draws discs in, fastest and most overstable first. The
# frontend relies on it: filtering the array preserves it, so app.js never sorts.
ORDER = "speed DESC, turn + fade DESC, brand, model"

BOOLS = ("out_of_production", "on_sale")


def num(v):
    """Write whole numbers from REAL columns as 15 rather than 15.0."""
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


class TextExtractor(HTMLParser):
    """Collect the text of an HTML fragment, ignoring tags and their contents
    where that content isn't prose.

    A regex can't do this job: some descriptions carry a pasted-in <article>
    whose class attribute contains a quoted '>', and others are truncated
    mid-tag because the scraped attribute was cut short.
    """

    SKIP = {"script", "style", "iframe"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skipping = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skipping += 1

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skipping:
            self.skipping -= 1

    def handle_data(self, data):
        if not self.skipping:
            self.parts.append(data)


def text(html):
    """Reduce a description's HTML to the text the detail dialog shows."""
    if not html:
        return None
    # a few descriptions are escaped twice, which hides their markup from the
    # first pass, so parse until the text stops changing
    for _ in range(3):
        p = TextExtractor()
        p.feed(html)
        p.close()
        out = " ".join(p.parts)
        if out == html:
            break
        html = out
    return re.sub(r"\s+", " ", html).strip() or None


def main():
    here = Path(__file__).parent
    db_path = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "discs.db"
    outdir = Path(sys.argv[2]) if len(sys.argv) > 2 else here / "static" / "data"

    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row

    discs = []
    for row in db.execute(f"SELECT {COLUMNS} FROM discs ORDER BY {ORDER}"):
        d = dict(row)
        for b in BOOLS:
            d[b] = bool(d[b])
        # drop nulls; the frontend treats missing and null the same, and most
        # discs are missing at least one measurement
        discs.append({k: num(v) for k, v in d.items() if v is not None})

    descriptions = {}
    for row in db.execute("SELECT id, description FROM discs WHERE description IS NOT NULL"):
        if desc := text(row["description"]):
            descriptions[str(row["id"])] = desc
    db.close()

    outdir.mkdir(parents=True, exist_ok=True)
    for name, data in (("discs.json", discs), ("descriptions.json", descriptions)):
        path = outdir / name
        with path.open("w") as f:
            json.dump(data, f, separators=(",", ":"))
            f.write("\n")
        print(f"wrote {len(data)} records to {path} ({path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
