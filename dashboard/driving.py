"""AMap driving adapter. No network or private storage on import."""
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import os
import re
import sqlite3
from threading import Lock
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, build_opener, ProxyHandler

from .trip_store import TripStore
from .weather import NoRedirect, get_json, WeatherError, WeatherBlocked

LIMITS = {"lbs": 30000, "search": 1000}
BASE = "https://restapi.amap.com"
STYLES = ((7, "0x000000"), (5, "0x666666"), (3, "0x999999"))
MAX_IMAGE = 2 * 1024 * 1024
BILLING_ZONE = timezone(timedelta(hours=8))


class DrivingError(Exception):
    """Only fixed error categories are exposed."""


class DrivingBlocked(DrivingError):
    pass


class DrivingLedger:
    """Independent durable, rolling 32-day request caps; count failures too."""
    def __init__(self, directory, clock=lambda: datetime.now(timezone.utc)):
        self.path = TripStore(directory).path.parent / "driving-budget.sqlite3"
        self.clock = clock
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            if self.path.is_symlink() or not self.path.is_file() or self.path.stat().st_mode & 0o077:
                raise DrivingError("invalid_budget_storage")
            with closing(self._connect()) as db:
                db.execute("SELECT day,kind,used FROM request_days LIMIT 1")
                if db.execute("SELECT last_day,blocked FROM state WHERE id=1").fetchone() is None:
                    raise DrivingError("invalid_budget_storage")
        else:
            os.close(fd)
            with closing(self._connect()) as db, db:
                db.execute("CREATE TABLE request_days(day TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('lbs','search')),used INTEGER NOT NULL CHECK(used BETWEEN 0 AND 30000),PRIMARY KEY(day,kind))")
                db.execute("CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1),last_day TEXT NOT NULL,blocked INTEGER NOT NULL CHECK(blocked IN (0,1)))")
                db.execute("INSERT INTO state VALUES(1,'',0)")

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=3)
        db.execute("PRAGMA synchronous=FULL")
        return db

    def _day(self):
        now = self.clock()
        if now.tzinfo is None:
            raise DrivingError("invalid_clock")
        return now.astimezone(BILLING_ZONE).date()

    def reserve(self, kind):
        if kind not in LIMITS:
            raise DrivingError("invalid_request_kind")
        day = self._day()
        today = day.isoformat()
        oldest = (day - timedelta(days=31)).isoformat()
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            last, blocked = db.execute("SELECT last_day,blocked FROM state WHERE id=1").fetchone()
            if blocked:
                raise DrivingBlocked("provider_blocked")
            if last > today:
                raise DrivingError("clock_reversed")
            used = db.execute("SELECT COALESCE(SUM(used),0) FROM request_days WHERE kind=? AND day>=?", (kind, oldest)).fetchone()[0]
            if used >= LIMITS[kind]:
                raise DrivingError("request_limit")
            db.execute("INSERT INTO request_days VALUES(?,?,1) ON CONFLICT(day,kind) DO UPDATE SET used=used+1", (today,kind))
            db.execute("UPDATE state SET last_day=? WHERE id=1", (today,))
            db.execute("DELETE FROM request_days WHERE day<?", (oldest,))

    def block(self):
        with closing(self._connect()) as db, db:
            db.execute("UPDATE state SET blocked=1 WHERE id=1")

    def usage(self):
        oldest = (self._day() - timedelta(days=31)).isoformat()
        with closing(self._connect()) as db:
            used = dict(db.execute("SELECT kind,SUM(used) FROM request_days WHERE day>=? GROUP BY kind", (oldest,)))
            blocked = db.execute("SELECT blocked FROM state WHERE id=1").fetchone()[0]
        return {"blocked": bool(blocked), **{k: {"used": used.get(k,0), "limit": v} for k,v in LIMITS.items()}}


def point(value):
    if not isinstance(value, str) or not re.fullmatch(r"-?\d{1,3}(?:\.\d{1,6})?,-?\d{1,2}(?:\.\d{1,6})?", value):
        raise ValueError("invalid_driving_coordinates")
    lon, lat = map(float, value.split(","))
    if not -180 <= lon <= 180 or not -90 <= lat <= 90:
        raise ValueError("invalid_driving_coordinates")
    return f"{lon:.6f},{lat:.6f}"


