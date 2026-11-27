"""Three independent driving groups; private configuration, RAM-only snapshots."""
import base64
import copy
from datetime import datetime, timezone
import json
import os
import stat
import tempfile
from threading import Event, RLock, Thread
import time
from zoneinfo import ZoneInfo

from .driving import Amap, DrivingLedger, DrivingError, DrivingBlocked, point
from .runtime import parse_schedule
from .trip_store import TripStore

DEFAULT = {"enabled": False, "consent": False, "map_permission": False,
           "interval": 120, "groups": []}
INTERVALS = (60, 120, 180, 300)
STALE = 240
EXPIRE = 600


def config(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT):
        raise ValueError("invalid_driving_config")
    for key in ("enabled", "consent", "map_permission"):
        if type(value[key]) is not bool:
            raise ValueError("invalid_driving_config")
    if type(value["interval"]) is not int or value["interval"] not in INTERVALS:
        raise ValueError("invalid_driving_interval")
    groups = value["groups"]
    if not isinstance(groups, list) or len(groups)>3:
        raise ValueError("invalid_driving_groups")
    if value["enabled"] and (not value["consent"] or not value["map_permission"] or not groups):
        raise ValueError("driving_consent_required")
    result = []
    for group in groups:
        if not isinstance(group,dict) or set(group)!={"name","origin","destination","enabled","windows"}:
            raise ValueError("invalid_driving_group")
        name=group["name"]
        if not isinstance(name,str) or not 1<=len(name.strip())<=40 or any(ord(c)<32 for c in name):
            raise ValueError("invalid_driving_name")
        origin,destination=point(group["origin"]),point(group["destination"])
        if origin==destination:
            raise ValueError("same_driving_endpoints")
        enabled,windows=parse_schedule({"enabled":group["enabled"],"windows":group["windows"]})
        result.append({"name":name.strip(),"origin":origin,"destination":destination,"enabled":enabled,
                       "windows":[{"days":list(w.days),"start":w.start,"end":w.end} for w in windows]})
    return {**value,"groups":result}


