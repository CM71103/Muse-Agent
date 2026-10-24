"""muse_hands.server - hands sidecar.

Local-only HTTP server (default 127.0.0.1:8788) exposing screenshot / mouse /
keyboard actions via pyautogui + mss. Bearer-token auth, token read from
~/.muse-agent/hands_token (shared with the Node side, which creates it).

Layout mirrors nanoMuse layer 3: token-gated loopback server, nothing exposed
off-host. aiohttp stdlib-only fallback included (http.server) so the sidecar
runs even without aiohttp installed.

Endpoints:
  GET  /health   -> {"ok": true, "screen": "WxH"}
  POST /execute  -> {"ok": ..., ...}   (action payload from hands tool)
"""

from __future__ import annotations

import json
import os
import sys
import threading

try:
    from aiohttp import web  # preferred

    HAVE_AIOHTTP = True
except ImportError:
    HAVE_AIOHTTP = False

import pyautogui

pyautogui.FAIL = False  # headless test mode must not raise; sidecar returns errors instead

from . import actions

DEFAULT_HOST = os.environ.get("MUSE_HANDS_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("MUSE_HANDS_PORT", "8788"))


def token() -> str:
    home = os.environ.get("MUSE_HOME") or os.path.join(os.path.expanduser("~"), ".muse-agent")
    p = os.path.join(home, "hands_token")
    with open(p, "r", encoding="utf-8") as f:
        return f.read().strip()


def authorized(request_token: str | None) -> bool:
    import hmac

    return bool(request_token) and hmac.compare_digest(request_token, token())


def handle_health() -> dict:
    try:
        import mss

        with mss.mss() as sct:
            mon = sct.monitors[1]
            return {"ok": True, "screen": f"{mon['width']}x{mon['height']}", "server": "muse-hands"}
    except Exception:
        # headless / mss not installed: still report alive, actions will say what's missing
        return {"ok": True, "screen": None, "server": "muse-hands", "note": "screen capture unavailable in this environment"}


def handle_execute(payload: dict) -> dict:
    act = (payload.get("action") or "").strip().lower()
    try:
        if act == "screenshot":
            return actions.screenshot(payload)
        if act == "click":
            return actions.click(payload)
        if act == "double_click":
            return actions.click(payload, clicks=2)
        if act == "double-click":
            return actions.click(payload, clicks=2)
        if act == "move":
            return actions.move(payload)
        if act == "drag":
            return actions.drag(payload)
        if act == "scroll":
            return actions.scroll(payload)
        if act == "type":
            return actions.type_text(payload)
        if act == "hotkey":
            return actions.hotkey(payload)
        if act == "key_press":
            return actions.hotkey(payload)  # same impl: combo string
        return {"ok": False, "error": f"unknown action: {act!r}"}
    except Exception as e:  # noqa: BLE001 - sidecar reports, never crashes
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ---------------- aiohttp app ----------------

def build_aiohttp_app() -> "web.Application":
    app = web.Application()

    def bearer(request):
        h = request.headers.get("Authorization", "")
        return h[7:].strip() if h.lower().startswith("bearer ") else None

    async def health(_request):
        if not bearer(_request) or not authorized(bearer(_request)):
            return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
        return web.json_response(handle_health())

    async def execute(request):
        got = bearer(request)
        if not got or not authorized(got):
            return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid json"}, status=400)
        return web.json_response(handle_execute(payload or {}))

    app.router.add_get("/health", health)
    app.router.add_post("/execute", execute)
    return app


# ---------------- stdlib fallback ----------------

def run_stdlib(host: str, port: int) -> None:
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Handler(BaseHTTPRequestHandler):
        def _bearer(self):
            h = self.headers.get("Authorization", "")
            return h[7:].strip() if h.lower().startswith("bearer ") else None

        def do_GET(self):  # noqa: N802
            if self.path != "/health":
                self.send_response(404)
                self.end_headers()
                return
            got = self._bearer()
            if not got or not authorized(got):
                self.send_response(401)
                self.end_headers()
                return
            body = json.dumps(handle_health()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):  # noqa: N802
            if self.path != "/execute":
                self.send_response(404)
                self.end_headers()
                return
            got = self._bearer()
            if not got or not authorized(got):
                self.send_response(401)
                self.end_headers()
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception:
                self.send_response(400)
                self.end_headers()
                return
            body = json.dumps(handle_execute(payload or {})).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_a):
            pass

    HTTPServer((host, port), Handler).serve_forever()


def main() -> None:
    host = DEFAULT_HOST
    port = DEFAULT_PORT
    if len(sys.argv) > 2 and sys.argv[1] == "--port":
        port = int(sys.argv[2])
    if not os.path.exists(
        os.path.join(os.environ.get("MUSE_HOME") or os.path.join(os.path.expanduser("~"), ".muse-agent"),
        "hands_token")
    ):
        print("hands_token missing; start from the Node side (hands_client.ensureToken) first", file=sys.stderr)
        sys.exit(2)
    print(f"muse-hands sidecar on http://{host}:{port} (aiohttp={HAVE_AIOHTTP})", file=sys.stderr)
    if HAVE_AIOHTTP:
        web.run_app(build_aiohttp_app(), host=host, port=port, print=None)
    else:
        run_stdlib(host, port)


if __name__ == "__main__":
    main()