def integer(value, minimum=0, maximum=10000000):
    if type(value) is int:
        result = value
    elif isinstance(value, str) and re.fullmatch(r"[0-9]{1,8}",value):
        result = int(value)
    else:
        raise DrivingError("invalid_response")
    if not minimum <= result <= maximum:
        raise DrivingError("invalid_response")
    return result


def clean_text(value, limit=160):
    return value.strip()[:limit] if isinstance(value,str) else ""


@dataclass(frozen=True)
class Route:
    seconds: int
    meters: int
    points: tuple[str, ...]
    congested_meters: int | None
    traffic_covered_meters: int
    color: str = ""
    width: int = 0

    def view(self):
        return {"seconds": self.seconds, "meters": self.meters,
                "congested_meters": self.congested_meters,
                "traffic_covered_meters": self.traffic_covered_meters,
                "color": self.color, "width": self.width}


def normalize_routes(raw):
    """Rank only actual returned routes; omit geometry rather than invent it."""
    try:
        paths = raw["route"]["paths"]
        if not isinstance(paths,list) or not 1 <= len(paths) <= 20:
            raise DrivingError("no_routes")
        candidates = []
        for path in paths:
            seconds = integer(path["cost"]["duration"],1)
            meters = integer(path["distance"],1)
            steps = path.get("steps",[])
            if not isinstance(steps,list) or len(steps)>2000:
                raise DrivingError("invalid_response")
            points = []
            geometry_valid = bool(steps)
            covered = congested = 0
            for step in steps:
                polyline = step.get("polyline")
                if isinstance(polyline,str) and polyline and geometry_valid:
                    try:
                        for raw_point in polyline.split(";"):
                            p = point(raw_point)
                            if not points or points[-1] != p:
                                points.append(p)
                            if len(points)>20000:
                                raise ValueError("geometry_too_large")
                    except ValueError:
                        geometry_valid = False
                        points = []
                else:
                    geometry_valid = False
                    points = []
                tmcs = step.get("tmcs",[])
                if isinstance(tmcs,list):
                    for tmc in tmcs:
                        if not isinstance(tmc,dict):
                            continue
                        state = tmc.get("tmc_status")
                        if state not in ("畅通","缓行","拥堵","严重拥堵"):
                            continue
                        try:
                            distance = integer(tmc.get("tmc_distance"))
                        except DrivingError:
                            continue
                        covered += distance
                        if state in ("拥堵","严重拥堵"):
                            congested += distance
            # Segment lengths can be rounded differently; do not present
            # impossible coverage or turn unknown road conditions into clear roads.
            if covered > meters * 1.05:
                covered = congested = 0
            covered = min(covered,meters)
            congested = min(congested,covered)
            geometry = tuple(points) if geometry_valid and len(points)>=2 else ()
            candidates.append(Route(seconds,meters,geometry,congested if covered else None,covered))
        candidates.sort(key=lambda x:x.seconds)
        result = []
        seen = set()
        for candidate in candidates:
            if candidate.points and candidate.points in seen:
                continue
            if candidate.points:
                seen.add(candidate.points)
            width,color = STYLES[len(result)]
            result.append(Route(candidate.seconds,candidate.meters,candidate.points,
                                candidate.congested_meters,candidate.traffic_covered_meters,color,width))
            if len(result)==3:
                break
        return tuple(result)
    except (KeyError, TypeError, AttributeError, ValueError, RecursionError):
        raise DrivingError("invalid_response") from None


def map_parameters(origin,destination,routes):
    if not 1<=len(routes)<=3 or any(not x.points for x in routes):
        raise DrivingError("map_geometry_unavailable")
    # Back-to-front: the fastest route remains visible on shared segments.
    paths = "|".join(f"{x.width},{x.color},1,,:{';'.join(x.points)}" for x in reversed(routes))
    # Number labels are placed on actual route points. Prefer a point unique
    # to this route; the list also carries matching line color and width.
    labels = []
    for i,route in enumerate(routes):
        others = {p for j,r in enumerate(routes) if j!=i for p in r.points}
        unique = [p for p in route.points if p not in others]
        if unique:
            labels.append(f"{i+1},0,1,16,0xFFFFFF,{route.color}:{unique[len(unique)//2]}")
    params = {"size":"600*200","scale":"1","traffic":"0","paths":paths,
              "markers":f"mid,0x000000,S:{point(origin)}|mid,0x000000,E:{point(destination)}"}
    if labels:
        params["labels"]="|".join(labels)
    return params


