"""Run the bus API on loopback for local integration only (Linux/Python 3.10+)."""
import argparse
import fcntl
import os
import re
from pathlib import Path

from .http_api import API, LocalServer
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
    parser.add_argument("--enable-bus", action="store_true")
    parser.add_argument("--enable-household", action="store_true")
    parser.add_argument("--timezone", default="Asia/Shanghai")
    parser.add_argument("--window", action="append", type=window_arg, default=[])
    parser.add_argument("--daily-limit", type=int, default=1000)
    args = parser.parse_args()
    if args.enable_bus and not args.window:
        parser.error("Explicit collection windows required when enabling bus")
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
        api = API(runtime, os.environ.get("KHD_READ_TOKEN"), os.environ.get("KHD_ADMIN_TOKEN"), household=household)
        with LocalServer(api, args.port) as server:
            runtime.start()
            try:
                server.serve_forever(poll_interval=0.5)
            except KeyboardInterrupt:
                pass
            finally:
                runtime.close()
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
