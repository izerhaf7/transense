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


def test_plan_rail_keeps_travel_direction_when_riding_backwards():
    # Origin is near the northern station (idx 2), destination near the
    # southern one (idx 0): the RAIL leg must read origin-side -> destination-side,
    # never be swapped to the line's increasing index order.
    result = rail.plan_rail({"lat": -6.185, "lng": 106.82}, {"lat": -6.295, "lng": 106.79}, make_app(), None, "MRTJ", "M")
    assert len(result) == 1
    rail_leg = result[0]["legs"][1]
    assert rail_leg["mode"] == "RAIL"
    assert rail_leg["from"]["name"] == "Stasiun Utara"
    assert rail_leg["to"]["name"] == "Stasiun Selatan"


def test_plan_rail_with_departure_time_sets_clock_from_timetable(monkeypatch):
    # Terminus timetable: trains leave Stasiun Selatan (idx 0) every 10 min
    # starting 08:00 and run toward Stasiun Utara (idx 2).
    monkeypatch.setattr(
        rail,
        "line_terminus_departures",
        lambda app, operator, stations: ["08:00", "08:10", "08:20"],
    )
    # Origin near Stasiun Tengah (idx 1), destination Stasiun Utara (idx 2);
    # user arrives at the platform at 08:02 -> first train at ~08:10-08:12.
    result = rail.plan_rail(
        {"lat": -6.245, "lng": 106.805},
        {"lat": -6.195, "lng": 106.815},
        make_app(),
        None,
        "MRTJ",
        "M",
        departure_time="08:00",
    )
    assert len(result) == 1
    rail_leg = result[0]["legs"][1]
    assert rail_leg["mode"] == "RAIL"
    assert "start_time" in rail_leg and "end_time" in rail_leg
    assert rail_leg["start_time"] >= "08:02"
    assert result[0]["waiting_minutes"] >= 0


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


def test_plan_standalone_rail_includes_mrt_line():
    app = make_app()
    result = rail.plan_standalone_rail({"lat": -6.245, "lng": 106.805}, {"lat": -6.195, "lng": 106.815}, app, None)
    assert len(result) == 1  # MRTJ:M
    short_names = {it["legs"][1]["route"]["short_name"] for it in result}
    assert short_names == {"MRT"}


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


# ---------------------------------------------------------------------------
# Integration regression guards — added for merge of MRT + Antar Aku
# ---------------------------------------------------------------------------


def test_plan_rail_empty_with_nan_origin_coordinates():
    """NaN coordinates must produce empty result, not crash."""
    result = rail.plan_rail({"lat": float("nan"), "lng": 106.80}, {"lat": -6.19, "lng": 106.82}, make_app(), None, "MRTJ", "M")
    assert result == []


def test_plan_rail_empty_with_nan_destination_coordinates():
    """NaN destination must produce empty result, not crash."""
    result = rail.plan_rail({"lat": -6.24, "lng": 106.80}, {"lat": float("nan"), "lng": float("nan")}, make_app(), None, "MRTJ", "M")
    assert result == []


def test_plan_rail_empty_with_single_station_line():
    """A line with only one station cannot form a rail leg."""
    single = make_app(stations=[{"id": "m1", "code": "M01", "name": "Only Station", "lat": -6.24, "lng": 106.80}])
    result = rail.plan_rail({"lat": -6.24, "lng": 106.80}, {"lat": -6.19, "lng": 106.82}, single, None, "MRTJ", "M")
    assert result == []


def test_plan_rail_leg_contract_keys():
    """Every RAIL leg must carry route.id, short_name, and color."""
    result = rail.plan_rail({"lat": -6.245, "lng": 106.805}, {"lat": -6.195, "lng": 106.815}, make_app(), None, "MRTJ", "M")
    assert len(result) == 1
    rail_leg = result[0]["legs"][1]
    assert rail_leg["mode"] == "RAIL"
    assert rail_leg["route"]["id"] == "MRTJ:M"
    assert rail_leg["route"]["short_name"] == "MRT"
    assert isinstance(rail_leg["route"]["color"], str)
    assert "from" in rail_leg and "to" in rail_leg
    assert rail_leg["distance_m"] >= 0
    assert rail_leg["duration_minutes"] >= 0


def test_plan_intermodal_includes_rail_leg_between_bus_legs(monkeypatch):
    """Intermodal must sandwich a RAIL leg between BUS legs."""
    app = make_app()
    monkeypatch.setattr(
        rail,
        "plan_trip",
        lambda feed, walk_graph, origin, destination, plan_date, departure_time=None, arrive_by=None, max_itineraries=3: _stub_segment(origin, destination),
    )
    result = rail.plan_intermodal(
        {"lat": -6.245, "lng": 106.805},
        {"lat": -6.195, "lng": 106.815},
        app,
        None,
        MONDAY,
        "08:00",
    )
    assert len(result) >= 1
    for it in result:
        modes = [leg["mode"] for leg in it["legs"]]
        assert modes[0] in ("BUS", "WALK")
        assert "RAIL" in modes
        assert modes[-1] in ("BUS", "WALK")