class DrivingService:
    def __init__(self,directory,env,*,clock=lambda: datetime.now(timezone.utc),
                 monotonic=time.monotonic,timezone_name="Asia/Shanghai",transport=None,image_transport=None):
        root=TripStore(directory).path.parent
        self.path=root/"driving-settings.json"
        self.clock,self.monotonic=clock,monotonic
        self.zone=ZoneInfo(timezone_name)
        self.lock=RLock()
        self.stop,self.wake=Event(),Event()
        self.thread=None
        self.settings=config(DEFAULT)
        self.records,self.due,self.failures={},{},{}
        self.generation=0
        self.error=""
        self.ledger,self.provider=None,None
        self.search_busy=False
        self.search_after=0
        try:
            if self.path.exists() or self.path.is_symlink():
                fd=os.open(self.path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
                with os.fdopen(fd,"rb") as f:
                    info=os.fstat(f.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_mode&0o077 or info.st_size>16384:
                        raise ValueError("invalid_settings_storage")
                    self.settings=config(json.loads(f.read(16385)))
                if not (root/"driving-budget.sqlite3").exists():
                    raise ValueError("missing_driving_budget")
            self.ledger=DrivingLedger(str(root),clock)
        except Exception:
            self.error="storage_error"
            return
        try:
            key=env.get("KHD_AMAP_KEY","")
            if key:
                options={}
                if transport is not None: options["transport"]=transport
                if image_transport is not None: options["image_transport"]=image_transport
                self.provider=Amap(key,self.ledger,**options)
        except ValueError:
            self.error="credential_error"

    def settings_view(self):
        with self.lock:
            usage=self.ledger.usage() if self.ledger else None
            return {**copy.deepcopy(self.settings),"configured":self.provider is not None,
                    "budget":usage,"error":self.error}

    def configure(self,value):
        value=config(value)
        with self.lock:
            if not self.ledger or self.error=="storage_error":
                raise ValueError("driving_storage_unavailable")
            if value==self.settings:
                return self.settings_view()
            fd,temp=tempfile.mkstemp(prefix=".driving-",dir=self.path.parent)
            try:
                with os.fdopen(fd,"w",encoding="utf-8") as out:
                    json.dump(value,out,ensure_ascii=False)
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(temp,self.path)
                directory=os.open(self.path.parent,os.O_RDONLY|os.O_DIRECTORY)
                try: os.fsync(directory)
                finally: os.close(directory)
            finally:
                if os.path.exists(temp): os.unlink(temp)
            self.settings=value
            self.generation+=1
            self.records.clear()
            self.due.clear()
            self.failures.clear()
            self.wake.set()
            return self.settings_view()

    def search_locations(self,body):
        if not isinstance(body,dict) or set(body)!={"keyword","region","consent"} or body["consent"] is not True:
            raise ValueError("driving_search_consent_required")
        with self.lock:
            if not self.provider or self.stop.is_set():
                return {"status":"not_configured","locations":[]}
            if self.search_busy or self.monotonic()<self.search_after:
                return {"status":"wait","locations":[]}
            self.search_busy=True
        try:
            return {"status":"ok","locations":self.provider.search(body["keyword"],body["region"])}
        except DrivingBlocked:
            return {"status":"blocked","locations":[]}
        except DrivingError as exc:
            return {"status":str(exc) if str(exc) in ("search_permission_required","request_limit") else "unavailable","locations":[]}
        finally:
            with self.lock:
                self.search_after=self.monotonic()+3
                self.search_busy=False

    def _active(self,group):
        if not self.settings["enabled"] or not self.settings["consent"] or not self.settings["map_permission"]:
            return False
        enabled,windows=parse_schedule({"enabled":group["enabled"],"windows":group["windows"]})
        local=self.clock().astimezone(self.zone)
        return enabled and any(w.contains(local) for w in windows)

    def step(self):
        with self.lock:
            if self.stop.is_set() or not self.provider or not self.ledger:
                return
            if self.ledger.usage()["blocked"]:
                return
            groups=self.settings["groups"]
            now=self.monotonic()
            for i,record in list(self.records.items()):
                if now-record["mono"]>EXPIRE or not self._active(groups[i]):
                    self.records.pop(i,None)
            pending=[i for i,g in enumerate(groups) if self._active(g) and now>=self.due.get(i,0)]
            if not pending:
                return
            i=min(pending,key=lambda j:self.due.get(j,0))
            group=groups[i]
            generation=self.generation
            self.due[i]=now+self.settings["interval"]
        try:
            routes=self.provider.routes(group["origin"],group["destination"])
            stamp=self.clock().astimezone(self.zone).isoformat()
            fetched=self.monotonic()
        except Exception:
            with self.lock:
                if generation==self.generation:
                    count=self.failures.get(i,0)+1
                    self.failures[i]=count
                    self.due[i]=self.monotonic()+min(1800,self.settings["interval"]*2**min(count,4))
            return
        image=None
        map_routes=[]
        map_error=None
        with self.lock:
            if generation!=self.generation or self.stop.is_set() or not self._active(group):
                return
        try:
            mime,raw,indices=self.provider.map(group["origin"],group["destination"],routes)
            map_routes=list(indices)
            image="data:"+mime+";base64,"+base64.b64encode(raw).decode("ascii")
        except DrivingError as exc:
            # Fixed categories only; never expose URLs, keys or coordinates.
            category=str(exc)
            map_error=category if category in ("map_url_too_long","map_geometry_unavailable","map_http_error","map_unavailable","map_too_large","invalid_map","provider_rejected_request","provider_blocked","request_limit") else "map_unavailable"
        except Exception:
            map_error="map_unavailable"
        with self.lock:
            if generation==self.generation and not self.stop.is_set() and self._active(group):
                self.records[i]={"routes":[r.view() for r in routes],"image":image,
                                 "map_routes":map_routes,"map_error":map_error,
                                 "fetched_at":stamp,"mono":fetched}
                self.failures.pop(i,None)

    def read(self):
        with self.lock:
            now=self.monotonic()
            usage=self.ledger.usage() if self.ledger else None
            rows=[]
            for i,group in enumerate(self.settings["groups"]):
                record=self.records.get(i)
                active=self._active(group)
                age=now-record["mono"] if record else EXPIRE+1
                if not active or age<0 or age>EXPIRE:
                    self.records.pop(i,None)
                    record=None
                if not self.settings["enabled"] or not group["enabled"]: status="disabled"
                elif self.error: status=self.error
                elif not self.provider: status="not_configured"
                elif not active: status="paused"
                elif usage and usage["blocked"]: status="blocked"
                elif not record: status="unavailable" if i in self.failures else "waiting"
                elif age>STALE or i in self.failures: status="stale"
                else: status="ok"
                rows.append({"name":group["name"],"status":status,
                             "routes":record["routes"] if record else [],
                             "image":record["image"] if record else None,
                             "map_routes":record["map_routes"] if record else [],
                             "map_error":record["map_error"] if record else None,
                             "fetched_at":record["fetched_at"] if record else None})
            return {"enabled":self.settings["enabled"],"groups":copy.deepcopy(rows),"source":"高德地图"}

    def _loop(self):
        while not self.stop.is_set():
            try: self.step()
            except Exception:
                with self.lock:
                    self.error="storage_error"
                    self.records.clear()
                return
            self.wake.wait(2)
            self.wake.clear()

    def start(self):
        if self.thread is not None or self.stop.is_set():
            raise RuntimeError("driving_already_started")
        self.thread=Thread(target=self._loop,name="driving-scheduler",daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        self.wake.set()
        if self.thread is not None:
            self.thread.join(timeout=15)
            if self.thread.is_alive():
                raise RuntimeError("driving_scheduler_not_stopped")
