#!/usr/bin/env python3
"""Download the pages discs.db is built from into sources/.

Each source is saved as fetched, untouched, and committed, so a rebuild never
needs the network and git history shows what changed upstream between fetches.
sources/fetched.json records where and when each file came from; build_db.py
copies that into the database.

Usage: fetch.py [source ...]    (default: all of them)
"""

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# name -> (url, file under sources/). build_db.py has a parser for each name.
SOURCES = {
    # the retailer's flight guide: every disc it carries, and the base dataset
    "marshall": ("https://www.marshallstreetdiscgolf.com/flightguide", "marshall/flightguide.html"),
    # manufacturers, whose own numbers win over the retailer's
    "rpm": ("https://www.rpmdiscs.com/disc-golf-discs/", "rpm/disc-golf-discs.html"),
}

USER_AGENT = "hyzer.cloud data fetcher (+https://hyzer.cloud)"


# curl rather than urllib: rpmdiscs.com's host reliably truncates its chunked
# HTTP/1.1 responses about 20KB short of the end, and urllib can't speak HTTP/2
def fetch(url):
    cmd = ["curl", "--fail", "--silent", "--show-error", "--location", "--compressed",
           "--retry", "3", "--max-time", "120", "--user-agent", USER_AGENT, url]  # fmt: skip
    return subprocess.run(cmd, check=True, capture_output=True).stdout


def main():
    here = Path(__file__).parent / "sources"
    names = sys.argv[1:] or list(SOURCES)
    if unknown := [n for n in names if n not in SOURCES]:
        sys.exit(f"unknown source: {', '.join(unknown)}; known: {', '.join(SOURCES)}")

    manifest_path = here / "fetched.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}

    for name in names:
        url, file = SOURCES[name]
        body = fetch(url)
        path = here / file
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        manifest[name] = {
            "url": url,
            "file": file,
            "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sha256": hashlib.sha256(body).hexdigest(),
        }
        # written as each source lands, so a later failure loses nothing
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        print(f"{name}: {len(body):,} bytes from {url}")


if __name__ == "__main__":
    main()
