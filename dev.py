#!/usr/bin/env python3
"""Serve static/ for development, without caching.

python -m http.server sends Last-Modified but no Cache-Control or ETag, so
browsers fall back to heuristic freshness and will serve a cached index.html
without revalidating it. Paired with a freshly edited app.js, that fails as a
null DOM element rather than as anything resembling a cache problem.

Serving static/ at the root also matches how GitHub Pages lays the site out,
so relative paths behave the same here as in production.

Usage: dev.py [port]
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        # the default logs every request; only say something when it's not a 200
        if not str(args[1] if len(args) > 1 else "").startswith("2"):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8417
    root = Path(__file__).parent / "static"
    handler = partial(NoCacheHandler, directory=str(root))
    print(f"serving {root} on http://localhost:{port}")
    try:
        ThreadingHTTPServer(("localhost", port), handler).serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
