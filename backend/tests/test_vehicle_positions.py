"""Tests for backend.vehicle_positions (schedule-based interpolation)."""

from __future__ import annotations

from datetime import date, datetime, timezone

from backend.gtfs_loader import (
    GtfsCalendar,
    GtfsFeed,
    GtfsRoute,
    GtfsShapePoint,
    GtfsStop,
    GtfsStopTime,
    GtfsTrip,
)
from backend.vehicle_positions import (
    build_trip_geometry,
    now_service_time,
    position_at,
    vehicles_at,
)

# ---------------------------------------------------------------------------
# Synthetic feed fixtures
# ---------------------------------------------------------------------------


def _make_feed() -> GtfsFeed:
    """Small deterministic feed: one route, two trips, one shape."""
    feed = GtfsFeed()

    feed.stops = {
        "stop-a": GtfsStop(stop_id="stop-a", name="A", lat=-6.0, lng=106.0),
        "stop-b": GtfsStop(stop_id="stop-b", name="B", lat=-6.005, lng=106.005),
        "stop-c": GtfsStop(stop_id="stop-c", name="C", lat=-6.01, lng=106.01),
    }
    feed.routes = {
        "route-1": GtfsRoute(
            route_id="route-1",
            short_name="1",
            long_name="Route 1",
            route_type="3",
            color="FF0000",
            text_color="FFFFFF",
        )
    }
    feed.trips = {
        "trip-1": GtfsTrip(
            trip_id="trip-1",
            route_id="route-1",
            shape_id="shape-1",
            direction_id=0,
            headsign="C",
            service_id="svc-1",
        ),
        "trip-2": GtfsTrip(
            trip_id="trip-2",
            route_id="route-1",
            shape_id="",
            direction_id=0,
            headsign="C",
            service_id="svc-1",
        ),
        "trip-overnight": GtfsTrip(
            trip_id="trip-overnight",
            route_id="route-1",
            shape_id="shape-1",
            direction_id=0,
            headsign="C",
            service_id="svc-1",
        ),
    }
    feed.shapes = {
        "shape-1": [
            GtfsShapePoint(lat=-6.0, lng=106.0, sequence=1),
            GtfsShapePoint(lat=-6.0025, lng=106.0025, sequence=2),
            GtfsShapePoint(lat=-6.005, lng=106.005, sequence=3),
            GtfsShapePoint(lat=-6.0075, lng=106.0075, sequence=4),
            GtfsShapePoint(lat=-6.01, lng=106.01, sequence=5),
        ]
    }
    feed.stop_times = {
        "trip-1": [
            GtfsStopTime(trip_id="trip-1", stop_id="stop-a", stop_sequence=1, arrival_time="08:00:00", departure_time="08:00:00"),
            GtfsStopTime(trip_id="trip-1", stop_id="stop-b", stop_sequence=2, arrival_time="08:10:00", departure_time="08:12:00"),
            GtfsStopTime(trip_id="trip-1", stop_id="stop-c", stop_sequence=3, arrival_time="08:20:00", departure_time="08:20:00"),
        ],
        "trip-2": [
            GtfsStopTime(trip_id="trip-2", stop_id="stop-a", stop_sequence=1, arrival_time="09:00:00", departure_time="09:00:00"),
            GtfsStopTime(trip_id="trip-2", stop_id="stop-b", stop_sequence=2, arrival_time="09:10:00", departure_time="09:12:00"),
            GtfsStopTime(trip_id="trip-2", stop_id="stop-c", stop_sequence=3, arrival_time="09:20:00", departure_time="09:20:00"),
        ],
        "trip-overnight": [
            GtfsStopTime(trip_id="trip-overnight", stop_id="stop-a", stop_sequence=1, arrival_time="23:30:00", departure_time="23:30:00"),
            GtfsStopTime(trip_id="trip-overnight", stop_id="stop-b", stop_sequence=2, arrival_time="24:10:00", departure_time="24:12:00"),
            GtfsStopTime(trip_id="trip-overnight", stop_id="stop-c", stop_sequence=3, arrival_time="24:30:00", departure_time="24:30:00"),
        ],
    }
    feed.calendar = {
        "svc-1": GtfsCalendar(
            service_id="svc-1",
            weekdays={0, 1, 2, 3, 4, 5, 6},
            start_date="20240101",
            end_date="20991231",
        )
    }
    return feed


# ---------------------------------------------------------------------------
# now_service_time
# ---------------------------------------------------------------------------


def test_now_service_time_converts_utc_to_wib():
    # 2025-01-15 01:00 UTC == 08:00 WIB.
    day, seconds = now_service_time(datetime(2025, 1, 15, 1, 0, 0, tzinfo=timezone.utc))
    assert day == date(2025, 1, 15)
    assert seconds == 8 * 3600


def test_now_service_time_handles_naive_as_utc():
    day, seconds = now_service_time(datetime(2025, 1, 15, 17, 0, 0))
    assert day == date(2025, 1, 16)
    assert seconds == 0


# ---------------------------------------------------------------------------
# build_trip_geometry
# ---------------------------------------------------------------------------


def test_build_trip_geometry_shape_based():
    feed = _make_feed()
    g = build_trip_geometry(feed, "trip-1")
    assert g is not None
    assert g.geometry_type == "shape"
    assert len(g.shape) == 5
    assert len(g.cum_dist) == 5
    assert g.cum_dist[0] == 0.0
    assert g.cum_dist[-1] > 0.0
    assert g.stop_shape_idx == [0, 2, 4]
    assert g.dep_s == [8 * 3600, 8 * 3600 + 12 * 60, 8 * 3600 + 20 * 60]
    assert g.arr_s == [8 * 3600, 8 * 3600 + 10 * 60, 8 * 3600 + 20 * 60]


