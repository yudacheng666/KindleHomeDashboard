#!/usr/bin/env python3
"""Basic public-tree hygiene; never replaces pre-push semantic review."""
from pathlib import PurePosixPath, Path
import subprocess
import sys

required = {"AGENTS.md", "SECURITY.md", "README.md", "docs/REQUIREMENTS.md",
            "docs/ai-memory/PROJECT_STATE.md", "docs/ai-memory/DECISIONS.md"}
blocked_dirs = {"private", "config.local", "data", "state", "cache", "logs", "backups"}
blocked_suffixes = {".db", ".sqlite", ".sqlite3", ".log", ".pem", ".key", ".p12", ".zip"}
tracked = set(subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")) - {""}
errors = []
for name in sorted(required - tracked):
    errors.append("Missing required path: " + name)
for name in sorted(tracked):
    p = PurePosixPath(name)
    if (blocked_dirs.intersection(p.parts[:-1]) or
        (p.name.startswith(".env") and p.name != ".env.example") or
        ".local." in p.name or p.suffix.lower() in blocked_suffixes):
        errors.append("Disallowed tracked path (name withheld)")
    if Path(name).is_symlink():
        errors.append("Tracked symlink requires explicit review (name withheld)")
if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print("Public tree path check passed; semantic privacy review still required.")
