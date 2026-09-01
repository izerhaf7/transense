"""Rail (MRT / KRL / LRT) itinerary generation for the Transense trip planner.

Rail operators come from the Commute Data Platform feed plus the RITJ line
geometry: ordered stations per line, station coordinates, and line color.
Rail services run ~99% on time, so ride durations are estimated from track
distance (geometry) and fixed speed/dwell constants — no live timetable call at
plan time.  Walk legs to/from stations use the haversine estimate (stations are
not GTFS walk-graph nodes).  Intermodal planning chains the bus RAPTOR to/from
rail stations so a single itinerary can mix bus + rail legs; standalone rail
suggestions (WALK -> RAIL -> WALK) are generated alongside.
"""

from __future__ import annotations

from datetime import date as date_cls, datetime, timezone
from typing import Any

from fastapi import FastAPI

from .api.utils import commute_line_stations, haversine_km
from .commute import CommuteFeed
from .planner import itinerary_to_dict, plan_trip
from .walk_graph import WALK_PENALTY_FACTOR, WALK_SPEED_MPS, WalkGraph

# Walk radius around origin/destination within which rail is worth suggesting (m).
RAIL_ACCESS_RADIUS_M = 1500.0
# Average rail service speed used to estimate ride duration (km/h).
RAIL_SPEED_KMH = 35.0
# Dwell time at each intermediate station (seconds).
RAIL_DWELL_SEC = 30.0
# Rail lines the planner considers, in suggestion order.
RAIL_LINES: tuple[tuple[str, str], ...] = (
    ("MRTJ", "M"),
    ("KCI", "B"),
    ("KCI", "C"),
    ("KCI", "R"),
    ("KCI", "T"),
    ("KCI", "TP"),
    ("LRTJ", "S"),
)
# Display short names per rail operator.
RAIL_SHORT_NAMES = {"MRTJ": "MRT", "KCI": "KRL", "LRTJ": "LRT"}
# Maximum intermodal itineraries (each requires two RAPTOR searches).
INTERMODAL_MAX = 3


def _line(application: FastAPI, operator: str, code: str) -> Any | None:
    feed: CommuteFeed | None = getattr(application.state, "commute_feed", None)
    if feed is None:
        return None
    for line in feed.lines:
        if line.operator == operator and line.code == code:
            return line
    return None


def _ordered_stations(
    application: FastAPI, operator: str, code: str
) -> list[dict[str, Any]]:
    """Ordered stations for one rail line, cached on app.state (10-minute TTL)."""
    state = application.state
    now = datetime.now(timezone.utc).timestamp()
    key = f"{operator}:{code}"
    cache: dict[str, tuple[float, list[dict[str, Any]]]] = getattr(
        state, "rail_ordered_stations", {}
    )
    cached = cache.get(key)
    if cached and now - cached[0] < 600:
        return cached[1]
    line = _line(application, operator, code)
    stations = commute_line_stations(application, line) if line is not None else []
    cache[key] = (now, stations)
    state.rail_ordered_stations = cache
    return stations


def _line_color(application: FastAPI, operator: str, code: str) -> str | None:
    line = _line(application, operator, code)
    if line is None:
        return None
    color = getattr(line, "color", "") or ""
    return f"#{color}" if color and not color.startswith("#") else (color or None)


def _rail_short_name(operator: str) -> str:
    return RAIL_SHORT_NAMES.get(operator, operator)


def _resolve_point(point: dict, application: FastAPI) -> dict[str, Any] | None:
    """Normalize a plan point dict to ``{name, lat, lng}``."""
    feed = getattr(application.state, "gtfs_feed", None)
    stop_id = point.get("stop_id")
    if stop_id and feed is not None:
        stop = feed.stops.get(stop_id)
        if stop is not None:
            return {"name": stop.name, "lat": stop.lat, "lng": stop.lng}
    lat, lng = point.get("lat"), point.get("lng")
    if lat is not None and lng is not None:
        return {"name": "Lokasi Anda", "lat": float(lat), "lng": float(lng)}
    return None


def _nearest_station(
    point: dict, stations: list[dict[str, Any]]
) -> tuple[int, dict[str, Any] | None]:
    best_idx, best_st, best_dist = -1, None, float("inf")
    for idx, station in enumerate(stations):
        dist = haversine_km(point["lat"], point["lng"], station["lat"], station["lng"])
        if dist < best_dist:
            best_idx, best_st, best_dist = idx, station, dist
    return best_idx, best_st