def check_status(raw, kind="lbs"):
    if not isinstance(raw,dict):
        raise DrivingError("invalid_response")
    if str(raw.get("status"))=="1" and str(raw.get("infocode"))=="10000":
        return raw
    if kind == "search" and str(raw.get("infocode")) == "10012":
        raise DrivingError("search_permission_required")
    # All provider rejections other than explicit malformed/empty request
    # are treated conservatively as access/quota blockers, not retried.
    if str(raw.get("infocode")) in ("20000","20001","20002","20003","20800","20801","20802","20803"):
        raise DrivingError("provider_rejected_request")
    raise DrivingBlocked("provider_blocked")


def image_request(url):
    try:
        opener = build_opener(ProxyHandler({}),NoRedirect())
        with opener.open(Request(url,headers={"Accept":"image/png,image/jpeg,application/json","User-Agent":"KindleHomeDashboard/1"}),timeout=5) as response:
            raw = response.read(MAX_IMAGE+1)
            mime = response.headers.get_content_type()
        if len(raw)>MAX_IMAGE:
            raise DrivingError("map_too_large")
        if mime=="image/png" and raw.startswith(b"\x89PNG\r\n\x1a\n"):
            return mime,raw
        if mime=="image/jpeg" and raw.startswith(b"\xff\xd8") and raw.endswith(b"\xff\xd9"):
            return mime,raw
        if mime=="application/json":
            check_status(json.loads(raw))
        raise DrivingError("invalid_map")
    except HTTPError as exc:
        if exc.code in (401,402,403,429):
            raise DrivingBlocked("provider_blocked") from None
        raise DrivingError("map_http_error") from None
    except DrivingError:
        raise
    except Exception:
        raise DrivingError("map_unavailable") from None


class Amap:
    """Only fixed HTTPS vendor endpoints, one shared sequential request gate."""
    def __init__(self,key,ledger,transport=get_json,image_transport=image_request,
                 monotonic=time.monotonic,sleep=time.sleep):
        if not isinstance(key,str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}",key):
            raise ValueError("invalid_driving_credential")
        self.key,self.ledger=key,ledger
        self.transport,self.image_transport=transport,image_transport
        self.monotonic,self.sleep=monotonic,sleep
        self.lock=Lock()
        self.next_request=0

    def _call(self,path,params,kind,image=False):
        url=BASE+path+"?"+urlencode({**params,"key":self.key})
        if len(url)>65536:
            raise DrivingError("map_url_too_long")
        with self.lock:
            wait=self.next_request-self.monotonic()
            if wait>0:
                self.sleep(wait)
            self.ledger.reserve(kind)
            try:
                if image:
                    return self.image_transport(url)
                return check_status(self.transport(url,{}), kind)
            except (DrivingBlocked,WeatherBlocked):
                self.ledger.block()
                raise DrivingBlocked("provider_blocked") from None
            except WeatherError:
                raise DrivingError("provider_unavailable") from None
            finally:
                self.next_request=self.monotonic()+0.5

    def routes(self,origin,destination):
        raw=self._call("/v5/direction/driving",{"origin":point(origin),"destination":point(destination),
                       "strategy":32,"show_fields":"cost,polyline,tmcs"},"lbs")
        return normalize_routes(raw)

    def map(self,origin,destination,routes):
        return self._call("/v3/staticmap",map_parameters(origin,destination,routes),"lbs",True)

    def search(self,keyword,region=""):
        if not isinstance(keyword,str) or not 1<=len(keyword.strip())<=80 or not isinstance(region,str) or len(region)>80:
            raise ValueError("invalid_driving_search")
        params={"keywords":keyword.strip(),"page_size":10}
        if region.strip():
            params.update(region=region.strip(),city_limit="true")
        raw=self._call("/v5/place/text",params,"search")
        if not isinstance(raw.get("pois"),list):
            raise DrivingError("invalid_response")
        results=[]
        for poi in raw["pois"][:10]:
            if not isinstance(poi,dict):
                continue
            try:
                name=clean_text(poi.get("name"))
                location=point(poi.get("location"))
                if name:
                    results.append({"name":name,"location":location,"address":clean_text(poi.get("address")),
                                    "city":clean_text(poi.get("cityname")),"district":clean_text(poi.get("adname"))})
            except ValueError:
                continue
        return results
