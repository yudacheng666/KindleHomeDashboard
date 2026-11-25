"""Offline route and configuration tests, using only fictional stations."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from dashboard.bus import BusError
from dashboard.routes import Line, Station, Route, search, detail, select, revalidate
from dashboard.trip_store import TripStore, SOURCE


def response(**data):
    return {"errCode": 0, "data": data}


def brief(direction):
    return {"lineId": "fictional", "lineName": "Example line",
            "startStopName": "A", "endStopName": "D", "upDown": direction}


LINE = Line("fictional", "Example line", "0", "A", "D")
ROUTE = Route(LINE, tuple(Station(str(i), n) for i, n in enumerate("ABCD")))


def detail_response(direction="0"):
    names = "ABCD" if direction == "0" else "DXA"
    return response(busLine={"lineId": LINE.line_id, "lineName": LINE.name,
                             "upDown": int(direction),
                             "stop": [{"stopId": n, "stopName": n, "upDown": int(direction)}
                                      for n in names]})


class DiscoveryTests(unittest.TestCase):
    def test_two_directions_same_id_and_deduplicate(self):
        request = Mock(return_value=response(trafficStop=[
            {"stopLineInfo": [brief(0), brief(1)], "lineInfo": brief(0)}
        ]))
        lines = search("Example", request=request)
        self.assertEqual([v.direction for v in lines], ["0", "1"])
        self.assertEqual(request.call_args.args[1]["keywords"], "Example")

    def test_empty_search(self):
        self.assertEqual(search("Example", request=Mock(return_value=response(trafficStop=[]))), ())

    def test_invalid_direction_does_not_become_reverse(self):
        with self.assertRaises(BusError):
            search("Example", request=Mock(return_value=response(trafficStop=[{"lineInfo": brief(2)}])))

    def test_reverse_uses_actual_station_list(self):
        request = Mock(return_value=detail_response("1"))
        route = detail(LINE, "1", request=request)
        self.assertEqual([s.name for s in route.stops], list("DXA"))
        self.assertEqual(request.call_args.args[1]["direction"], "1")
        self.assertEqual(route.line.direction, "1")

    def test_mismatched_direction(self):
        with self.assertRaises(BusError):
            detail(LINE, "1", request=Mock(return_value=detail_response("0")))

    def test_mismatched_route(self):
        p = detail_response()
        p["data"]["busLine"]["lineId"] = "different"
        with self.assertRaises(BusError):
            detail(LINE, request=Mock(return_value=p))

    def test_bad_station_rejected_instead_of_skipped(self):
        p = detail_response()
        p["data"]["busLine"]["stop"][1]["stopId"] = ""
        with self.assertRaises(BusError):
            detail(LINE, request=Mock(return_value=p))

    def test_boarding_and_destination(self):
        trip = select(ROUTE, 1, 3)
        self.assertEqual(trip.stop_count, 2)
        self.assertEqual(trip.eta_stop().stop_id, "1")
        self.assertEqual(trip.destination.name, "D")

    def test_bad_order(self):
        for a, b in ((1, 1), (2, 1), (-1, 2), (0, 4), (True, 3)):
            with self.subTest(a=a, b=b), self.assertRaises(ValueError):
                select(ROUTE, a, b)

    def test_changed_stops_require_reselection(self):
        trip = select(ROUTE, 1, 3)
        changed = Route(LINE, (ROUTE.stops[0], Station("new", "B"), *ROUTE.stops[2:]))
        with self.assertRaises(ValueError):
            revalidate(trip, changed)


class StoreTests(unittest.TestCase):
    def test_save_reload_and_verify(self):
        with TemporaryDirectory() as directory:
            s = TripStore(directory)
            self.assertIsNone(s.load())
            trip = s.save(ROUTE, 1, 3)
            restored = TripStore(directory).restore_verified(ROUTE)
            self.assertEqual(restored, trip)
            self.assertEqual(s.path.stat().st_mode & 0o777, 0o600)

    def test_invalid_update_preserves_old(self):
        with TemporaryDirectory() as directory:
            s = TripStore(directory)
            trip = s.save(ROUTE, 0, 3)
            with self.assertRaises(ValueError):
                s.save(ROUTE, 3, 1)
            self.assertEqual(s.load(), trip)

    def test_atomic_replace_failure(self):
        with TemporaryDirectory() as directory:
            s = TripStore(directory)
            trip = s.save(ROUTE, 0, 3)
            with patch("dashboard.trip_store.os.replace", side_effect=OSError("test")):
                with self.assertRaises(OSError):
                    s.save(ROUTE, 1, 3)
            self.assertEqual(s.load(), trip)
            self.assertEqual(len(list(Path(directory).iterdir())), 1)

    def test_reject_source_tree_and_relative_path(self):
        for p in (SOURCE, Path(".")):
            with self.assertRaises(ValueError):
                TripStore(p)

    def test_corrupt_or_unknown_version(self):
        with TemporaryDirectory() as directory:
            s = TripStore(directory)
            for raw in ("not JSON", json.dumps({"version": 9}), "{}"):
                s.path.write_text(raw)
                with self.assertRaises(ValueError):
                    s.load()

    def test_no_follow_config_symlink(self):
        with TemporaryDirectory() as directory:
            s = TripStore(directory)
            s.path.symlink_to(Path(directory) / "missing")
            with self.assertRaises(ValueError):
                s.load()


if __name__ == "__main__":
    unittest.main()
