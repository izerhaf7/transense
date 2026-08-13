"""API tests for ``GET /api/journey/plan`` (backend/main.py).

The synthetic feed is the same deterministic TransJakarta-like network used by
``test_planner.py`` (a weekday ``WD`` and weekend ``WE`` service), built
directly — no network, no zip.  Tests inject the feed and walk graph onto
``app.state`` after the lifespan has run (lifespan resets both to ``None`` at
startup), then hit the endpoint.
"""

import datetime

from fastapi.testclient import TestClient

from backend.config import Settings
from backend.gtfs_loader import GtfsCalendar, GtfsFeed, GtfsRoute, GtfsStop, GtfsStopTime, GtfsTrip
from backend.main import create_app
from backend.walk_graph import walk_graph_from_feed

MONDAY = "2024-01-08"  # a Monday; the WD service runs

# A GTFS url/cache that always fails so the lifespan leaves the feed (and the
# walk graph) unset regardless of local ``backend/gtfs_cache.zip``.  The discard
# port refuses instantly, no network needed.
_BROKEN_GTFS_URL = "http://127.0.0.1:9/nonexistent.zip"


def _st(trip_id: str, stop_id: str, seq: int, time: str) -> GtfsStopTime:
    """One stop_time row with identical arrival/departure (the demo norm)."""
    return GtfsStopTime(trip_id=trip_id, stop_id=stop_id, stop_sequence=seq,
                        arrival_time=time, departure_time=time)


def synthetic_feed() -> GtfsFeed:
    """Deterministic synthetic feed (same shape as test_planner's):
    - s1..s5 form a corridor; s6 is disconnected (no trips).
    - s7 sits within walk radius of s1 only.
    - R1/R2 chain s1->s3->s5 with a transfer at s3; R3/R4 are direct
      s1->s5 alternatives; R5 only runs on weekends (WE).
    """
    stops = {
        "s1": GtfsStop("s1", "Halte Bundaran", -6.2000, 106.8000),
        "s2": GtfsStop("s2", "Halte Karet", -6.2000, 106.8100),
        "s3": GtfsStop("s3", "Halte Sudirman", -6.2100, 106.8100),
        "s4": GtfsStop("s4", "Halte Semanggi", -6.2100, 106.8200),
        "s5": GtfsStop("s5", "Halte Gatot", -6.2000, 106.8200),
        "s6": GtfsStop("s6", "Halte Senayan", -6.2400, 106.8200),
        "s7": GtfsStop("s7", "Halte Sarinah", -6.1950, 106.7950),
    }
    routes = {
        "R1": GtfsRoute("R1", "1", "Koridor 1", "3", "009F3C", "FFFFFF"),
        "R2": GtfsRoute("R2", "2", "Koridor 2", "3", "00A3E0", "FFFFFF"),
        "R3": GtfsRoute("R3", "3", "Koridor 3", "3", "FFC400", "000000"),
        "R4": GtfsRoute("R4", "4", "Koridor 4", "3", "E30613", "FFFFFF"),
        "R5": GtfsRoute("R5", "5", "Koridor 5", "3", "8A2BE2", "FFFFFF"),
    }
    trips = {
        "T1": GtfsTrip("T1", "R1", None, 0, "Halte Sudirman", "WD"),
        "T2": GtfsTrip("T2", "R2", None, 0, "Halte Gatot", "WD"),
        "T3": GtfsTrip("T3", "R3", None, 0, "Halte Gatot", "WD"),
        "T4": GtfsTrip("T4", "R4", None, 0, "Halte Gatot", "WD"),
        "T5": GtfsTrip("T5", "R5", None, 0, "Halte Sudirman", "WE"),
    }
    stop_times = {
        "T1": [_st("T1", "s1", 1, "08:00:00"), _st("T1", "s2", 2, "08:10:00"), _st("T1", "s3", 3, "08:20:00")],
        "T2": [_st("T2", "s3", 1, "08:30:00"), _st("T2", "s4", 2, "08:40:00"), _st("T2", "s5", 3, "08:50:00")],
        "T3": [_st("T3", "s1", 1, "08:05:00"), _st("T3", "s4", 2, "08:35:00"), _st("T3", "s5", 3, "08:45:00")],
        "T4": [_st("T4", "s1", 1, "08:00:00"), _st("T4", "s3", 2, "08:25:00"),
               _st("T4", "s4", 3, "08:40:00"), _st("T4", "s5", 4, "09:10:00")],
        "T5": [_st("T5", "s1", 1, "09:00:00"), _st("T5", "s2", 2, "09:10:00"), _st("T5", "s3", 3, "09:20:00")],
    }
    calendar = {
        "WD": GtfsCalendar("WD", {0, 1, 2, 3, 4}, "20240101", "20241231"),
        "WE": GtfsCalendar("WE", {5, 6}, "20240101", "20241231"),
    }
    return GtfsFeed(
        stops=stops,
        routes=routes,
        trips=trips,
        stop_times=stop_times,
        calendar=calendar,
    )


