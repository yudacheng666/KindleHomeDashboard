"""Local HTTP API; explicit trusted LAN mode or authenticated loopback."""
from dataclasses import asdict
from datetime import datetime
from hmac import compare_digest
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from ipaddress import IPv4Address, IPv4Network
from pathlib import Path
import re
import ssl
from secrets import token_urlsafe
from threading import Lock

from .budget import BudgetWait
from .bus import AccessBlocked, BusError
from .routes import Line, DirectionUnavailable
from .trip_store import TripStore
from .household_api import HouseholdAPI, READ, MANAGE, POST_PATHS

MAX_BODY = 16384
WEB = Path(__file__).resolve().parent / "web"
ASSETS = {"/": ("display.html", "text/html; charset=utf-8"),
          "/bus": ("bus.html", "text/html; charset=utf-8"),
          "/bus.js": ("bus.js", "application/javascript; charset=utf-8"),
          "/home": ("home.html", "text/html; charset=utf-8"),
          "/home.js": ("home.js", "application/javascript; charset=utf-8"),
          "/display": ("display.html", "text/html; charset=utf-8"),
          "/auto": ("display.html", "text/html; charset=utf-8"),
          "/display.js": ("display.js", "application/javascript; charset=utf-8"),
          "/admin": ("admin.html", "text/html; charset=utf-8"),
          "/admin/system": ("admin.html", "text/html; charset=utf-8"),
          "/admin/display": ("home.html", "text/html; charset=utf-8"),
          "/admin/family": ("home.html", "text/html; charset=utf-8"),
          "/admin/bus": ("bus.html", "text/html; charset=utf-8"),
          "/admin/weather": ("display.html", "text/html; charset=utf-8"),
          "/admin/driving": ("display.html", "text/html; charset=utf-8"),
          "/admin.css": ("admin.css", "text/css; charset=utf-8"),
          "/admin.js": ("admin.js", "application/javascript; charset=utf-8"),
          "/preview": ("display.html", "text/html; charset=utf-8"),
          "/preview/auto": ("display.html", "text/html; charset=utf-8")}

ADMIN_PAGES = frozenset(("/admin", "/admin/system", "/admin/display", "/admin/family",
                        "/admin/bus", "/admin/weather", "/admin/driving"))
PREVIEW_PAGES = frozenset(("/preview", "/preview/auto"))


def _public_version():
    try:
        value = (WEB.parent.parent / "VERSION").read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        return None
    return value if re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", value) else None


VERSION = _public_version()


def _default(value):
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError("Unsupported response")


