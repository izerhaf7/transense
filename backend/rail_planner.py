"""Rail (MRT) itinerary generation for the Transense trip planner.

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

from .api.utils import commute_line_stations, haversine_km, line_terminus_departures
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
)
# Display short names per rail operator.
RAIL_SHORT_NAMES = {"MRTJ": "MRT"}
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


def _line_terminus_departures(
    application: FastAPI, operator: str, stations: list[dict[str, Any]], at_end: bool
) -> list[str]:
    """Terminus departures for one rail direction.

    ``at_end=False`` reads the timetable of the line's first station (the
    trains that then travel toward higher station indexes); ``at_end=True``
    reads the last station's timetable (trains traveling the reverse way).
    """
    terminus = stations[-1] if at_end else stations[0]
    key = terminus.get("code") or terminus.get("id")
    return line_terminus_departures(application, operator, [terminus]) if key else []


def _seconds_of_day(hhmm: str) -> int | None:
    """``HH:MM`` -> seconds since midnight; ``None`` on garbage."""
    try:
        hours, minutes = (int(part) for part in str(hhmm).split(":"))
    except (ValueError, AttributeError):
        return None
    if hours > 23 or minutes > 59:
        return None
    return hours * 3600 + minutes * 60


def _format_hhmm(total_seconds: int) -> str:
    total_seconds %= 86400
    return f"{total_seconds // 3600:02d}:{(total_seconds % 3600) // 60:02d}"


def _segment_seconds_between(
    stations: list[dict[str, Any]], low_idx: int, high_idx: int
) -> int:
    """Track seconds from station ``low_idx`` to ``high_idx`` (geometry sum)."""
    metres = 0.0
    for i in range(low_idx, high_idx):
        metres += haversine_km(
            stations[i]["lat"], stations[i]["lng"], stations[i + 1]["lat"], stations[i + 1]["lng"]
        ) * 1000
    ride_minutes = metres / (RAIL_SPEED_KMH * 1000 / 60) + max(0, high_idx - low_idx - 1) * RAIL_DWELL_SEC / 60
    return round(ride_minutes * 60)


def rail_ride_times(
    application: FastAPI,
    operator: str,
    code: str,
    stations: list[dict[str, Any]],
    from_idx: int,
    to_idx: int,
    arrival_at_platform_seconds: int,
) -> tuple[str, str] | None:
    """Board/alight clock times for a rail ride, from the terminus timetable.

    MRT runs ~98% on time, so the schedule is the reference.  Departures are
    read from the terminus on the travel side (station 0 when riding toward
    higher indexes, the last station otherwise); the first train that reaches
    the boarding platform at or after ``arrival_at_platform_seconds`` is
    chosen.  Returns ``("HH:MM", "HH:MM")`` or ``None`` when no timetable is
    available or no train fits within the day (callers keep duration-only
    estimates as a fallback).
    """
    low_idx, high_idx = sorted((from_idx, to_idx))
    riding_forward = to_idx > from_idx
    departures = _line_terminus_departures(application, operator, stations, at_end=not riding_forward)
    terminus_idx = 0 if riding_forward else len(stations) - 1
    travel_to_board = (
        _segment_seconds_between(stations, terminus_idx, from_idx)
        if riding_forward
        else _segment_seconds_between(stations, from_idx, terminus_idx)
    )
    travel_board_to_alight = _segment_seconds_between(stations, low_idx, high_idx)

    board_time = None
    alight_time = None
    for departure in departures:
        departure_s = _seconds_of_day(departure)
        if departure_s is None:
            continue
        platform_arrival_s = departure_s + travel_to_board
        if platform_arrival_s < arrival_at_platform_seconds:
            continue
        board_time = platform_arrival_s
        alight_time = platform_arrival_s + travel_board_to_alight
        break
    if board_time is None or alight_time is None:
        return None
    return _format_hhmm(board_time), _format_hhmm(alight_time)


def _rail_leg(
    from_idx: int,
    to_idx: int,
    from_station: dict[str, Any],
    to_station: dict[str, Any],
    stations: list[dict[str, Any]],
    application: FastAPI,
    operator: str,
    code: str,
    times: tuple[str, str] | None = None,
) -> dict[str, Any]:
    """One RAIL leg between two stations on the same line, ordered along it.

    ``from_station``/``to_station`` keep the caller's travel direction (origin
    side → destination side); the distance only depends on the span, so it is
    summed over the station range regardless of direction.  When ``times``
    (board, alight) are given the leg carries real clock times; otherwise it
    is a duration-only estimate (frontend shows no clock).
    """
    low_idx, high_idx = sorted((from_idx, to_idx))
    ride_m = 0.0
    for i in range(low_idx, high_idx):
        ride_m += haversine_km(
            stations[i]["lat"], stations[i]["lng"], stations[i + 1]["lat"], stations[i + 1]["lng"]
        ) * 1000
    intermediate = max(0, (high_idx - low_idx) - 1)
    ride_minutes = ride_m / (RAIL_SPEED_KMH * 1000 / 60) + intermediate * RAIL_DWELL_SEC / 60
    # Head toward the terminus on the travel side: the line's first station
    # when riding "backwards" (high index → low index), last station otherwise.
    headsign_name = stations[0]["name"] if to_idx < from_idx else stations[-1]["name"]
    leg: dict[str, Any] = {
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
        "headsign": headsign_name,
    }
    if times is not None:
        leg["start_time"], leg["end_time"] = times
    return leg


def plan_rail(
    origin: dict,
    destination: dict,
    application: FastAPI,
    walk_graph: WalkGraph | None,
    operator: str = "MRTJ",
    code: str = "M",
    departure_time: str | None = None,
) -> list[dict[str, Any]]:
    """Standalone WALK -> RAIL -> WALK itinerary for one rail line.

    Returns ``[]`` when the origin/destination is too far from the line's
    stations, both snap to the same station, or the feed/geometry is missing.
    With ``departure_time`` the rail leg carries clock times from the terminus
    timetable (MRT ~98% on time); without it the leg is a duration estimate.
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

    rail_times: tuple[str, str] | None = None
    waiting_minutes = 0
    departure_s = _seconds_of_day(departure_time) if departure_time else None
    if departure_s is not None:
        platform_arrival_s = departure_s + round(walk_origin_min * 60)
        rail_times = rail_ride_times(
            application, operator, code, stations, from_idx, to_idx, platform_arrival_s
        )
        if rail_times is not None:
            board_s = _seconds_of_day(rail_times[0])
            waiting_minutes = max(0, round((board_s - platform_arrival_s) / 60)) if board_s is not None else 0
    rail_leg = _rail_leg(
        from_idx, to_idx, from_st, to_st, stations, application, operator, code, times=rail_times
    )

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
            "waiting_minutes": waiting_minutes,
            "total_minutes": round(
                walk_origin_min + waiting_minutes + rail_leg["duration_minutes"] + walk_dest_min
            ),
        }
    ]


