"""Loopback-only authenticated JSON API prototype.

Do not expose this plain HTTP service to the LAN or Internet. A reviewed
HTTPS/access layer and device pairing are required before LAN deployment.
"""
from dataclasses import asdict
from datetime import datetime
from hmac import compare_digest
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import re
from secrets import token_urlsafe
from threading import Lock

from .budget import BudgetWait
from .bus import AccessBlocked, BusError
from .routes import Line

MAX_BODY = 16384
WEB = Path(__file__).resolve().parent / "web"
ASSETS = {"/": ("bus.html", "text/html; charset=utf-8"),
          "/bus.js": ("bus.js", "application/javascript; charset=utf-8")}


def _default(value):
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError("Unsupported response")


def _token(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", value):
        raise ValueError("Use a locally generated random access token")
    return value


class API:
    def __init__(self, runtime, read_token, admin_token):
        self.runtime = runtime
        self.read_token, self.admin_token = _token(read_token), _token(admin_token)
        if compare_digest(self.read_token, self.admin_token):
            raise ValueError("Separate read and administration tokens required")
        self.selection = None
        self.lock = Lock()

    def authorized(self, header, admin=False):
        if not isinstance(header, str) or not header.isascii():
            return False
        if not header.startswith("Bearer "):
            return False
        value = header[7:]
        return compare_digest(value, self.admin_token) or (
            not admin and compare_digest(value, self.read_token))

    def dispatch(self, path, body):
        # Single selection session: a newer route preview invalidates the old
        # handle, preventing a stale form from silently saving another route.
        with self.lock:
            bus = self.runtime.bus
            if path == "/api/bus/search":
                if set(body) != {"keyword"}:
                    raise ValueError("Invalid search")
                self.selection = None
                return {"lines": [asdict(x) for x in bus.search_lines(body["keyword"])]}
            if path == "/api/bus/route":
                if set(body) != {"line", "direction"} or not isinstance(body["line"], dict):
                    raise ValueError("Invalid route")
                self.selection = None
                line = Line(**body["line"])
                route = bus.get_route(line, body["direction"])
                handle = token_urlsafe(24)
                self.selection = (handle, route)
                return {"selection": handle, "route": asdict(route)}
            if path == "/api/bus/save":
                if set(body) != {"selection", "boarding", "destination"}:
                    raise ValueError("Invalid selection")
                if not self.selection or body["selection"] != self.selection[0]:
                    raise ValueError("Selection expired")
                view = bus.save_trip(self.selection[1], body["boarding"], body["destination"])
                self.selection = None
                return asdict(self.runtime.read())
            raise ValueError("Unknown operation")


class Handler(BaseHTTPRequestHandler):
    server_version = "KindleHomeDashboard"
    sys_version = ""
    timeout = 5

    def log_message(self, *args):
        # Never log paths, headers, bodies, addresses or credentials.
        pass

    def send_json(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False, default=_default).encode()
        self.send_content(status, raw, "application/json; charset=utf-8")

    def send_content(self, status, raw, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(raw)

    def same_origin(self):
        # Exact host and same-origin only; no CORS or cookie auth.
        origins = self.headers.get_all("Origin") or []
        if self.headers.get_all("Host") != [self.server.expected_host] or origins not in ([], ["http://" + self.server.expected_host]):
            self.send_json(403, {"error": "forbidden"})
            return False
        return True

    def guard(self, admin):
        if not self.same_origin():
            return False
        headers = self.headers.get_all("Authorization") or []
        if len(headers) != 1 or not self.server.api.authorized(headers[0], admin):
            self.send_json(401, {"error": "unauthorized"})
            return False
        return True

    def do_GET(self):
        if self.path in ASSETS:
            if not self.same_origin():
                return
            filename, content_type = ASSETS[self.path]
            try:
                raw = (WEB / filename).read_bytes()
            except OSError:
                self.send_json(503, {"error": "service_error"})
                return
            # Static shell only; no secrets, configuration or live data.
            self.send_content(200, raw, content_type)
            return
        if not self.guard(False):
            return
        if self.path != "/api/bus/view":
            self.send_json(404, {"error": "not_found"})
            return
        try:
            payload = asdict(self.server.api.runtime.read())
        except Exception:
            self.send_json(503, {"error": "service_error"})
            return
        self.send_json(200, payload)

    def do_POST(self):
        if not self.guard(True):
            return
        if self.path not in ("/api/bus/search", "/api/bus/route", "/api/bus/save"):
            self.send_json(404, {"error": "not_found"})
            return
        if self.headers.get("Transfer-Encoding") is not None or self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error": "json_required"})
            return
        lengths = self.headers.get_all("Content-Length") or []
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,5}", lengths[0]):
            self.send_json(400, {"error": "invalid_length"})
            return
        size = int(lengths[0])
        if not 0 < size <= MAX_BODY:
            self.send_json(413, {"error": "body_too_large"})
            return
        try:
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise ValueError("Incomplete request")
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError("Object required")
            result = self.server.api.dispatch(self.path, body)
        except AccessBlocked:
            self.send_json(503, {"error": "provider_blocked"})
        except BudgetWait:
            self.send_json(429, {"error": "local_budget_wait"})
        except BusError:
            self.send_json(502, {"error": "provider_error"})
        except (ValueError, TypeError, KeyError, RecursionError):
            self.send_json(400, {"error": "invalid_selection_or_request"})
        except Exception:
            self.send_json(503, {"error": "service_error"})
        else:
            self.send_json(200, result)


class LocalServer(HTTPServer):
    def __init__(self, api, port=8080):
        self.api = api
        super().__init__(("127.0.0.1", port), Handler)
        self.expected_host = "127.0.0.1:" + str(self.server_port)

    def handle_error(self, request, client_address):
        # Avoid raw traceback and private client address in logs.
        pass
