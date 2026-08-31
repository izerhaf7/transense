"""API tests for ``GET /api/vehicle-positions`` (backend/api/routers/vehicles.py).

The synthetic feeds are built directly (no network, no zip).  The lifespan is
pointed at a GTFS url that always fails (discard port) so ``app.state.gtfs_feed``
stays ``None`` at startup; tests inject feeds onto ``app.state`` afterwards,
mirroring ``test_plan_endpoint.py``.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from backend.config import Settings
from backend.gtfs_loader import (
    GtfsCalendar,
    GtfsFeed,
    GtfsRoute,
    GtfsShapePoint,
    GtfsStop,
    GtfsStopTime,
    GtfsTrip,
)
from backend.main import create_app

# A GTFS url/cache that always fails so the lifespan leaves the feed unset
# regardless of a local ``backend/gtfs_cache.zip``.  The discard port refuses
# instantly, no network needed.
_BROKEN_GTFS_URL = "http://127.0.1:9/nonexistent.zip"


def vehicles_app(tmp_path) -> object:
    """App whose lifespan never loads a real feed (broken GTFS settings)."""
    return create_app(
        Settings(
            "test",
            ("http://localhost:5173",),
            tmp_path / "demo.sqlite3",
            gtfs_url=_BROKEN_GTFS_URL,
            gtfs_cache_path=str(tmp_path / "missing.zip"),
            commute_enabled=False,
        )
    )


def _base_feed() -> GtfsFeed:
    """Two-stop corridor feed used by both fixtures below."""
    feed = GtfsFeed()
    feed.stops = {
        "s1": GtfsStop(stop_id="s1", name="A", lat=-6.0, lng=106.0),
        "s2": GtfsStop(stop_id="s2", name="B", lat=-6.01, lng=106.01),
    }
    feed.routes = {
        "R1": GtfsRoute(
            route_id="R1",
            short_name="1",
            long_name="Route 1",
            route_type="3",
            color="FF0000",
            text_color="FFFFFF",
        )
    }
    feed.shapes = {
        "shp": [
            GtfsShapePoint(lat=-6.0, lng=106.0, sequence=1),
            GtfsShapePoint(lat=-6.005, lng=106.005, sequence=2),
            GtfsShapePoint(lat=-6.01, lng=106.01, sequence=3),
        ]
    }
    return feed


def always_active_feed() -> GtfsFeed:
    """Feed whose single trip is active at any wall-clock time.

    ``00:00 -> 47:59:59`` (>24h GTFS times) spans two service days, and the
    calendar covers every weekday through 2099, so the endpoint's real
    ``datetime.now`` always lands inside the trip regardless of when the test
    runs.  Position assertions therefore stay deterministic.
    """
    feed = _base_feed()
    feed.trips = {
        "always": GtfsTrip(
            trip_id="always",
            route_id="R1",
            shape_id="shp",
            direction_id=0,
            headsign="B",
            service_id="svc",
        )
    }
    feed.stop_times = {
        "always": [
            GtfsStopTime(trip_id="always", stop_id="s1", stop_sequence=1, arrival_time="00:00", departure_time="00:00"),
            GtfsStopTime(trip_id="always", stop_id="s2", stop_sequence=2, arrival_time="47:59:59", departure_time="47:59"),
        ]
    }
    feed.calendar = {
        "svc": GtfsCalendar(
            service_id="svc",
            weekdays={0, 1, 2, 3, 4, 5, 6},
            start_date="20200101",
            end_date="20991231",
        )
    }
    return feed


def expired_feed() -> GtfsFeed:
    """Feed whose service calendar ended in 2020 — never active today."""
    feed = _base_feed()
    feed.trips = {
        "old": GtfsTrip(
            trip_id="old",
            route_id="R1",
            shape_id="shp",
            direction_id=0,
            headsign="B",
            service_id="svc-old",
        )
    }
    feed.stop_times = {
        "old": [
            GtfsStopTime(trip_id="old", stop_id="s1", stop_sequence=1, arrival_time="08:00:00", departure_time="08:00"),
            GtfsStopTime(trip_id="old", stop_id="s2", stop_sequence=2, arrival_time="09:00", departure_time="09:00:00"),
        ]
    }
    feed.calendar = {
        "svc-old": GtfsCalendar(
            service_id="svc-old",
            weekdays={0, 1, 2, 3, 4, 5, 6},
            start_date="20200101",
            end_date="20200102",
        )
    }
    return feed


def test_vehicle_positions_scheduled(tmp_path):
    app = vehicles_app(tmp_path)
    with TestClient(app) as client:
        app.state.gtfs_feed = always_active_feed()
        response = client.get("/api/vehicle-positions")
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "scheduled"
    assert body["status"] == "ok"
    assert body["server_time"]
    assert len(body["vehicles"]) == 1

    vehicle = body["vehicles"][0]
    assert vehicle["trip_id"] == "always"
    assert vehicle["id"] == "always"
    assert vehicle["route_id"] == "R1"
    assert vehicle["route_code"] == "1"
    assert vehicle["status"] == "en_route"
    assert vehicle["geometry"] == "shape"
    # Between s1 (-6.0) and s2 (-6.01) along the shape.
    assert -6.01 <= vehicle["lat"] <= -6.0
    assert 106.0 <= vehicle["lng"] <= 106.01
    assert vehicle["speed_mps"] > 0
    assert 0.0 <= vehicle["bearing"] < 360.0


def test_vehicle_positions_feed_none_unavailable(tmp_path):
    app = vehicles_app(tmp_path)
    with TestClient(app) as client:
        response = client.get("/api/vehicle-positions")
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "unavailable"
    assert body["vehicles"] == []


def test_vehicle_positions_outside_service_hours(tmp_path):
    app = vehicles_app(tmp_path)
    with TestClient(app) as client:
        app.state.gtfs_feed = expired_feed()
        response = client.get("/api/vehicle-positions")
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "scheduled"
    assert body["status"] == "outside_service_hours"
    assert body["vehicles"] == []


def test_vehicle_positions_cache_is_reused(tmp_path):
    app = vehicles_app(tmp_path)
    with TestClient(app) as client:
        app.state.gtfs_feed = always_active_feed()
        first = client.get("/api/vehicle-positions")
        assert first.status_code == 200
        cache = getattr(app.state, "vehicle_geometry_cache", None)
        assert isinstance(cache, dict)
        assert "always" in cache
        second = client.get("/api/vehicle-positions")
    assert second.status_code == 200
    assert second.json()["source"] == "scheduled"
    assert len(second.json()["vehicles"]) == 1