def _station_point(station: dict[str, Any]) -> dict[str, Any]:
    return {
        "stop_id": station["id"],
        "name": station["name"],
        "lat": station["lat"],
        "lng": station["lng"],
    }


def _walk_leg(from_point: dict, to_point: dict, distance_m: float) -> dict[str, Any]:
    return {
        "mode": "WALK",
        "from": from_point,
        "to": to_point,
        "duration_minutes": round(distance_m / (WALK_SPEED_MPS * 60)),
        "distance_m": round(distance_m),
        "walk_estimate": True,
    }


def _rail_leg(
    from_idx: int,
    to_idx: int,
    from_station: dict[str, Any],
    to_station: dict[str, Any],
    stations: list[dict[str, Any]],
    application: FastAPI,
    operator: str,
    code: str,
) -> dict[str, Any]:
    """One RAIL leg between two stations on the same line, ordered along it."""
    if from_idx > to_idx:
        from_idx, to_idx, from_station, to_station = (
            to_idx,
            from_idx,
            to_station,
            from_station,
        )
    ride_m = 0.0
    for i in range(from_idx, to_idx):
        ride_m += haversine_km(
            stations[i]["lat"], stations[i]["lng"], stations[i + 1]["lat"], stations[i + 1]["lng"]
        ) * 1000
    intermediate = max(0, (to_idx - from_idx) - 1)
    ride_minutes = ride_m / (RAIL_SPEED_KMH * 1000 / 60) + intermediate * RAIL_DWELL_SEC / 60
    return {
        "mode": "RAIL",
        "from": _station_point(from_station),
        "to": _station_point(to_station),
        "duration_minutes": round(ride_minutes),
        "distance_m": round(ride_m),
        "route": {
            "id": f"{operator}:{code}",
            "short_name": _rail_short_name(operator),
            "color": _line_color(application, operator, code),
        },
        "headsign": stations[-1]["name"],
    }


def plan_rail(
    origin: dict,
    destination: dict,
    application: FastAPI,
    walk_graph: WalkGraph | None,
    operator: str = "MRTJ",
    code: str = "M",
) -> list[dict[str, Any]]:
    """Standalone WALK -> RAIL -> WALK itinerary for one rail line.

    Returns ``[]`` when the origin/destination is too far from the line's
    stations, both snap to the same station, or the feed/geometry is missing.
    """
    feed: CommuteFeed | None = getattr(application.state, "commute_feed", None)
    if feed is None:
        return []
    geometry = getattr(application.state, "rail_geometry", {}).get(f"{operator}:{code}")
    if not geometry:
        return []

    origin_pt = _resolve_point(origin, application)
    destination_pt = _resolve_point(destination, application)
    if origin_pt is None or destination_pt is None:
        return []

    stations = _ordered_stations(application, operator, code)
    if len(stations) < 2:
        return []

    from_idx, from_st = _nearest_station(origin_pt, stations)
    to_idx, to_st = _nearest_station(destination_pt, stations)
    if from_st is None or to_st is None or from_idx == to_idx:
        return []
    if (
        haversine_km(origin_pt["lat"], origin_pt["lng"], from_st["lat"], from_st["lng"]) * 1000
        > RAIL_ACCESS_RADIUS_M
        or haversine_km(
            destination_pt["lat"], destination_pt["lng"], to_st["lat"], to_st["lng"]
        ) * 1000
        > RAIL_ACCESS_RADIUS_M
    ):
        return []

    walk_origin_m = (
        haversine_km(origin_pt["lat"], origin_pt["lng"], from_st["lat"], from_st["lng"])
        * 1000
        * WALK_PENALTY_FACTOR
    )
    walk_dest_m = (
        haversine_km(
            destination_pt["lat"], destination_pt["lng"], to_st["lat"], to_st["lng"]
        )
        * 1000
        * WALK_PENALTY_FACTOR
    )
    walk_origin_min = walk_origin_m / (WALK_SPEED_MPS * 60)
    walk_dest_min = walk_dest_m / (WALK_SPEED_MPS * 60)
    rail_leg = _rail_leg(from_idx, to_idx, from_st, to_st, stations, application, operator, code)

    legs = [
        _walk_leg(origin_pt, _station_point(from_st), walk_origin_m),
        rail_leg,
        _walk_leg(_station_point(to_st), destination_pt, walk_dest_m),
    ]
    return [
        {
            "legs": legs,
            "transfers": 0,
            "walk_distance_m": round(walk_origin_m + walk_dest_m),
            "walk_minutes": round(walk_origin_min + walk_dest_min),
            "waiting_minutes": 0,
            "total_minutes": round(walk_origin_min + rail_leg["duration_minutes"] + walk_dest_min),
        }
    ]