def app_for(tmp_path, origins: tuple[str, ...] = ("http://localhost:5173",)):
    return create_app(Settings("test", origins, tmp_path / "demo.sqlite3"))


def plan_app(tmp_path, origins: tuple[str, ...] = ("http://localhost:5173",)):
    """App whose lifespan never loads a real feed (broken GTFS settings)."""
    return create_app(
        Settings(
            "test",
            origins,
            tmp_path / "demo.sqlite3",
            gtfs_url=_BROKEN_GTFS_URL,
            gtfs_cache_path=str(tmp_path / "missing.zip"),
        )
    )


def _inject_feed(app, feed) -> None:
    """Mount a GTFS feed on the running app (walk graph left as-is)."""
    app.state.gtfs_feed = feed


def _inject_plan_data(app, feed) -> None:
    """Mount a feed and its 1 km walk graph on the running app."""
    app.state.gtfs_feed = feed
    app.state.walk_graph = walk_graph_from_feed(feed, radius_km=1.0)


def _assert_numeric(value) -> None:
    assert isinstance(value, (int, float)), f"expected a number, got {value!r}"


# ---------------------------------------------------------------------------
# happy path
# ---------------------------------------------------------------------------


def test_plan_happy_path_stop_ids(tmp_path):
    app = plan_app(tmp_path)
    with TestClient(app) as client:
        _inject_plan_data(app, synthetic_feed())
        response = client.get(
            "/api/journey/plan",
            params={"from_stop": "s1", "to_stop": "s2", "date": MONDAY, "time": "08:00"},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "gtfs"
    assert body["itineraries"], "expected at least one itinerary"

    itinerary = body["itineraries"][0]
    assert itinerary["legs"], "itinerary must have legs"
    for key in ("transfers", "walk_distance_m", "walk_minutes", "waiting_minutes", "total_minutes"):
        assert key in itinerary, f"missing itinerary field {key}"
        _assert_numeric(itinerary[key])

    leg = itinerary["legs"][0]
    assert leg["mode"] == "BUS"
    for key in ("mode", "from", "to", "duration_minutes", "distance_m"):
        assert key in leg, f"missing leg field {key}"
    for point_key in ("name", "lat", "lng"):
        assert point_key in leg["from"], f"missing point field {point_key}"
        assert point_key in leg["to"], f"missing point field {point_key}"
    assert isinstance(leg["from"]["stop_id"], str)
    assert isinstance(leg["to"]["stop_id"], str)
    _assert_numeric(leg["duration_minutes"])
    _assert_numeric(leg["distance_m"])
    # BUS legs carry route/headsign/trip_id per the frontend contract.
    assert leg["route"] == {"id": "R1", "short_name": "1", "color": "009F3C"}
    assert leg["headsign"] == "Halte Sudirman"
    assert leg["trip_id"] == "T1"
    assert itinerary["total_minutes"] == 10
    assert itinerary["transfers"] == 0


def test_plan_coordinate_origin_destination(tmp_path):
    app = plan_app(tmp_path)
    with TestClient(app) as client:
        _inject_plan_data(app, synthetic_feed())
        response = client.get(
            "/api/journey/plan",
            params={
                "from_lat": -6.1985, "from_lng": 106.8010,  # snaps to s1
                "to_lat": -6.1985, "to_lng": 106.8090,      # snaps to s2
                "date": MONDAY, "time": "07:50",
            },
        )
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "gtfs"
    assert body["itineraries"]
    legs = body["itineraries"][0]["legs"]
    assert [leg["mode"] for leg in legs] == ["WALK", "BUS", "WALK"]
    # ``stop_id`` is an optional contract key and is omitted for raw coordinates.
    assert legs[0]["from"].get("stop_id") is None and legs[0]["from"]["name"] == "Lokasi Anda"
    assert legs[-1]["to"].get("stop_id") is None and legs[-1]["to"]["name"] == "Lokasi Anda"
    assert "route" not in legs[0] and "trip_id" not in legs[0]
    assert legs[1]["route"]["id"] == "R1"


# ---------------------------------------------------------------------------
# no route
# ---------------------------------------------------------------------------


def test_plan_no_route_keeps_gtfs_source(tmp_path):
    app = plan_app(tmp_path)
    with TestClient(app) as client:
        _inject_plan_data(app, synthetic_feed())
        # s6 is served by no trip and is out of walk range from every stop.
        response = client.get(
            "/api/journey/plan",
            params={"from_stop": "s1", "to_stop": "s6", "date": MONDAY, "time": "08:00"},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["itineraries"] == []
    assert body["source"] == "gtfs"
    assert "incidents" in body


# ---------------------------------------------------------------------------
# degradation
# ---------------------------------------------------------------------------


def test_plan_unavailable_when_feed_not_loaded(tmp_path):
    # Fresh app: the lifespan GTFS download fails offline, so both the feed
    # and the walk graph stay None.
    app = plan_app(tmp_path)
    with TestClient(app) as client:
        response = client.get("/api/journey/plan", params={"from_stop": "s1", "to_stop": "s2"})
    assert response.status_code == 200
    assert response.json() == {"itineraries": [], "source": "unavailable", "incidents": []}


def test_plan_unavailable_when_walk_graph_missing(tmp_path):
    # Feed loaded but walk graph missing -> spec says unavailable (never a
    # haversine fallback at the endpoint layer).
    app = plan_app(tmp_path)
    with TestClient(app) as client:
        _inject_feed(app, synthetic_feed())
        response = client.get("/api/journey/plan", params={"from_stop": "s1", "to_stop": "s2"})
    assert response.status_code == 200
    assert response.json() == {"itineraries": [], "source": "unavailable", "incidents": []}


# ---------------------------------------------------------------------------
# bad params
# ---------------------------------------------------------------------------


def test_plan_missing_destination_returns_422(tmp_path):
    app = plan_app(tmp_path)
    with TestClient(app) as client:
        _inject_plan_data(app, synthetic_feed())
        response = client.get("/api/journey/plan", params={"from_stop": "s1"})
    assert response.status_code == 422
    assert "destination" in response.json()["detail"]


def test_plan_partial_coordinates_returns_422(tmp_path):
    # from_lat without from_lng is not a resolvable origin.
    app = plan_app(tmp_path)
    with TestClient(app) as client:
        _inject_plan_data(app, synthetic_feed())
        response = client.get(
            "/api/journey/plan",
            params={"from_lat": -6.2, "to_stop": "s2"},
        )
    assert response.status_code == 422
    assert "origin" in response.json()["detail"]


def test_plan_invalid_date_returns_422(tmp_path):
    app = plan_app(tmp_path)
    with TestClient(app) as client:
        _inject_plan_data(app, synthetic_feed())
        response = client.get(
            "/api/journey/plan",
            params={"from_stop": "s1", "to_stop": "s2", "date": "not-a-date"},
        )
    assert response.status_code == 422
    assert "date" in response.json()["detail"]


def test_plan_invalid_time_returns_422(tmp_path):
    app = plan_app(tmp_path)
    with TestClient(app) as client:
        _inject_plan_data(app, synthetic_feed())
        response = client.get(
            "/api/journey/plan",
            params={"from_stop": "s1", "to_stop": "s2", "date": MONDAY, "time": "abc"},
        )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# arrive-by search
# ---------------------------------------------------------------------------


def test_plan_arrive_by_param(tmp_path):
    app = plan_app(tmp_path)
    with TestClient(app) as client:
        _inject_plan_data(app, synthetic_feed())
        response = client.get(
            "/api/journey/plan",
            params={"from_stop": "s1", "to_stop": "s5", "date": MONDAY, "arrive_by": "10:00"},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["itineraries"], "expected at least one itinerary for arrive_by"
    for itinerary in body["itineraries"]:
        last_leg = itinerary["legs"][-1]
        assert last_leg["end_time"] <= "10:00"


def test_plan_invalid_arrive_by_returns_422(tmp_path):
    app = plan_app(tmp_path)
    with TestClient(app) as client:
        _inject_plan_data(app, synthetic_feed())
        response = client.get(
            "/api/journey/plan",
            params={"from_stop": "s1", "to_stop": "s5", "date": MONDAY, "arrive_by": "abc"},
        )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# include_eta (deterministic simulated ETA)
# ---------------------------------------------------------------------------


def test_plan_include_eta_simulated_and_deterministic(tmp_path):
    app = plan_app(tmp_path)
    params = {"from_stop": "s1", "to_stop": "s2", "date": MONDAY, "time": "08:00", "include_eta": "1"}
    with TestClient(app) as client:
        _inject_plan_data(app, synthetic_feed())
        first = client.get("/api/journey/plan", params=params).json()
        second = client.get("/api/journey/plan", params=params).json()
    assert first["itineraries"]
    bus_legs = [leg for it in first["itineraries"] for leg in it["legs"] if leg["mode"] == "BUS"]
    assert bus_legs, "expected at least one BUS leg"
    for leg in bus_legs:
        assert isinstance(leg["delay_minutes"], int)
        assert 1 <= leg["delay_minutes"] <= 15
        assert isinstance(leg["live_eta_minutes"], int)
        assert leg["live_eta_minutes"] == leg["duration_minutes"] + leg["delay_minutes"]
        assert leg["eta_source"] == "simulated"
    # Determinism: two identical requests produce identical ETA annotations.
    assert second["itineraries"] == first["itineraries"]


def test_plan_include_eta_omitted_keeps_backward_compat(tmp_path):
    app = plan_app(tmp_path)
    with TestClient(app) as client:
        _inject_plan_data(app, synthetic_feed())
        response = client.get(
            "/api/journey/plan",
            params={"from_stop": "s1", "to_stop": "s2", "date": MONDAY, "time": "08:00"},
        )
    assert response.status_code == 200
    for itinerary in response.json()["itineraries"]:
        for leg in itinerary["legs"]:
            if leg["mode"] == "BUS":
                assert "delay_minutes" not in leg
                assert "live_eta_minutes" not in leg
                assert "eta_source" not in leg


# ---------------------------------------------------------------------------
# incidents
# ---------------------------------------------------------------------------


def test_plan_incidents_only_active_and_matched(tmp_path):
    # The lifespan seeds both ``incident-demo-01`` (normal) and
    # ``incident-demo-delay-01`` (delay, route "1"); R1's short_name is "1", so
    # the delay incident is matched against the planned route.
    app = plan_app(tmp_path)
    with TestClient(app) as client:
        _inject_plan_data(app, synthetic_feed())
        response = client.get(
            "/api/journey/plan",
            params={"from_stop": "s1", "to_stop": "s2", "date": MONDAY, "time": "08:00"},
        )
    assert response.status_code == 200
    incidents = response.json()["incidents"]
    ids = [inc.get("id") for inc in incidents]
    assert "incident-demo-delay-01" in ids
    assert "incident-demo-01" not in ids
    delay = next(inc for inc in incidents if inc.get("id") == "incident-demo-delay-01")
    assert delay["status"] == "delay"
    assert delay["affects_route"] is True
    assert delay["cause"] and delay["action"] and delay["instruction"]


def test_plan_incident_unmatched_active_still_appears(tmp_path):
    # Seed an active (diverted) incident on seed route "route-1" through the
    # WebSocket (persisted by the server thread).  The planned route keys are
    # {"R1", "1"} only, so "route-1" is unmatched — yet the banner must still
    # surface it.
    app = plan_app(tmp_path)
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws", headers={"origin": "http://localhost:5173"}) as websocket:
            websocket.receive_json()  # connection.ack
            websocket.send_json({"type": "incident.update", "route_id": "route-1", "stage": 1})
            event = websocket.receive_json()
        assert event["status"] == "diverted"
        _inject_plan_data(app, synthetic_feed())
        response = client.get(
            "/api/journey/plan",
            params={"from_stop": "s1", "to_stop": "s2", "date": MONDAY, "time": "08:00"},
        )
    assert response.status_code == 200
    incidents = response.json()["incidents"]
    unmatched = next(inc for inc in incidents if inc.get("route_id") == "route-1")
    assert unmatched["status"] == "diverted"
    assert unmatched["affects_route"] is False


def test_plan_incidents_empty_when_store_missing(tmp_path):
    app = plan_app(tmp_path)
    with TestClient(app) as client:
        _inject_plan_data(app, synthetic_feed())
        app.state.store = None
        response = client.get(
            "/api/journey/plan",
            params={"from_stop": "s1", "to_stop": "s2", "date": MONDAY, "time": "08:00"},
        )
    assert response.status_code == 200
    assert response.json()["incidents"] == []
