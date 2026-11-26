"""Run the private home dashboard (Linux/Python 3.10+)."""
import argparse
import fcntl
import os
import re
import signal
from threading import Event
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .http_api import API, LocalServer, tls_context
from .household import Household
from .runtime import Runtime, Window
from .service import BusService
from .trip_store import TripStore


def window_arg(value):
    # e.g. weekdays 0 through 4, explicit local hours.
    match = re.fullmatch(r"([0-6](?:,[0-6])*):([0-9]{2}):([0-9]{2})-([0-9]{2}):([0-9]{2})", value)
    if not match:
        raise argparse.ArgumentTypeError("Use DAYS:HH:MM-HH:MM")
    days, h1, m1, h2, m2 = match.groups()
    h1, m1, h2, m2 = map(int, (h1, m1, h2, m2))
    if h1 >= 24 or m1 >= 60 or h2 > 24 or m2 >= 60 or (h2 == 24 and m2):
        raise argparse.ArgumentTypeError("Invalid time")
    try:
        return Window(tuple(map(int, days.split(","))), h1 * 60 + m1, h2 * 60 + m2)
    except ValueError:
        raise argparse.ArgumentTypeError("Invalid window") from None


class BusSettingsError(ValueError):
    """Safe diagnostic: fixed field name, never the supplied private value."""


def apply_private_settings(args, env):
    """Read optional Compose settings without exposing private values in errors."""
    if args.timezone is None:
        args.timezone = env.get("KHD_TIMEZONE", "Asia/Shanghai")
    try:
        ZoneInfo(args.timezone)
    except (ValueError, ZoneInfoNotFoundError):
        raise ValueError("Invalid local timezone") from None
    enabled = env.get("KHD_BUS_ENABLED", "0")
    if enabled not in ("0", "1"):
        raise BusSettingsError("KHD_BUS_ENABLED must be 0 or 1")
    raw = env.get("KHD_BUS_WINDOWS", "")
    if len(raw) > 2048:
        raise BusSettingsError("KHD_BUS_WINDOWS too long")
    windows = raw.split(";") if raw else []
    if len(windows) > 32 or (args.window and windows):
        raise BusSettingsError("KHD_BUS_WINDOWS: too many windows or conflicting CLI settings")
    if windows:
        try:
            args.window = [window_arg(w.strip()) for w in windows]
        except argparse.ArgumentTypeError:
            raise BusSettingsError("KHD_BUS_WINDOWS: invalid format or time") from None
    args.enable_bus = args.enable_bus or enabled == "1"
    if args.enable_bus and not args.window:
        raise BusSettingsError("KHD_BUS_WINDOWS required when bus enabled")
    if args.daily_limit is None:
        value = env.get("KHD_BUS_DAILY_LIMIT", "1000")
        if not re.fullmatch(r"[0-9]{1,4}", value):
            raise BusSettingsError("KHD_BUS_DAILY_LIMIT must be 1 to 1000")
        args.daily_limit = int(value)
    if not 1 <= args.daily_limit <= 1000:
        raise BusSettingsError("KHD_BUS_DAILY_LIMIT must be 1 to 1000")
    return args


def startup_settings(args, env):
    """Keep household available if only the optional bus settings are invalid."""
    try:
        apply_private_settings(args, env)
    except BusSettingsError as exc:
        if not args.enable_household:
            raise
        args.enable_bus = False
        args.window = []
        args.daily_limit = 1000
        return str(exc)
    return ""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--tls-cert", help="Optional private certificate for loopback HTTPS preview")
    parser.add_argument("--tls-key", help="Private key matching the certificate")
    parser.add_argument("--enable-bus", action="store_true")
    parser.add_argument("--enable-household", action="store_true")
    parser.add_argument("--lan-host", help="Explicit private IPv4 NAS address")
    parser.add_argument("--lan-network", help="Trusted home IPv4 CIDR")
    parser.add_argument("--open-admin", action="store_true", help="Explicitly allow LAN editing without a password")
    parser.add_argument("--timezone")
    parser.add_argument("--window", action="append", type=window_arg, default=[])
    parser.add_argument("--daily-limit", type=int)
    args = parser.parse_args()
    try:
        bus_config_error = startup_settings(args, os.environ)
    except ValueError as exc:
        parser.error(str(exc))
    if bus_config_error:
        print("Bus disabled; household remains available: " + bus_config_error, flush=True)
    if bool(args.tls_cert) != bool(args.tls_key):
        parser.error("Specify both TLS certificate and key")
    direct = bool(args.lan_host and args.lan_network)
    if bool(args.lan_host) != bool(args.lan_network) or (args.open_admin and not direct):
        parser.error("Specify both LAN address and subnet for direct access")
    if direct and not args.open_admin and not os.environ.get("KHD_ADMIN_TOKEN"):
        parser.error("Set management credentials with TLS, or explicitly allow open administration")
    if args.open_admin and os.environ.get("KHD_ADMIN_TOKEN"):
        parser.error("Remove management token before explicitly enabling open administration")
    lock_fd = None
    try:
        # Own the private volume for the entire process lifetime.
        store = TripStore(args.directory)
        lock_fd = os.open(store.path.parent / "service.lock",
                          os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        bus = BusService(args.directory, enabled=args.enable_bus, daily_limit=args.daily_limit,
                         config_error=bool(bus_config_error))
        runtime = Runtime(bus, windows=args.window, timezone_name=args.timezone)
        household = Household(args.directory) if args.enable_household else None
        tls = tls_context(args.tls_cert, args.tls_key) if args.tls_cert else None
        api = API(runtime, os.environ.get("KHD_READ_TOKEN"), os.environ.get("KHD_ADMIN_TOKEN"), household=household, direct=direct)
        with LocalServer(api, args.port, tls=tls, lan_host=args.lan_host, lan_network=args.lan_network) as server:
            stopping = Event()
            def stop_signal(signum, frame):
                stopping.set()
            old_handlers = {s: signal.signal(s, stop_signal)
                            for s in (signal.SIGTERM, signal.SIGINT)}
            server.timeout = 0.5
            try:
                runtime.start()
                while not stopping.is_set():
                    server.handle_request()
            finally:
                try:
                    runtime.close()
                finally:
                    for s, handler in old_handlers.items():
                        signal.signal(s, handler)
    except Exception:
        # No paths, configuration or token values in terminal logs.
        print("Startup or runtime failed; check local settings and service state.")
        return 1
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
