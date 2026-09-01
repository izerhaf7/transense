import time
from datetime import date
from types import SimpleNamespace

from backend.gtfs_loader import GtfsFeed
from backend.planner import Itinerary, Leg, Point, RouteInfo
import backend.rail_planner as rail

MONDAY = date(2024, 1, 8)

RAIL_STATIONS = [
    {"id": "r1", "code": "R01", "name": "Stasiun Selatan", "lat": -6.29, "lng": 106.79},
    {"id": "r2", "code": "R02", "name": "Stasiun Tengah", "lat": -6.24, "lng": 106.80},
    {"id": "r3", "code": "R03", "name": "Stasiun Utara", "lat": -6.19, "lng": 106.82},
]


def make_app(stations=None, geometry=True):
    feed = SimpleNamespace(
        lines=[
            SimpleNamespace(operator="MRTJ", code="M", color="AB0000"),
            SimpleNamespace(operator="KCI", code="B", color="1677FF"),
        ],
        stations={},
    )
    app = SimpleNamespace()
    now = time.time()
    app.state = SimpleNamespace(
        commute_feed=feed,
        rail_geometry={"MRTJ:M": [[[106.79, -6.29], [106.80, -6.24], [106.82, -6.19]]]}
        if geometry
        else {},
        gtfs_feed=GtfsFeed(),
        rail_ordered_stations={
            "MRTJ:M": (now, stations if stations is not None else RAIL_STATIONS),
            "KCI:B": (now, []),
            "KCI:C": (now, []),
            "KCI:R": (now, []),
            "KCI:T": (now, []),
            "KCI:TP": (now, []),
            "LRTJ:S": (now, []),
        },
    )
    return app


def _stub_segment(origin_pt, destination_pt):
    """Deterministic single-BUS-leg RAPTOR stub for intermodal merge tests."""
    leg = Leg(
        mode="BUS",
        from_point=Point(destination_pt.get("stop_id"), "Halte", origin_pt["lat"], origin_pt["lng"]),
        to_point=Point(None, "Tujuan", destination_pt["lat"], destination_pt["lng"]),
        duration_minutes=5,
        distance_m=800.0,
        start_time="08:00",
        end_time="08:05",
        route=RouteInfo("R1", "1", "FF0000"),
        headsign="Koridor 1",
        trip_id="T1",
    )
    return [Itinerary((leg,), 0, 200.0, 3, 0, 8)]


def test_plan_rail_standalone_builds_walk_rail_walk():
    result = rail.plan_rail({"lat": -6.245, "lng": 106.805}, {"lat": -6.195, "lng": 106.815}, make_app(), None, "MRTJ", "M")
    assert len(result) == 1
    itinerary = result[0]
    assert [leg["mode"] for leg in itinerary["legs"]] == ["WALK", "RAIL", "WALK"]
    rail_leg = itinerary["legs"][1]
    assert rail_leg["route"] == {"id": "MRTJ:M", "short_name": "MRT", "color": "#AB0000"}
    assert rail_leg["from"]["name"] == "Stasiun Tengah"
    assert rail_leg["to"]["name"] == "Stasiun Utara"
    assert itinerary["transfers"] == 0
    assert itinerary["total_minutes"] > 0


def test_plan_rail_empty_when_origin_far():
    result = rail.plan_rail({"lat": -6.40, "lng": 106.90}, {"lat": -6.195, "lng": 106.815}, make_app(), None, "MRTJ", "M")
    assert result == []


def test_plan_rail_empty_when_same_station():
    result = rail.plan_rail({"lat": -6.241, "lng": 106.801}, {"lat": -6.239, "lng": 106.799}, make_app(), None, "MRTJ", "M")
    assert result == []


def test_plan_rail_empty_without_feed():
    app = make_app()
    app.state.commute_feed = None
    assert rail.plan_rail({"lat": -6.24, "lng": 106.80}, {"lat": -6.19, "lng": 106.82}, app, None, "MRTJ", "M") == []


def test_plan_rail_empty_without_geometry():
    app = make_app(geometry=False)
    assert rail.plan_rail({"lat": -6.24, "lng": 106.80}, {"lat": -6.19, "lng": 106.82}, app, None, "MRTJ", "M") == []


def test_plan_standalone_rail_includes_krl_line():
    app = make_app()
    now = time.time()
    app.state.rail_ordered_stations["KCI:B"] = (now, RAIL_STATIONS)
    app.state.rail_geometry["KCI:B"] = [[[106.79, -6.29], [106.80, -6.24], [106.82, -6.19]]]
    result = rail.plan_standalone_rail({"lat": -6.245, "lng": 106.805}, {"lat": -6.195, "lng": 106.815}, app, None)
    assert len(result) == 2  # MRTJ:M + KCI:B
    short_names = {it["legs"][1]["route"]["short_name"] for it in result}
    assert short_names == {"MRT", "KRL"}


def test_plan_intermodal_chains_bus_rail_bus(monkeypatch):
    app = make_app()
    monkeypatch.setattr(rail, "plan_trip", lambda feed, walk_graph, origin, destination, plan_date, departure_time=None, arrive_by=None, max_itineraries=3: _stub_segment(origin, destination))
    result = rail.plan_intermodal({"lat": -6.245, "lng": 106.805}, {"lat": -6.195, "lng": 106.815}, app, None, MONDAY, "08:00")
    assert len(result) >= 1
    modes = [leg["mode"] for leg in result[0]["legs"]]
    assert modes[0] == "BUS" and modes[-1] == "BUS"
    assert "RAIL" in modes
    rail_leg = next(leg for leg in result[0]["legs"] if leg["mode"] == "RAIL")
    assert rail_leg["route"]["short_name"] == "MRT"


def test_plan_intermodal_empty_without_feed():
    app = make_app()
    app.state.gtfs_feed = None
    result = rail.plan_intermodal({"lat": -6.245, "lng": 106.805}, {"lat": -6.195, "lng": 106.815}, app, None, MONDAY, "08:00")
    assert result == []


def test_plan_intermodal_empty_when_stations_too_far():
    app = make_app()
    result = rail.plan_intermodal({"lat": -6.40, "lng": 106.90}, {"lat": -6.195, "lng": 106.815}, app, None, MONDAY, "08:00")
    assert result == []
