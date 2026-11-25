#!/usr/bin/env bash
# Run on an isolated Linux Docker host, with fictional content only.
set -euo pipefail
work="$(mktemp -d)"
export KHD_DATA_DIR="$work/volume"
export KHD_PRIVATE_ENV="$work/access.env"
export COMPOSE_PROJECT_NAME="khd-smoke-${RANDOM}-$$"
cleanup() {
    docker compose down --timeout 35 >/dev/null 2>&1 || true
    # The temporary data directory is owned by the container UID.
    sudo rm -rf -- "$work"
}
trap cleanup EXIT
mkdir -m 700 "$KHD_DATA_DIR"
sudo chown 10001:10001 "$KHD_DATA_DIR"
python3 - <<'PY'
import os
from secrets import token_urlsafe
fd = os.open(os.environ["KHD_PRIVATE_ENV"], os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
with os.fdopen(fd,"w") as f:
    f.write("KHD_READ_TOKEN="+token_urlsafe(32)+"\n")
    f.write("KHD_ADMIN_TOKEN="+token_urlsafe(32)+"\n")
PY
docker compose config --quiet
docker compose build
docker compose up -d --no-build
cid="$(docker compose ps -q dashboard)"
test -n "$cid"
# Check isolation without printing container environment or private paths.
docker inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}} {{len .HostConfig.PortBindings}}' "$cid" | grep -Fx 'true 134217728 500000000 32 0'
test "$(docker exec "$cid" id -u)" = 10001
probe() {
    docker exec -i "$cid" python - "$1" <<'PY'
import json, os, sys, time
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from datetime import datetime
from zoneinfo import ZoneInfo
base = "http://127.0.0.1:8080"
def call(path, key, payload=None):
    headers = {"Authorization":"Bearer "+os.environ[key]}
    if payload is not None:
        headers["Content-Type"]="application/json"
    with urlopen(Request(base+path, headers=headers,
                         data=None if payload is None else json.dumps(payload).encode()),timeout=3) as r:
        return json.load(r)
for _ in range(30):
    try:
        view=call("/api/home/view","KHD_READ_TOKEN")
        break
    except OSError:
        time.sleep(1)
else:
    raise RuntimeError("Container service unavailable")
assert call("/api/bus/view","KHD_READ_TOKEN")["snapshot"]["status"]=="disabled"
assert urlopen(base+"/display",timeout=3).status==200
if sys.argv[1]=="write":
    assert not view["tasks"]
    try:
        call("/api/home/task/add","KHD_READ_TOKEN",{"title":"Fictional test","start":view["date"],"repeat":"once"})
    except HTTPError as e:
        assert e.code==401
    else:
        raise AssertionError("Read token could write")
    call("/api/home/task/add","KHD_ADMIN_TOKEN",{"title":"Fictional test","start":view["date"],"repeat":"once"})
assert len(call("/api/home/view","KHD_READ_TOKEN")["tasks"])==1
print("Container API PASS: "+sys.argv[1])
PY
}
probe write
# Stop explicitly, assert normal shutdown before recreating the container.
docker compose stop -t 35 dashboard
test "$(docker inspect --format '{{.State.ExitCode}}' "$cid")" = 0
docker compose rm -f dashboard
docker compose up -d --no-build
cid="$(docker compose ps -q dashboard)"
probe read
# Confirm image does not contain build secrets or Git history.
docker exec "$cid" python -c 'from pathlib import Path; assert not Path("/app/.git").exists(); assert not Path("/app/.env").exists(); assert not Path("/app/tests").exists()'
docker stats --no-stream --format 'Container sampled resources: {{.CPUPerc}} CPU, {{.MemUsage}} memory' "$cid"
docker image inspect kindle-home-dashboard:dev --format 'Development image size: {{.Size}} bytes'
docker compose stop -t 35 dashboard
test "$(docker inspect --format '{{.State.ExitCode}}' "$cid")" = 0
echo "Docker deployment PASS: isolated, non-root, resource limits, authenticated API, graceful stop, recreate and persistence."
