"""Tests for the RAPTOR trip planner (backend/planner.py).

The synthetic feed is constructed directly (no network, no zip): a small
deterministic TransJakarta-like network with weekday (``WD``) and weekend
(``WE``) services so transfer, service-day, and alternatives scenarios are
fully controlled.  Coordinates are chosen so only s1<->s7 lie within the 1 km
walk-graph radius — every other pair must be connected by bus.
"""

import datetime

import pytest

from backend.gtfs_loader import GtfsCalendar, GtfsFeed, GtfsRoute, GtfsStop, GtfsStopTime, GtfsTrip
from backend.walk_graph import walk_graph_from_feed
from backend.planner import (
    Itinerary,
    Leg,
    Point,
    RouteInfo,
    itinerary_to_dict,
    plan_trip,
)

MONDAY = datetime.date(2024, 1, 8)  # 2024-01-08 is a Monday (WD runs)
SUNDAY = datetime.date(2024, 1, 7)  # 2024-01-07 is a Sunday (WE runs)


def _st(trip_id: str, stop_id: str, seq: int, time: str) -> GtfsStopTime:
    """One stop_time row with identical arrival/departure (the demo norm)."""
    return GtfsStopTime(trip_id=trip_id, stop_id=stop_id, stop_sequence=seq,
                        arrival_time=time, departure_time=time)