def plan_standalone_rail(
    origin: dict, destination: dict, application: FastAPI, walk_graph: WalkGraph | None
) -> list[dict[str, Any]]:
    """Standalone rail suggestions for every rail line."""
    results: list[dict[str, Any]] = []
    for operator, code in RAIL_LINES:
        results.extend(plan_rail(origin, destination, application, walk_graph, operator, code))
    return results


def plan_intermodal(
    origin: dict,
    destination: dict,
    application: FastAPI,
    walk_graph: WalkGraph | None,
    plan_date: date_cls,
    departure_time: str,
) -> list[dict[str, Any]]:
    """Bus RAPTOR -> RAIL -> bus RAPTOR itineraries (one per rail line).

    Each rail line whose stations are within ``RAIL_ACCESS_RADIUS_M`` of both
    endpoints produces one combined itinerary: bus legs from the origin to the
    boarding station, a RAIL leg, then bus legs onward to the destination.
    Capped at ``INTERMODAL_MAX`` results; any missing segment degrades to the
    bus-only itineraries already produced by the caller.
    """
    feed = getattr(application.state, "gtfs_feed", None)
    if feed is None:
        return []

    results: list[dict[str, Any]] = []
    for operator, code in RAIL_LINES:
        if len(results) >= INTERMODAL_MAX:
            break
        stations = _ordered_stations(application, operator, code)
        if len(stations) < 2:
            continue
        origin_pt = _resolve_point(origin, application)
        destination_pt = _resolve_point(destination, application)
        if origin_pt is None or destination_pt is None:
            continue
        from_idx, from_st = _nearest_station(origin_pt, stations)
        to_idx, to_st = _nearest_station(destination_pt, stations)
        if from_st is None or to_st is None or from_idx == to_idx:
            continue
        if (
            haversine_km(origin_pt["lat"], origin_pt["lng"], from_st["lat"], from_st["lng"]) * 1000
            > RAIL_ACCESS_RADIUS_M
            or haversine_km(
                destination_pt["lat"], destination_pt["lng"], to_st["lat"], to_st["lng"]
            ) * 1000
            > RAIL_ACCESS_RADIUS_M
        ):
            continue

        try:
            # Rail stations are not GTFS stops: pass coordinates so the RAPTOR
            # snaps to the nearest bus stops and pads walk legs.
            from_station_point = {"name": from_st["name"], "lat": from_st["lat"], "lng": from_st["lng"]}
            to_station_point = {"name": to_st["name"], "lat": to_st["lat"], "lng": to_st["lng"]}
            first_segment = plan_trip(
                feed, walk_graph, origin, from_station_point, plan_date,
                departure_time=departure_time,
            )
            last_segment = plan_trip(
                feed, walk_graph, to_station_point, destination, plan_date,
                departure_time=departure_time,
            )
        except (ValueError, KeyError):
            continue
        if not first_segment or not last_segment:
            continue

        first_dict = itinerary_to_dict(first_segment[0])
        last_dict = itinerary_to_dict(last_segment[0])
        rail_leg = _rail_leg(from_idx, to_idx, from_st, to_st, stations, application, operator, code)

        legs = [*first_dict["legs"], rail_leg, *last_dict["legs"]]
        walk_m = (first_dict.get("walk_distance_m") or 0) + (last_dict.get("walk_distance_m") or 0)
        walk_min = (first_dict.get("walk_minutes") or 0) + (last_dict.get("walk_minutes") or 0)
        total_min = (first_dict.get("total_minutes") or 0) + rail_leg["duration_minutes"] + (
            last_dict.get("total_minutes") or 0
        )
        results.append(
            {
                "legs": legs,
                "transfers": max(
                    0,
                    (first_dict.get("transfers") or 0) + (last_dict.get("transfers") or 0) + 1,
                ),
                "walk_distance_m": round(walk_m),
                "walk_minutes": round(walk_min),
                "waiting_minutes": 0,
                "total_minutes": round(total_min),
            }
        )
    return results
