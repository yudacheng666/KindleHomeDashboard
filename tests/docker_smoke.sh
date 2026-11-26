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

# Direct-mode probe on an isolated Docker network; do not expose the runner's NIC.
net="khd-direct-${RANDOM}-$$"
direct="khd-direct-${RANDOM}-$$"
cleanup_direct() {
    docker rm -f "$direct" >/dev/null 2>&1 || true
    docker network rm "$net" >/dev/null 2>&1 || true
    cleanup
}
trap cleanup_direct EXIT
docker network create --internal --subnet 172.30.99.0/24 "$net" >/dev/null
KHD_LAN_HOST=172.30.99.20 KHD_LAN_NETWORK=172.30.99.0/24 KHD_BUS_ENABLED=1 KHD_BUS_WINDOWS='1:13:00-14:00;6:23:00-01:00' KHD_TIMEZONE=UTC KHD_BUS_DAILY_LIMIT=42 docker compose -f compose.lan.yaml config --format json | python3 -c 'import json,sys; e=json.load(sys.stdin)["services"]["dashboard"]["environment"]; assert e["KHD_BUS_ENABLED"]=="1" and e["KHD_BUS_WINDOWS"]=="1:13:00-14:00;6:23:00-01:00" and e["KHD_TIMEZONE"]=="UTC" and e["KHD_BUS_DAILY_LIMIT"]=="42"'
docker run -d --name "$direct" --network "$net" --ip 172.30.99.20 --read-only --cap-drop ALL --security-opt no-new-privileges --memory 128m --cpus .5 --pids-limit 32 --mount "type=bind,source=$KHD_DATA_DIR,target=/var/lib/khd" --no-healthcheck -e KHD_BUS_ENABLED=1 -e "KHD_BUS_WINDOWS=1:13:00-14:00;6:23:00-01:00" -e KHD_TIMEZONE=Asia/Shanghai -e KHD_BUS_DAILY_LIMIT=42 kindle-home-dashboard:dev --directory /var/lib/khd --enable-household --lan-host 172.30.99.20 --lan-network 172.30.99.0/24 --open-admin >/dev/null
docker run --rm -i --network "$net" --entrypoint python kindle-home-dashboard:dev - <<'PY'
import json,time
from urllib.request import urlopen, Request
from urllib.error import HTTPError
base="http://172.30.99.20:8080"
for _ in range(30):
    try:
        with urlopen(base+"/api/home/view",timeout=3) as r:
            view=json.load(r)
        break
    except OSError:
        time.sleep(1)
else:
    raise RuntimeError("Direct server unavailable")
assert len(view["tasks"])==1
# No trip has been configured; isolated network disallows outside requests.
with urlopen(base+"/api/bus/view",timeout=3) as r:
    assert json.load(r)["snapshot"]["status"]=="unconfigured"
with urlopen(base+"/api/display/auto",timeout=3) as r:
    assert json.load(r)["mode"]=="family"
body=json.dumps({"title":"Fictional direct task","start":view["date"],"repeat":"once"}).encode()
with urlopen(Request(base+"/api/home/task/add",data=body,headers={"Content-Type":"application/json"}),timeout=3) as r:
    assert r.status==200
with urlopen(base+"/api/home/view",timeout=3) as r:
    assert len(json.load(r)["tasks"])==2
try:
    urlopen(Request(base+"/api/home/view",headers={"Origin":"http://example.invalid"}),timeout=3)
except HTTPError as e:
    assert e.code==403
else:
    raise AssertionError("Wrong origin accepted")
print("Docker direct mode PASS: isolated network client, no credentials, private bus startup settings, read/write, origin rejection.")
PY
docker stop -t 35 "$direct" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$direct")" = 0

# Invalid optional bus settings must not interrupt the household service.
docker rm "$direct" >/dev/null
docker run -d --name "$direct" --network "$net" --ip 172.30.99.20 --read-only --cap-drop ALL --security-opt no-new-privileges --memory 128m --cpus .5 --pids-limit 32 --mount "type=bind,source=$KHD_DATA_DIR,target=/var/lib/khd" --no-healthcheck -e KHD_BUS_ENABLED=1 -e KHD_BUS_WINDOWS=invalid-fictional-value -e KHD_TIMEZONE=Asia/Shanghai kindle-home-dashboard:dev --directory /var/lib/khd --enable-household --lan-host 172.30.99.20 --lan-network 172.30.99.0/24 --open-admin >/dev/null
docker run --rm -i --network "$net" --entrypoint python kindle-home-dashboard:dev - <<'PY'
import json,time
from urllib.request import urlopen,Request
from urllib.error import HTTPError
base="http://172.30.99.20:8080"
for _ in range(30):
    try:
        with urlopen(base+"/api/home/view",timeout=3) as r:
            view=json.load(r)
        break
    except OSError:
        time.sleep(1)
else:
    raise RuntimeError("Household unavailable after invalid bus config")
assert len(view["tasks"])==2
with urlopen(base+"/api/bus/view",timeout=3) as r:
    assert json.load(r)["snapshot"]["status"]=="config_error"
with urlopen(base+"/api/display/auto",timeout=3) as r:
    assert json.load(r)["mode"]=="family"
try:
    urlopen(Request(base+"/api/bus/search",data=b'{"keyword":"Example"}',headers={"Content-Type":"application/json"}),timeout=3)
except HTTPError as e:
    assert e.code==503 and json.load(e)["error"]=="bus_config_error"
else:
    raise AssertionError("Invalid config allowed a search")
print("Docker invalid bus configuration PASS: family retained, provider disabled.")
# Recover through the local settings API, without changing the container environment.
body={"enabled":True,"windows":[{"days":[1],"start":780,"end":840}]}
with urlopen(Request(base+"/api/bus/schedule",data=json.dumps(body).encode(),headers={"Content-Type":"application/json"}),timeout=3) as r:
    assert json.load(r)["enabled"] is True
with urlopen(base+"/api/bus/view",timeout=3) as r:
    assert json.load(r)["snapshot"]["status"]=="unconfigured"
PY
docker logs "$direct" 2>&1 | grep -F 'Bus disabled; household remains available: KHD_BUS_WINDOWS: invalid format or time'
if docker logs "$direct" 2>&1 | grep -Fq 'invalid-fictional-value'; then exit 1; fi
docker stop -t 35 "$direct" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$direct")" = 0

# Restart with the same malformed bootstrap window: saved settings take precedence.
docker start "$direct" >/dev/null
docker run --rm -i --network "$net" --entrypoint python kindle-home-dashboard:dev - <<'PY'
import json,time
from urllib.request import urlopen
base="http://172.30.99.20:8080"
for _ in range(30):
    try:
        with urlopen(base+"/api/bus/schedule",timeout=3) as r:
            settings=json.load(r)
        break
    except OSError:
        time.sleep(1)
else:
    raise RuntimeError("Saved schedule unavailable after restart")
assert settings["enabled"] is True and settings["windows"]==[{"days":[1],"start":780,"end":840}]
with urlopen(base+"/api/home/view",timeout=3) as r:
    assert len(json.load(r)["tasks"])==2
with urlopen(base+"/api/bus/view",timeout=3) as r:
    assert json.load(r)["snapshot"]["status"]=="unconfigured"
print("Docker web schedule PASS: saved locally, effective without rebuild, persists after restart.")
PY
docker stop -t 35 "$direct" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$direct")" = 0