def synthetic_feed() -> GtfsFeed:
    """Deterministic synthetic feed:
    - s1..s5 form a linear-ish corridor; s6 is disconnected (no trips).
    - s7 sits ~763 m from s1, so it is the only stop-pair within the 1 km
      walk radius (walk access/transfer scenario).
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


def _bus_leg(leg: Leg) -> Leg:
    assert leg.mode == "BUS", f"expected BUS leg, got {leg.mode}"
    return leg


def _walk_leg(leg: Leg) -> Leg:
    assert leg.mode == "WALK", f"expected WALK leg, got {leg.mode}"
    return leg


# ---------------------------------------------------------------------------
# single-trip route
# ---------------------------------------------------------------------------


def test_single_trip_direct_route():
    feed = synthetic_feed()
    itineraries = plan_trip(
        feed,
        None,  # degraded mode: haversine fallback
        {"stop_id": "s1"},
        {"stop_id": "s2"},
        MONDAY,
        departure_time="08:00",
    )
    assert len(itineraries) == 1
    itinerary = itineraries[0]
    assert isinstance(itinerary, Itinerary)
    assert [leg.mode for leg in itinerary.legs] == ["BUS"]
    leg = _bus_leg(itinerary.legs[0])
    assert leg.from_point.stop_id == "s1"
    assert leg.to_point.stop_id == "s2"
    assert leg.route is not None
    assert leg.route.id == "R1"
    assert leg.route.short_name == "1"
    assert leg.start_time == "08:00"
    assert leg.end_time == "08:10"
    assert leg.duration_minutes == 10
    assert leg.distance_m > 0
    assert leg.trip_id == "T1"
    assert leg.headsign == "Halte Sudirman"
    assert itinerary.transfers == 0
    assert itinerary.walk_distance_m == 0
    assert itinerary.total_minutes == 10


def test_itinerary_to_dict_matches_frontend_contract():
    feed = synthetic_feed()
    (itinerary,) = plan_trip(feed, None, {"stop_id": "s1"}, {"stop_id": "s2"}, MONDAY, departure_time="08:00")
    payload = itinerary_to_dict(itinerary)

    assert isinstance(payload, dict)
    assert isinstance(payload["legs"], list) and payload["legs"]
    for key in ("transfers", "walk_distance_m", "total_minutes"):
        assert isinstance(payload[key], (int, float)), f"{key} must be numeric"
    assert isinstance(payload.get("walk_minutes"), (int, float))
    assert isinstance(payload.get("waiting_minutes"), (int, float))

    leg = payload["legs"][0]
    assert leg["mode"] == "BUS"
    for key in ("from", "to"):
        point = leg[key]
        assert isinstance(point, dict)
        assert isinstance(point["name"], str)
        assert isinstance(point["lat"], (int, float))
        assert isinstance(point["lng"], (int, float))
        assert isinstance(point["stop_id"], str)
    assert leg["start_time"] == "08:00" and leg["end_time"] == "08:10"
    assert isinstance(leg["duration_minutes"], (int, float))
    assert isinstance(leg["distance_m"], (int, float))
    route = leg["route"]
    assert route == {"id": "R1", "short_name": "1", "color": "009F3C"}
    assert leg["headsign"] == "Halte Sudirman"
    assert leg["trip_id"] == "T1"
    # WALK legs never carry route/trip/headsign; the coordinate-based ones are
    # explicitly labelled as haversine estimates.
    walk_feed = synthetic_feed()
    (walk_it,) = plan_trip(
        walk_feed, None,
        {"lat": -6.1985, "lng": 106.8010},
        {"lat": -6.1985, "lng": 106.8090},
        MONDAY, departure_time="07:50",
    )
    walk_payload = itinerary_to_dict(walk_it)
    first = walk_payload["legs"][0]
    assert first["mode"] == "WALK"
    assert "route" not in first and "trip_id" not in first and "headsign" not in first
    assert first.get("walk_estimate") is True


# ---------------------------------------------------------------------------
# multi-trip with transfer
# ---------------------------------------------------------------------------


def test_multi_trip_with_transfer():
    feed = synthetic_feed()
    itineraries = plan_trip(
        feed,
        None,
        {"stop_id": "s2"},
        {"stop_id": "s4"},
        MONDAY,
        departure_time="08:00",
    )
    assert len(itineraries) == 1
    itinerary = itineraries[0]
    assert [leg.mode for leg in itinerary.legs] == ["BUS", "BUS"]
    first, second = [_bus_leg(leg) for leg in itinerary.legs]
    assert (first.from_point.stop_id, first.to_point.stop_id) == ("s2", "s3")
    assert (second.from_point.stop_id, second.to_point.stop_id) == ("s3", "s4")
    assert first.trip_id == "T1" and second.trip_id == "T2"
    assert first.end_time == "08:20" and second.start_time == "08:30"
    assert itinerary.transfers == 1
    assert itinerary.total_minutes == 40


# ---------------------------------------------------------------------------
# no route
# ---------------------------------------------------------------------------


def test_no_route_returns_empty_list_never_raises():
    feed = synthetic_feed()
    # s6 is served by no trip and is out of walk range from every other stop.
    for walk_graph in (None, walk_graph_from_feed(feed, radius_km=1.0)):
        result = plan_trip(
            feed,
            walk_graph,
            {"stop_id": "s1"},
            {"stop_id": "s6"},
            MONDAY,
            departure_time="08:00",
        )
        assert result == []
    # Unknown stops are also a clean empty result.
    assert plan_trip(feed, None, {"stop_id": "s1"}, {"stop_id": "missing"}, MONDAY) == []
    assert plan_trip(feed, None, {"stop_id": "missing"}, {"stop_id": "s1"}, MONDAY) == []


# ---------------------------------------------------------------------------
# walk access / egress for coordinate origins
# ---------------------------------------------------------------------------


def test_walk_access_and_egress_legs():
    feed = synthetic_feed()
    origin = {"lat": -6.1985, "lng": 106.8010}   # snaps to s1 (~197 m)
    destination = {"lat": -6.1985, "lng": 106.8090}  # snaps to s2 (~197 m)
    itineraries = plan_trip(
        feed,
        None,  # degraded mode: haversine snap + estimate
        origin,
        destination,
        MONDAY,
        departure_time="07:50",
    )
    assert len(itineraries) == 1
    itinerary = itineraries[0]
    assert [leg.mode for leg in itinerary.legs] == ["WALK", "BUS", "WALK"]

    access, bus, egress = itinerary.legs
    access = _walk_leg(access)
    bus = _bus_leg(bus)
    egress = _walk_leg(egress)

    assert access.from_point.stop_id is None
    assert access.from_point.name == "Lokasi Anda"
    assert access.to_point.stop_id == "s1"
    assert access.distance_m > 0
    assert access.walk_estimate is True
    assert bus.from_point.stop_id == "s1" and bus.to_point.stop_id == "s2"
    assert egress.from_point.stop_id == "s2"
    assert egress.to_point.stop_id is None
    assert egress.to_point.name == "Lokasi Anda"
    assert egress.distance_m > 0
    assert egress.walk_estimate is True
    assert itinerary.walk_distance_m == pytest.approx(access.distance_m + egress.distance_m)


# ---------------------------------------------------------------------------
# walk transfer between stops (walk graph edge, not just access/egress)
# ---------------------------------------------------------------------------


def test_walk_transfer_between_stops_via_walk_graph():
    feed = synthetic_feed()
    graph = walk_graph_from_feed(feed, radius_km=1.0)
    assert graph.walk_between("s7", "s1") is not None  # only in-range pair

    itineraries = plan_trip(
        feed,
        graph,
        {"stop_id": "s7"},
        {"stop_id": "s5"},
        MONDAY,
        departure_time="07:50",
    )
    assert len(itineraries) == 1
    itinerary = itineraries[0]
    assert [leg.mode for leg in itinerary.legs] == ["WALK", "BUS"]
    walk, bus = _walk_leg(itinerary.legs[0]), _bus_leg(itinerary.legs[1])
    assert walk.from_point.stop_id == "s7"
    assert walk.to_point.stop_id == "s1"
    assert walk.distance_m > 0
    assert bus.trip_id == "T3"  # T1 (08:00) is missed after the ~14 min walk


# ---------------------------------------------------------------------------
# service-day filtering
# ---------------------------------------------------------------------------


def test_service_day_filters_out_inactive_trip():
    feed = synthetic_feed()
    # s2->s4 needs T1 (WD) then T2 (WD); on a Sunday both are inactive, so no
    # route exists even though the weekend T5 runs.
    assert plan_trip(feed, None, {"stop_id": "s2"}, {"stop_id": "s4"}, SUNDAY, departure_time="08:00") == []
    # Same query on Monday is found (T1 + T2).
    found = plan_trip(feed, None, {"stop_id": "s2"}, {"stop_id": "s4"}, MONDAY, departure_time="08:00")
    assert len(found) == 1 and len(found[0].legs) == 2


def test_service_day_weekend_trip_only_found_on_weekend():
    feed = synthetic_feed()
    # s1->s2 on Sunday: only the weekend T5 runs (09:00).
    sunday = plan_trip(feed, None, {"stop_id": "s1"}, {"stop_id": "s2"}, SUNDAY, departure_time="08:00")
    assert len(sunday) == 1
    assert _bus_leg(sunday[0].legs[0]).start_time == "09:00"
    # s1->s2 on Monday: the weekday T1 runs instead (08:00).
    monday = plan_trip(feed, None, {"stop_id": "s1"}, {"stop_id": "s2"}, MONDAY, departure_time="08:00")
    assert len(monday) == 1
    assert _bus_leg(monday[0].legs[0]).start_time == "08:00"


# ---------------------------------------------------------------------------
# alternatives
# ---------------------------------------------------------------------------


def test_up_to_three_alternatives_ordered_by_duration():
    feed = synthetic_feed()
    itineraries = plan_trip(
        feed,
        None,
        {"stop_id": "s1"},
        {"stop_id": "s5"},
        MONDAY,
        departure_time="08:00",
        max_itineraries=3,
    )
    assert len(itineraries) == 3

    totals = [it.total_minutes for it in itineraries]
    assert totals == sorted(totals)

    # Direct R3 wins (08:05 -> 08:45).
    best = itineraries[0]
    assert [leg.mode for leg in best.legs] == ["BUS"]
    best_route = _bus_leg(best.legs[0]).route
    assert best_route is not None
    assert best_route.short_name == "3"

    # The two remaining 50-minute options transfer through s3 and differ in
    # their first leg route (R1 then R2; R4 then R2).
    assert totals[1] == 50 and totals[2] == 50
    first_routes: set[str] = set()
    for alternative in itineraries[1:]:
        assert [leg.mode for leg in alternative.legs] == ["BUS", "BUS"]
        assert alternative.transfers == 1
        first_route = _bus_leg(alternative.legs[0]).route
        assert first_route is not None
        first_routes.add(first_route.id)
    first_routes.add(best_route.id)
    assert first_routes == {"R1", "R3", "R4"}
    # Distinct itineraries, not duplicates.
    signatures = {tuple((leg.mode, leg.trip_id) for leg in it.legs) for it in itineraries}
    assert len(signatures) == 3


def test_fewer_alternatives_when_only_one_first_route():
    feed = synthetic_feed()
    # s1->s2 is only reachable via R1 (T1); no alternative exists.
    itineraries = plan_trip(
        feed,
        None,
        {"stop_id": "s1"},
        {"stop_id": "s2"},
        MONDAY,
        departure_time="08:00",
        max_itineraries=3,
    )
    assert len(itineraries) == 1


# ---------------------------------------------------------------------------
# arrive-by (latest-departure reverse search)
# ---------------------------------------------------------------------------


def test_arrive_by_returns_latest_departure():
    feed = synthetic_feed()
    # s1->s2 on a Monday is only served by T1 (08:00 -> 08:10); with an
    # arrive-by deadline the latest feasible departure is exactly 08:00.
    itineraries = plan_trip(
        feed,
        None,
        {"stop_id": "s1"},
        {"stop_id": "s2"},
        MONDAY,
        arrive_by="10:00",
    )
    assert len(itineraries) == 1
    itinerary = itineraries[0]
    assert [leg.mode for leg in itinerary.legs] == ["BUS"]
    leg = _bus_leg(itinerary.legs[0])
    assert leg.trip_id == "T1"
    assert leg.start_time == "08:00"
    assert leg.end_time == "08:10"
    assert leg.end_time is not None and leg.end_time <= "10:00"
    assert itinerary.total_minutes == 10


def test_arrive_by_picks_latest_feasible_of_several():
    feed = synthetic_feed()
    # s1->s5 by 10:00: T3 (departs 08:05) is the latest departure; T1+T2
    # (departs 08:00) and T4 (departs 08:00) are the deterministic alternatives.
    itineraries = plan_trip(
        feed,
        None,
        {"stop_id": "s1"},
        {"stop_id": "s5"},
        MONDAY,
        arrive_by="10:00",
        max_itineraries=3,
    )
    assert len(itineraries) == 3
    totals = [it.total_minutes for it in itineraries]
    assert totals == sorted(totals)

    best = itineraries[0]
    best_bus = _bus_leg(best.legs[0])
    assert best_bus.route is not None
    assert best_bus.route.short_name == "3"
    assert best_bus.start_time == "08:05" and best_bus.end_time == "08:45"

    # Every alternative must still arrive no later than the deadline.
    for it in itineraries:
        end_time = _bus_leg(it.legs[-1]).end_time
        assert end_time is not None and end_time <= "10:00"

    signatures = {tuple((leg.mode, leg.trip_id) for leg in it.legs) for it in itineraries}
    assert len(signatures) == 3


def test_arrive_by_no_route_returns_empty_list():
    feed = synthetic_feed()
    # s6 is served by no trip and is out of walk range from every other stop.
    for walk_graph in (None, walk_graph_from_feed(feed, radius_km=1.0)):
        result = plan_trip(
            feed,
            walk_graph,
            {"stop_id": "s1"},
            {"stop_id": "s6"},
            MONDAY,
            arrive_by="10:00",
        )
        assert result == []
    # Unknown stops are also a clean empty result.
    assert plan_trip(feed, None, {"stop_id": "s1"}, {"stop_id": "missing"}, MONDAY, arrive_by="10:00") == []
    assert plan_trip(feed, None, {"stop_id": "missing"}, {"stop_id": "s1"}, MONDAY, arrive_by="10:00") == []


def test_arrive_by_before_first_trip_returns_empty():
    feed = synthetic_feed()
    # Earliest weekday s1->s2 arrival is T1 at 08:10; a 07:00 deadline fits nothing.
    assert plan_trip(feed, None, {"stop_id": "s1"}, {"stop_id": "s2"}, MONDAY, arrive_by="07:00") == []
    # On Sunday only T5 runs (09:00 -> 09:10); an 08:30 deadline is too early.
    assert plan_trip(feed, None, {"stop_id": "s1"}, {"stop_id": "s2"}, SUNDAY, arrive_by="08:30") == []


def test_arrive_by_wins_over_departure_time():
    feed = synthetic_feed()
    arrive_only = plan_trip(
        feed,
        None,
        {"stop_id": "s1"},
        {"stop_id": "s5"},
        MONDAY,
        arrive_by="09:00",
    )
    both = plan_trip(
        feed,
        None,
        {"stop_id": "s1"},
        {"stop_id": "s5"},
        MONDAY,
        departure_time="08:00",
        arrive_by="09:00",
    )
    # arrive_by wins: the reverse search result is identical and every arrival
    # respects the deadline (a forward 08:00 departure would also surface T4's
    # 09:10 arrival, which violates the deadline).
    assert both == arrive_only
    assert both, "arrive-by search must still find 09:00-compatible trips"
    for it in both:
        end_time = _bus_leg(it.legs[-1]).end_time
        assert end_time is not None and end_time <= "09:00"


def test_arrive_by_with_walk_access_egress():
    feed = synthetic_feed()
    origin = {"lat": -6.1985, "lng": 106.8010}  # snaps to s1 (~197 m)
    itineraries = plan_trip(
        feed,
        None,
        origin,
        {"stop_id": "s5"},
        MONDAY,
        arrive_by="09:00",
    )
    assert itineraries, "walk access must not break arrive-by search"
    itinerary = itineraries[0]
    assert [leg.mode for leg in itinerary.legs] == ["WALK", "BUS"]
    access, bus = itinerary.legs
    access = _walk_leg(access)
    bus = _bus_leg(bus)
    # The access walk is subtracted from the latest origin-stop time: the walk
    # ends exactly when the (latest) T3 board happens.
    assert access.to_point.stop_id == "s1"
    assert access.end_time == bus.start_time == "08:05"
    assert bus.end_time is not None and bus.end_time <= "09:00"
    assert access.walk_estimate is True
    # Every alternative still arrives within the deadline.
    for it in itineraries:
        end_time = _bus_leg(it.legs[-1]).end_time
        assert end_time is not None and end_time <= "09:00"
