"""Provision distinct local access credentials without printing them."""
import argparse
import os
from pathlib import Path
from secrets import token_urlsafe

from .trip_store import TripStore


def create_credentials(output):
    path = Path(output)
    if not path.is_absolute():
        raise ValueError("Absolute private output path required")
    TripStore(str(path.parent))
    reader, admin = token_urlsafe(32), token_urlsafe(32)
    while reader == admin:
        admin = token_urlsafe(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="ascii") as stream:
            stream.write("KHD_READ_TOKEN="+reader+"\nKHD_ADMIN_TOKEN="+admin+"\n")
            stream.flush()
            os.fsync(stream.fileno())
        dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        create_credentials(args.output)
    except Exception:
        print("Credential creation failed; use a new private path outside the repository.")
        return 1
    print("New private credential file created. Existing files were not overwritten.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
