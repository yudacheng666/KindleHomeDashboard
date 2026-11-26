"""Route discovery and local trip selection; no networking until explicitly called."""
from dataclasses import dataclass
import re
import unicodedata

from .bus import BusError, Stop, post


def _text(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise ValueError("Invalid route field")
    return value.strip()


def _direction(value):
    if type(value) is int:
        value = str(value)
    if value not in ("0", "1"):
        raise ValueError("Unknown direction")
    return value


@dataclass(frozen=True)
class Line:
    line_id: str
    name: str
    direction: str
    first: str
    last: str
    city_code: str = "310100"

    def __post_init__(self):
        for v in (self.line_id, self.name, self.first, self.last):
            _text(v)
        if self.direction not in ("0", "1") or not isinstance(self.city_code, str) or not re.fullmatch(r"[0-9]{6}", self.city_code):
            raise ValueError("Invalid route metadata")


@dataclass(frozen=True)
class Station:
    stop_id: str
    name: str

    def __post_init__(self):
        _text(self.stop_id)
        _text(self.name)


@dataclass(frozen=True)
class Route:
    line: Line
    stops: tuple[Station, ...]


@dataclass(frozen=True)
class Trip:
    line: Line
    boarding: Station
    destination: Station
    board_index: int
    destination_index: int

    def __post_init__(self):
        if (type(self.board_index) is not int or type(self.destination_index) is not int
                or not 0 <= self.board_index < self.destination_index < 1000):
            raise ValueError("Invalid station order")

    @property
    def stop_count(self):
        return self.destination_index - self.board_index

    def eta_stop(self):
        return Stop(self.line.name, self.boarding.name, self.boarding.stop_id,
                    self.line.direction, self.line.city_code)


class DirectionUnavailable(BusError):
    """The provider did not confirm the requested direction."""


def normalize_keyword(keyword):
    keyword = _text(keyword)
    if len(keyword) > 80:
        raise ValueError("Search term too long")
    keyword = re.sub(r"\s+", "", unicodedata.normalize("NFKC", keyword))
    if not keyword or len(keyword) > 80:
        raise ValueError("Invalid search term")
    return keyword


def search_keyword(keyword, broad=False):
    keyword = normalize_keyword(keyword)
    if broad:
        # One explicit broader request, never automatic retry or pagination.
        digits = re.search(r"[0-9]+", keyword)
        if digits:
            return digits.group()
    # A common shorthand omits the 路 character before a letter suffix.
    return re.sub(r"([0-9]+)([A-Za-z]+)(线?)$", r"\1路\2\3", keyword)


def search(keyword: str, city_code="310100", *, request=post, broad=False) -> tuple[Line, ...]:
    keyword = search_keyword(keyword, broad)
    payload = request("/traffic/v2/querytrafficline",
                      {"keywords": keyword, "type": 0, "pageNo": 1, "pageSize": 20},
                      city_code)
    items = payload["data"].get("trafficStop")
    if not isinstance(items, list):
        raise BusError("Missing search result list")
    found = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        rows = item.get("stopLineInfo")
        rows = rows if isinstance(rows, list) else []
        for row in [*rows, item.get("lineInfo")]:
            if not isinstance(row, dict):
                continue
            try:
                line = Line(_text(row.get("lineId")), _text(row.get("lineName")),
                            _direction(row.get("upDown")), _text(row.get("startStopName")),
                            _text(row.get("endStopName")), city_code)
            except ValueError:
                continue
            # Same route ID may represent both directions; do not collapse them.
            found.setdefault((line.line_id, line.direction), line)
    if items and not found:
        raise BusError("No recognizable route results")
    return tuple(found.values())


def detail(line: Line, direction=None, *, request=post) -> Route:
    direction = line.direction if direction is None else _direction(direction)
    payload = request("/traffic/v1/querybusline",
                      {"lineId": line.line_id, "lineName": line.name, "direction": direction},
                      line.city_code)
    row = payload["data"].get("busLine")
    try:
        if not isinstance(row, dict) or row.get("lineId") != line.line_id:
            raise ValueError("Route mismatch")
        if _direction(row.get("upDown")) != direction:
            raise DirectionUnavailable("Requested direction not confirmed")
        if _text(row.get("lineName")) != line.name:
            raise ValueError("Route name mismatch")
        raw = row.get("stop")
        if not isinstance(raw, list) or not 2 <= len(raw) <= 1000:
            raise ValueError("Invalid stop list")
        stops = []
        for item in raw:
            if not isinstance(item, dict):
                raise ValueError("Invalid stop")
            # Do not reverse an outbound list to invent an inbound route.
            if item.get("upDown") is not None and _direction(item["upDown"]) != direction:
                raise DirectionUnavailable("Requested stop direction not confirmed")
            stops.append(Station(_text(item.get("stopId")), _text(item.get("stopName"))))
        verified = Line(line.line_id, line.name, direction, stops[0].name,
                        stops[-1].name, line.city_code)
        return Route(verified, tuple(stops))
    except ValueError:
        raise BusError("Unverified route or direction") from None


def select(route: Route, boarding: int, destination: int) -> Trip:
    if (type(boarding) is not int or type(destination) is not int
            or not 0 <= boarding < destination < len(route.stops)):
        raise ValueError("Choose a destination after the boarding station")
    return Trip(route.line, route.stops[boarding], route.stops[destination],
                boarding, destination)


def revalidate(trip: Trip, route: Route) -> Trip:
    """After restart or route change, require matching IDs and sequence."""
    if (trip.line.line_id, trip.line.direction, trip.line.city_code) != (
            route.line.line_id, route.line.direction, route.line.city_code):
        raise ValueError("Saved route no longer matches")
    current = select(route, trip.board_index, trip.destination_index)
    if (current.boarding, current.destination) != (trip.boarding, trip.destination):
        raise ValueError("Saved station order has changed; select again")
    return current
