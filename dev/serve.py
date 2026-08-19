#!/usr/bin/env python3
"""Serve the repo so the harness sits at /watch, the path content.js requires.

    python3 dev/serve.py            # http://localhost:8777/watch?v=aircAruvnKk
"""
import functools, http.server, pathlib, socketserver, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777


class Handler(http.server.SimpleHTTPRequestHandler):
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
        print(f"harness: http://localhost:{PORT}/watch?v=aircAruvnKk")
        httpd.serve_forever()
