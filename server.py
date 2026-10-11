#!/usr/bin/env python3
"""Serve the RecordTrimTranscribe web app locally.

Everything (audio decode, DSP, transcription, export) runs in the browser; this
server only hands over static files, which are the same files the Tauri desktop
build embeds.

Usage:
    python server.py [--port 8770] [--no-browser]
"""

from __future__ import annotations

import argparse
import functools
import http.server
import mimetypes
import socket
import sys
import threading
import webbrowser
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent / "app"

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/json", ".json")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        # No caching so edits show up immediately during development.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args) -> None:  # quieter
        pass


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    if not APP_ROOT.exists():
        print(f"app directory not found: {APP_ROOT}", file=sys.stderr)
        return 1

    port = args.port
    while not port_free(port):
        port += 1

    handler = functools.partial(Handler, directory=str(APP_ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    url = f"http://127.0.0.1:{port}/"
    print(f"RecordTrimTranscribe serving {APP_ROOT}")
    print(f"Open {url}  (Ctrl+C to stop)")

    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