def _token(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", value):
        raise ValueError("Use a locally generated random access token")
    return value


class API:
    def __init__(self, runtime, read_token, admin_token, household=None, *, direct=False, weather=None, driving=None):
        self.runtime = runtime
        self.weather = weather
        self.driving = driving
        self.direct = direct
        self.household = HouseholdAPI(household, runtime) if household is not None else None
        self.read_token = None if direct else _token(read_token)
        self.admin_token = _token(admin_token) if admin_token is not None or not direct else None
        if not direct and compare_digest(self.read_token, self.admin_token):
            raise ValueError("Separate read and administration tokens required")
        self.selection = None
        self.lock = Lock()

    def authorized(self, header, admin=False):
        if self.direct and (not admin or self.admin_token is None):
            return True
        if not isinstance(header, str) or not header.isascii():
            return False
        if not header.startswith("Bearer "):
            return False
        value = header[7:]
        return compare_digest(value, self.admin_token) or (
            not admin and compare_digest(value, self.read_token))

    def bus_view(self, bus):
        payload = asdict(bus)
        now = self.runtime.bus.clock()
        snapshot = payload["snapshot"]
        snapshot["server_now_ms"] = int(now.timestamp() * 1000)
        snapshot["fetched_at_ms"] = int(bus.snapshot.fetched_at.timestamp() * 1000)
        snapshot["timezone_offset_min"] = int(now.astimezone(self.runtime.zone).utcoffset().total_seconds() / 60)
        return payload

    def automatic_view(self):
        """Use the existing collection windows, never call the upstream here."""
        if self.household is not None and not self.runtime.active():
            return {"mode": "family", "view": self.household.get(READ)}
        bus = self.runtime.read()
        if self.household is not None and (bus.trip is None or bus.snapshot.status in ("disabled", "config_error")):
            return {"mode": "family", "view": self.household.get(READ)}
        # During the configured commute, keep bus failures visible rather than
        # silently presenting a timetable or hiding the failure.
        return {"mode": "bus", "view": self.bus_view(bus)}

    def dispatch(self, path, body):
        if path == "/api/driving/reverse" and self.driving is not None:
            return self.driving.reverse(body)
        if path == "/api/driving/search" and self.driving is not None:
            return self.driving.search_locations(body)
        if path == "/api/driving/settings" and self.driving is not None:
            return self.driving.configure(body)
        if path == "/api/weather/search" and self.weather is not None:
            return self.weather.search_locations(body)
        # Single selection session: a newer route preview invalidates the old
        # handle, preventing a stale form from silently saving another route.
        with self.lock:
            if path in POST_PATHS and self.household is not None:
                return self.household.post(path, body)
            if path == "/api/weather/settings" and self.weather is not None:
                return self.weather.configure(body)
            bus = self.runtime.bus
            if path == "/api/bus/schedule":
                result = self.runtime.configure_schedule(body)
                self.selection = None
                return result
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
                return self.bus_view(self.runtime.read())
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

    def send_content(self, status, raw, content_type, *, admin_page=False, preview_page=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN" if preview_page else "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        # Only the dedicated preview document can be framed by the same origin.
        styles = "'self' 'unsafe-inline'" if admin_page else "'unsafe-inline'"
        ancestors = "'self'" if preview_page else "'none'"
        frames = "; frame-src 'self'" if admin_page else ""
        self.send_header("Content-Security-Policy",
                         "default-src 'none'; script-src 'self'; style-src " + styles +
                         "; connect-src 'self'; img-src data:; frame-ancestors " + ancestors +
                         "; base-uri 'none'; form-action 'none'" + frames)
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(raw)

    def same_origin(self):
        # Exact host and same-origin only; no CORS or cookie auth.
        origins = self.headers.get_all("Origin") or []
        if not self.server.allowed_peer(self.client_address[0]) or self.headers.get_all("Host") != [self.server.expected_host] or origins not in ([], [self.server.expected_origin]):
            self.send_json(403, {"error": "forbidden"})
            return False
        return True

    def guard(self, admin):
        if not self.same_origin():
            return False
        headers = self.headers.get_all("Authorization") or []
        if len(headers) > 1 or not self.server.api.authorized(headers[0] if headers else None, admin):
            self.send_json(401, {"error": "unauthorized"})
            return False
        return True

    def do_GET(self):
        if self.path == "/access-mode.js":
            if not self.same_origin():
                return
            direct = self.server.api.direct
            flags = {"direct": direct, "openAdmin": direct and self.server.api.admin_token is None, "version": VERSION}
            self.send_content(200, ("window.KHD_ACCESS="+json.dumps(flags)+";").encode(),
                              "application/javascript; charset=utf-8")
            return
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
            admin_page = self.path in ADMIN_PAGES
            if admin_page:
                raw = raw.replace(b"</head>", b'<link rel="stylesheet" href="/admin.css"></head>', 1)
                raw = raw.replace(b"<body>", b'<body class="desktop-admin">', 1)
                raw = raw.replace(b"</body>", b'<script src="/admin.js"></script></body>', 1)
            self.send_content(200, raw, content_type, admin_page=admin_page,
                              preview_page=self.path in PREVIEW_PAGES)
            return
        if self.path == "/api/access/admin":
            if self.guard(True):
                self.send_json(200, {"admin": True})
            return
        if not self.guard(self.path in (MANAGE, "/api/bus/schedule", "/api/weather/settings", "/api/driving/settings")):
            return
        home = self.path in (READ, MANAGE) and self.server.api.household is not None
        weather = self.path in ("/api/weather/view", "/api/weather/settings") and self.server.api.weather is not None
        driving = self.path in ("/api/driving/view", "/api/driving/settings") and self.server.api.driving is not None
        if self.path not in ("/api/bus/view", "/api/display/auto", "/api/bus/schedule") and not home and not weather and not driving:
            self.send_json(404, {"error": "not_found"})
            return
        try:
            if driving:
                payload = (self.server.api.driving.settings_view() if self.path == "/api/driving/settings"
                           else self.server.api.driving.read())
            elif weather:
                payload = (self.server.api.weather.settings_view() if self.path == "/api/weather/settings"
                           else self.server.api.weather.read())
            elif self.path == "/api/bus/schedule":
                payload = self.server.api.runtime.schedule_view()
            elif self.path == "/api/display/auto":
                payload = self.server.api.automatic_view()
            else:
                payload = (self.server.api.household.get(self.path) if home
                           else self.server.api.bus_view(self.server.api.runtime.read()))
        except Exception:
            self.send_json(503, {"error": "service_error"})
            return
        if self.path == READ or (self.path == "/api/display/auto" and payload["mode"] == "family"):
            view = payload if self.path == READ else payload["view"]
            headers = self.headers.get_all("Authorization") or []
            view["can_complete"] = self.server.api.authorized(headers[0] if headers else None, True)
        if self.path == "/api/driving/view":
            headers = self.headers.get_all("Authorization") or []
            payload["can_reverse"] = self.server.api.authorized(headers[0] if headers else None, True)
        self.send_json(200, payload)

    def do_POST(self):
        if not self.guard(True):
            return
        home = self.path in POST_PATHS and self.server.api.household is not None
        weather = self.path in ("/api/weather/settings", "/api/weather/search") and self.server.api.weather is not None
        driving = self.path in ("/api/driving/settings", "/api/driving/search", "/api/driving/reverse") and self.server.api.driving is not None
        if self.path not in ("/api/bus/search", "/api/bus/route", "/api/bus/save", "/api/bus/schedule") and not home and not weather and not driving:
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
        except BudgetWait as exc:
            self.send_json(503 if exc.code in ("bus_disabled", "bus_config_error") else 429, {"error": exc.code})
        except DirectionUnavailable:
            self.send_json(502, {"error": "direction_unavailable"})
        except BusError:
            self.send_json(502, {"error": "provider_error"})
        except (ValueError, TypeError, KeyError, RecursionError):
            self.send_json(400, {"error": "invalid_selection_or_request"})
        except Exception:
            self.send_json(503, {"error": "service_error"})
        else:
            self.send_json(200, result)


def tls_context(cert, key):
    """Load explicit private local PEM files; never generate or trust a CA here."""
    paths = []
    for value in (cert, key):
        p = Path(value)
        if not p.is_absolute() or p.is_symlink() or not p.is_file():
            raise ValueError("Use private absolute certificate/key paths")
        TripStore(str(p.parent))
        paths.append(p)
    if paths[1].stat().st_mode & 0o077:
        raise ValueError("TLS key must not be accessible by group or others")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(str(paths[0]), str(paths[1]))
    return ctx


PRIVATE = tuple(IPv4Network(n) for n in ("10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"))


class LocalServer(HTTPServer):
    def __init__(self, api, port=8080, *, tls=None, lan_host=None, lan_network=None):
        self.api = api
        self.tls = tls
        self.lan_network = None
        bind = "127.0.0.1"
        host = bind
        if lan_host is not None or lan_network is not None:
            if not api.direct or not lan_host or not lan_network:
                raise ValueError("Explicit LAN address and subnet required")
            address, network = IPv4Address(lan_host), IPv4Network(lan_network, strict=True)
            if not any(network.subnet_of(n) for n in PRIVATE) or address not in network:
                raise ValueError("Use a private IPv4 LAN subnet and address")
            if address in (network.network_address, network.broadcast_address):
                raise ValueError("Invalid LAN host")
            if api.admin_token is not None and tls is None:
                raise ValueError("Management credentials require HTTPS on LAN")
            self.lan_network = network
            # Docker bridge publishing binds the NAS IP at the host boundary.
            # No proxy headers are used to decide client address or origin.
            bind, host = "0.0.0.0", str(address)
        super().__init__((bind, port), Handler)
        self.expected_host = host + ":" + str(self.server_port)
        self.expected_origin = ("https://" if tls is not None else "http://") + self.expected_host

    def allowed_peer(self, address):
        return (address == "127.0.0.1" if self.lan_network is None
                else IPv4Address(address) in self.lan_network)

    def get_request(self):
        sock, address = super().get_request()
        if self.tls is None:
            return sock, address
        try:
            # Bound the handshake before HTTP parsing. No plaintext fallback.
            sock.settimeout(5)
            sock = self.tls.wrap_socket(sock, server_side=True)
            return sock, address
        except BaseException:
            sock.close()
            raise

    def handle_error(self, request, client_address):
        # Avoid raw traceback and private client address in logs.
        pass