def plan_standalone_rail(
    origin: dict,
    destination: dict,
    application: FastAPI,
    walk_graph: WalkGraph | None,
    departure_time: str | None = None,
) -> list[dict[str, Any]]:
    """Standalone rail suggestions for every rail line."""
    results: list[dict[str, Any]] = []
    for operator, code in RAIL_LINES:
        results.extend(
            plan_rail(
                origin, destination, application, walk_graph,
                operator=operator, code=code, departure_time=departure_time,
            )
        )
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
        # MRT clock: the train departs once the first bus segment reaches the
        # boarding station.  Use the segment's last leg end_time (GTFS clock)
        # when present; duration-only estimates keep no rail clock.
        rail_times: tuple[str, str] | None = None
        rail_waiting_minutes = 0
        arrival_at_platform_s = None
        for bus_leg in reversed(first_dict.get("legs", [])):
            if bus_leg.get("mode") == "BUS" and bus_leg.get("end_time"):
                arrival_at_platform_s = _seconds_of_day(bus_leg["end_time"])
                break
        if arrival_at_platform_s is not None:
            rail_times = rail_ride_times(
                application, operator, code, stations, from_idx, to_idx, arrival_at_platform_s
            )
            if rail_times is not None:
                board_s = _seconds_of_day(rail_times[0])
                rail_waiting_minutes = (
                    max(0, round((board_s - arrival_at_platform_s) / 60)) if board_s is not None else 0
                )
        rail_leg = _rail_leg(
            from_idx, to_idx, from_st, to_st, stations, application, operator, code,
            times=rail_times,
        )

        legs = [*first_dict["legs"], rail_leg, *last_dict["legs"]]
        walk_m = (first_dict.get("walk_distance_m") or 0) + (last_dict.get("walk_distance_m") or 0)
        walk_min = (first_dict.get("walk_minutes") or 0) + (last_dict.get("walk_minutes") or 0)
        total_min = (first_dict.get("total_minutes") or 0) + rail_waiting_minutes + rail_leg["duration_minutes"] + (
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
                "waiting_minutes": rail_waiting_minutes,
                "total_minutes": round(total_min),
            }
        )
    return results
