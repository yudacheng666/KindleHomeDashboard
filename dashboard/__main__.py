"""Run the bus API on loopback for local integration only (Linux/Python 3.10+)."""
import argparse
import fcntl
import os
import re
import signal
from threading import Event

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
    parser.add_argument("--timezone", default="Asia/Shanghai")
    parser.add_argument("--window", action="append", type=window_arg, default=[])
    parser.add_argument("--daily-limit", type=int, default=1000)
    args = parser.parse_args()
    if args.enable_bus and not args.window:
        parser.error("Explicit collection windows required when enabling bus")
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
        bus = BusService(args.directory, enabled=args.enable_bus, daily_limit=args.daily_limit)
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