def test_build_trip_geometry_estimated_without_shape():
    feed = _make_feed()
    g = build_trip_geometry(feed, "trip-2")
    assert g is not None
    assert g.geometry_type == "estimated"
    assert len(g.shape) == 3
    assert g.stop_shape_idx == [0, 1, 2]


def test_build_trip_geometry_returns_none_for_missing_trip():
    feed = _make_feed()
    assert build_trip_geometry(feed, "nope") is None


def test_build_trip_geometry_returns_none_without_stop_times():
    feed = _make_feed()
    feed.stop_times.pop("trip-1")
    assert build_trip_geometry(feed, "trip-1") is None


# ---------------------------------------------------------------------------
# position_at
# ---------------------------------------------------------------------------


def test_position_at_fixed_time_is_deterministic():
    feed = _make_feed()
    g = build_trip_geometry(feed, "trip-1")
    assert g is not None
    t = 8 * 3600 + 5 * 60  # 08:05, en route between stop-a and stop-b
    p1 = position_at(g, t)
    p2 = position_at(g, t)
    assert p1 is not None and p2 is not None
    assert p1 == p2
    assert p1["status"] == "en_route"


def test_position_at_movement_is_monotonic():
    feed = _make_feed()
    g = build_trip_geometry(feed, "trip-1")
    assert g is not None
    distances = []
    for minute in range(0, 21):
        t = 8 * 3600 + minute * 60
        pos = position_at(g, t)
        if pos is None:
            continue
        # Distance along the shape grows with latitude decreasing in this
        # southbound fixture, so the absolute latitude is monotonic.
        distances.append(abs(pos["lat"]))
    assert distances == sorted(distances)


def test_position_at_dwell_speed_zero():
    feed = _make_feed()
    g = build_trip_geometry(feed, "trip-1")
    assert g is not None
    # 08:10:30 dwells at stop-b (arr 08:10, dep 08:12).
    pos = position_at(g, 8 * 3600 + 10 * 60 + 30)
    assert pos is not None
    assert pos["status"] == "at_stop"
    assert pos["speed_mps"] == 0.0
    assert pos["lat"] == -6.005
    assert pos["lng"] == 106.005


def test_position_at_not_started_returns_none():
    feed = _make_feed()
    g = build_trip_geometry(feed, "trip-1")
    assert g is not None
    assert position_at(g, 7 * 3600) is None


def test_position_at_finished_returns_none():
    feed = _make_feed()
    g = build_trip_geometry(feed, "trip-1")
    assert g is not None
    assert position_at(g, 8 * 3600 + 20 * 60) is None


def test_position_at_overnight_times_parse_beyond_24h():
    feed = _make_feed()
    g = build_trip_geometry(feed, "trip-overnight")
    assert g is not None
    assert g.dep_s[0] == 23 * 3600 + 30 * 60
    assert g.arr_s[-1] == 24 * 3600 + 30 * 60
    pos = position_at(g, 24 * 3600 + 15 * 60)  # 00:15 next day
    assert pos is not None
    assert pos["status"] in ("en_route", "at_stop")


# ---------------------------------------------------------------------------
# vehicles_at
# ---------------------------------------------------------------------------


def test_vehicles_at_feed_none_returns_unavailable():
    assert vehicles_at(None, {}, datetime.now(timezone.utc)) == {
        "source": "unavailable",
        "vehicles": [],
    }


def test_vehicles_at_outside_service_hours():
    feed = _make_feed()
    cache: dict = {}
    # 03:00 WIB = 2025-01-14 20:00 UTC — no trips active.
    result = vehicles_at(feed, cache, datetime(2025, 1, 14, 20, 0, 0, tzinfo=timezone.utc))
    assert result["source"] == "scheduled"
    assert result["status"] == "outside_service_hours"
    assert result["vehicles"] == []


def test_vehicles_at_active_trips():
    feed = _make_feed()
    cache: dict = {}
    # 08:05 WIB = 2025-01-15 01:05 UTC.
    result = vehicles_at(feed, cache, datetime(2025, 1, 15, 1, 5, 0, tzinfo=timezone.utc))
    assert result["source"] == "scheduled"
    assert result["status"] == "ok"
    assert len(result["vehicles"]) == 1
    v = result["vehicles"][0]
    assert v["trip_id"] == "trip-1"
    assert v["route_code"] == "1"
    assert v["status"] == "en_route"
    assert v["geometry"] == "shape"


def test_vehicles_at_overnight_trip_active_next_day():
    feed = _make_feed()
    cache: dict = {}
    # 00:15 WIB 2025-01-16 = 2025-01-15 17:15 UTC.
    result = vehicles_at(feed, cache, datetime(2025, 1, 15, 17, 15, 0, tzinfo=timezone.utc))
    assert result["status"] == "ok"
    assert any(v["trip_id"] == "trip-overnight" for v in result["vehicles"])


def test_vehicles_at_estimated_geometry_when_shape_missing():
    feed = _make_feed()
    cache: dict = {}
    # 09:05 WIB = 2025-01-15 02:05 UTC.
    result = vehicles_at(feed, cache, datetime(2025, 1, 15, 2, 5, 0, tzinfo=timezone.utc))
    assert result["status"] == "ok"
    trip2 = [v for v in result["vehicles"] if v["trip_id"] == "trip-2"]
    assert len(trip2) == 1
    assert trip2[0]["geometry"] == "estimated"
