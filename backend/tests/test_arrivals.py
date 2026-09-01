from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

import backend.api.routers.realtime as realtime_mod
from backend.gtfs_loader import GtfsFeed, GtfsRoute, GtfsStop, GtfsStopTime, GtfsTrip
from backend.tj_api import RealtimeBus, RealtimeStopEta


def synthetic_feed() -> GtfsFeed:
    route_one = GtfsRoute("1", "1", "Koridor 1", "3", "FF0000", "FFFFFF")
    route_two = GtfsRoute("2", "2", "Koridor 2", "3", "00FF00", "FFFFFF")
    return GtfsFeed(
        stops={"stop-a": GtfsStop("stop-a", "Halte A", -6.24, 106.80)},
        routes={"1": route_one, "2": route_two},
        routes_by_stop={"stop-a": ["1", "2"]},
    )


def bus_with_operator_eta() -> RealtimeBus:
    return RealtimeBus(
        bus_id="B1",
        route_code="1",
        lat=-6.238,
        lng=106.798,
        direction_id=0,
        trip_id=None,
        observed_at=datetime.now(timezone.utc),
        stops=(RealtimeStopEta("stop-a", "Halte A", None, None, 3),),
    )


def bus_without_eta() -> RealtimeBus:
    return RealtimeBus(
        bus_id="B2",
        route_code="2",
        lat=-6.23,
        lng=106.79,
        direction_id=0,
        trip_id=None,
        observed_at=datetime.now(timezone.utc),
    )


def test_operator_eta_matches_stop_or_parent_stop():
    bus = bus_with_operator_eta()
    assert realtime_mod._operator_eta_minutes(bus, "stop-a") == 3
    parent_bus = RealtimeBus(
        bus_id="B3",
        route_code="1",
        lat=-6.23,
        lng=106.79,
        direction_id=0,
        trip_id=None,
        observed_at=datetime.now(timezone.utc),
        stops=(RealtimeStopEta("platform-x", "Halte A", "stop-a", "Halte A", 5),),
    )
    assert realtime_mod._operator_eta_minutes(parent_bus, "stop-a") == 5


def test_operator_eta_none_when_stop_missing():
    assert realtime_mod._operator_eta_minutes(bus_without_eta(), "stop-a") is None


def test_scheduled_eta_uses_gtfs_stop_times():
    feed = GtfsFeed(
        stops={
            "stop-a": GtfsStop("stop-a", "Halte A", -6.24, 106.80),
            "stop-b": GtfsStop("stop-b", "Halte B", -6.23, 106.81),
        },
        trips={"trip-1": GtfsTrip("trip-1", "1", None, 0, "Koridor 1")},
        stop_times={
            "trip-1": [
                GtfsStopTime("trip-1", "stop-a", 1, "07:00:00", "07:00:30"),
                GtfsStopTime("trip-1", "stop-b", 2, "07:10:00", "07:10:30"),
            ]
        },
    )
    # Bus is just past stop-a; the next scheduled arrival (stop-b) is at 07:10.
    bus = RealtimeBus("B1", "1", -6.2395, 106.8005, 0, "trip-1", datetime.now(timezone.utc))
    now = datetime(2026, 9, 1, 0, 2, 0, tzinfo=timezone.utc)  # 07:02 WIB
    assert realtime_mod._scheduled_eta_minutes(feed, bus, now) == 8


def test_arrivals_route_code_filter_and_eta_source(monkeypatch):
    app = FastAPI()
    app.include_router(realtime_mod.router)
    app.state.settings = SimpleNamespace(
        realtime_enabled=True,
        realtime_api_base="http://unused",
        realtime_center_lat=-6.1944,
        realtime_center_lng=106.8227,
        realtime_radius_km=3.0,
    )
    app.state.gtfs_feed = synthetic_feed()
    app.state.realtime_error = None

    class FakeClient:
        def get_buses(self, lat, lng, radius_km):
            return [bus_with_operator_eta(), bus_without_eta()]

    monkeypatch.setattr(realtime_mod, "_ensure_realtime_client", lambda request: FakeClient())

    with TestClient(app) as client:
        filtered = client.get("/api/arrivals", params={"stop_id": "stop-a", "route_code": "1"})
    data = filtered.json()
    assert data["source"] == "realtime"
    assert [item["bus_id"] for item in data["arrivals"]] == ["B1"]
    assert data["arrivals"][0]["eta_source"] == "realtime"
    assert data["arrivals"][0]["eta_minutes"] == 3
    assert data["arrivals"][0]["lat"] == -6.238
    assert data["arrivals"][0]["lng"] == 106.798

    with TestClient(app) as client:
        unfiltered = client.get("/api/arrivals", params={"stop_id": "stop-a"})
    all_data = unfiltered.json()
    assert [item["bus_id"] for item in all_data["arrivals"]] == ["B1", "B2"]
    assert {item["eta_source"] for item in all_data["arrivals"]} == {"realtime", "estimated"}
