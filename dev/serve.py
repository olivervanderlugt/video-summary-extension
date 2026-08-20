#!/usr/bin/env python3
"""Serve the repo for the two development harnesses.

    python3 dev/serve.py

    http://localhost:8777/watch?v=aircAruvnKk   the content scripts on a fake
                                                YouTube watch page
    http://localhost:8777/options               the real settings page, with a
                                                stand-in for the chrome APIs

`/watch` exists because content.js only mounts on that path. `/options` serves
the real `src/options/options.html` with `dev/options-shim.js` injected ahead of
its own script, so the page finds a `chrome` object where it expects one. The
injection happens here, in the dev server, so nothing dev-only leaks into the
shipped page.
"""

import functools
import http.server
import pathlib
import socketserver
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OPTIONS = ROOT / "src" / "options" / "options.html"
SHIM = '<script src="/dev/options-shim.js"></script>'
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - name fixed by the base class
        if self.path.split("?")[0].rstrip("/") == "/options":
            return self.serve_options()
        return super().do_GET()

    def serve_options(self):
        html = OPTIONS.read_text(encoding="utf-8")
        # The page's own <script type="module"> must run after the shim, and a
        # module is deferred, so anything in <head> is early enough.
        if "</head>" in html:
            html = html.replace("</head>", f"  {SHIM}\n</head>", 1)
        else:
            html = SHIM + html
        # Relative asset paths resolve against /options, which is not the
        # directory the page lives in. Point them at the real location.
        html = html.replace('href="options.css"', 'href="/src/options/options.css"')
        html = html.replace('src="options.js"', 'src="/src/options/options.js"')
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def translate_path(self, path):
        if path.split("?")[0].rstrip("/") == "/watch":
            return str(ROOT / "dev" / "harness.html")
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    handler = functools.partial(Handler, directory=str(ROOT))
    with socketserver.TCPServer(("127.0.0.1", PORT), handler) as httpd:
        print(f"watch page:   http://localhost:{PORT}/watch?v=aircAruvnKk")
        print(f"options page: http://localhost:{PORT}/options")
        httpd.serve_forever()
