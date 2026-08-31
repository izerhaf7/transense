"""Schedule-based vehicle position interpolation ("Gapeka-style").

Pure-logic module (stdlib only, no FastAPI/httpx — same style as
``backend/planner.py``) that computes a deterministic vehicle position for
every active GTFS trip from ``stop_times`` + ``shapes`` polylines:

* **Time zone** — GTFS times are Asia/Jakarta (WIB, UTC+7).  Server UTC is
  converted via :func:`now_service_time`; client clocks are never used.
* **Trip geometry** — each trip's stops are snapped to its shape polyline
  with a *monotonic* scan (search only forward from the previous stop's
  index) so loop routes cannot snap to the wrong segment.  Cumulative
  distances along the polyline are precomputed once and cached per trip.
* **Interpolation** — for a trip active at ``t`` the segment
  ``dep_i <= t < arr_{i+1}`` is found by binary search; the fraction of the
  segment traversed in time maps linearly onto shape distance.  While
  ``arr_i <= t < dep_i`` the vehicle dwells at stop *i* with speed 0.
* **Overnight trips** — GTFS allows hours >= 24 (e.g. ``"25:30:00"``);
  :func:`vehicles_at` checks both today's and yesterday's service date.

Everything is a pure function of ``(feed, time)`` — no randomness, no state,
no external calls.  A missing feed degrades to ``source: "unavailable"``;
a feed with no active trips degrades to ``status: "outside_service_hours"``.
"""

from __future__ import annotations

import math
from bisect import bisect_right
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from backend.gtfs_loader import (
    GtfsFeed,
    GtfsShapePoint,
    service_active_on,
)

__all__ = [
    "WIB_OFFSET_S",
    "TripGeometry",
    "now_service_time",
    "build_trip_geometry",
    "position_at",
    "vehicles_at",
]

WIB_OFFSET_S = 7 * 3600
_WIB = timezone(timedelta(seconds=WIB_OFFSET_S))
_EARTH_RADIUS_KM = 6371.0088


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


def now_service_time(now_utc: datetime) -> tuple[date, int]:
    """Convert a UTC datetime to ``(service_date, seconds_since_midnight)`` in
    Asia/Jakarta (WIB)."""
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)
    wib = now_utc.astimezone(_WIB)
    seconds = wib.hour * 3600 + wib.minute * 60 + wib.second
    return wib.date(), seconds


def _parse_time(value: str) -> int:
    """Parse a GTFS ``HH:MM:SS`` clock into seconds since midnight of the
    service day; hours beyond 24 are allowed (>= 86400)."""
    parts = value.split(":")
    hours = int(parts[0]) if parts else 0
    minutes = int(parts[1]) if len(parts) > 1 else 0
    seconds = int(parts[2]) if len(parts) > 2 else 0
    return hours * 3600 + minutes * 60 + seconds


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------


def _haversine_m(lat_a: float, lng_a: float, lat_b: float, lng_b: float) -> float:
    """Great-circle distance in metres between two WGS84 coordinates."""
    phi_a, phi_b = math.radians(lat_a), math.radians(lat_b)
    d_phi = math.radians(lat_b - lat_a)
    d_lmb = math.radians(lng_b - lng_a)
    a = (
        math.sin(d_phi / 2.0) ** 2
        + math.cos(phi_a) * math.cos(phi_b) * math.sin(d_lmb / 2.0) ** 2
    )
    return 2.0 * _EARTH_RADIUS_KM * math.asin(math.sqrt(a)) * 1000.0


def _bearing_deg(lat_a: float, lng_a: float, lat_b: float, lng_b: float) -> float:
    """Initial bearing in degrees (0 = north, clockwise) from A to B."""
    phi_a, phi_b = math.radians(lat_a), math.radians(lat_b)
    d_lmb = math.radians(lng_b - lng_a)
    y = math.sin(d_lmb) * math.cos(phi_b)
    x = math.cos(phi_a) * math.sin(phi_b) - math.sin(phi_a) * math.cos(phi_b) * math.cos(d_lmb)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _point_at_distance(
    shape: list[GtfsShapePoint], cum_dist: list[float], target_dist: float
) -> tuple[float, float, float]:
    """Point at ``target_dist`` metres along the polyline.

    Binary-searches ``cum_dist`` and linearly interpolates within the
    containing segment.  Returns ``(lat, lng, bearing_deg)``; the bearing is
    the direction of that polyline segment.
    """
    if not shape:
        return 0.0, 0.0, 0.0
    if target_dist <= 0.0 or len(shape) == 1:
        first = shape[0]
        bearing = 0.0
        if len(shape) > 1:
            bearing = _bearing_deg(first.lat, first.lng, shape[1].lat, shape[1].lng)
        return first.lat, first.lng, bearing

    total = cum_dist[-1]
    if target_dist >= total:
        last = shape[-1]
        prev = shape[-2]
        return last.lat, last.lng, _bearing_deg(prev.lat, prev.lng, last.lat, last.lng)

    index = bisect_right(cum_dist, target_dist) - 1
    index = max(0, min(index, len(shape) - 2))
    seg_start = cum_dist[index]
    seg_end = cum_dist[index + 1]
    a = shape[index]
    b = shape[index + 1]
    frac = 0.0 if seg_end <= seg_start else (target_dist - seg_start) / (seg_end - seg_start)
    lat = a.lat + frac * (b.lat - a.lat)
    lng = a.lng + frac * (b.lng - a.lng)
    return lat, lng, _bearing_deg(a.lat, a.lng, b.lat, b.lng)


# ---------------------------------------------------------------------------
# Trip geometry
# ---------------------------------------------------------------------------


@dataclass
class TripGeometry:
    """Precomputed interpolation state for one trip.

    ``shape``/``cum_dist`` describe the polyline; ``stop_shape_idx`` snaps
    each stop (in ``stop_times`` order) to a shape point index; ``dep_s`` and
    ``arr_s`` are the parsed GTFS times (seconds since service-day midnight,
    possibly >= 86400 for overnight trips).  ``geometry_type`` is ``"shape"``
    when a real GTFS shape was used, ``"estimated"`` for the straight-line
    stop-to-stop fallback.
    """

    shape: list[GtfsShapePoint]
    cum_dist: list[float]
    stop_shape_idx: list[int]
    dep_s: list[int]
    arr_s: list[int]
    geometry_type: str


def build_trip_geometry(feed: GtfsFeed, trip_id: str) -> TripGeometry | None:
    """Build the interpolation geometry for ``trip_id``.

    Returns ``None`` when the trip is unknown or has no stop_times.  When the
    trip has no shape, a straight-line polyline through the stop coordinates
    is synthesized and marked ``geometry_type="estimated"``.
    """
    trip = feed.trips.get(trip_id)
    if trip is None:
        return None
    stop_times = feed.stop_times.get(trip_id, [])
    if not stop_times:
        return None

    shape = feed.shapes.get(trip.shape_id or "")
    geometry_type = "shape"
    if not shape:
        points: list[GtfsShapePoint] = []
        for index, st in enumerate(stop_times):
            stop = feed.stops.get(st.stop_id)
            if stop is None:
                continue
            points.append(GtfsShapePoint(lat=stop.lat, lng=stop.lng, sequence=index))
        if len(points) < 2:
            return None
        shape = points
        geometry_type = "estimated"

    cum_dist: list[float] = [0.0]
    for index in range(1, len(shape)):
        prev, cur = shape[index - 1], shape[index]
        cum_dist.append(cum_dist[-1] + _haversine_m(prev.lat, prev.lng, cur.lat, cur.lng))

    stop_shape_idx: list[int] = []
    dep_s: list[int] = []
    arr_s: list[int] = []
    search_from = 0
    for st in stop_times:
        stop = feed.stops.get(st.stop_id)
        if stop is None:
            return None
        best_idx = search_from
        best_dist = math.inf
        # Monotonic scan: never search backward, so loop routes keep moving
        # forward along the polyline instead of snapping to an earlier pass.
        for idx in range(search_from, len(shape)):
            dist = _haversine_m(stop.lat, stop.lng, shape[idx].lat, shape[idx].lng)
            if dist < best_dist:
                best_dist = dist
                best_idx = idx
        stop_shape_idx.append(best_idx)
        search_from = best_idx
        dep_s.append(_parse_time(st.departure_time))
        arr_s.append(_parse_time(st.arrival_time))

    return TripGeometry(
        shape=list(shape),
        cum_dist=cum_dist,
        stop_shape_idx=stop_shape_idx,
        dep_s=dep_s,
        arr_s=arr_s,
        geometry_type=geometry_type,
    )


# ---------------------------------------------------------------------------
# Position interpolation
# ---------------------------------------------------------------------------


def position_at(g: TripGeometry, now_s: int) -> dict | None:
    """Vehicle position on trip geometry ``g`` at ``now_s`` seconds.

    Returns ``None`` when the trip has not started (``now_s < dep_s[0]``) or
    has finished (``now_s >= arr_s[-1]``); otherwise a dict with ``lat``,
    ``lng``, ``speed_mps``, ``bearing`` and ``status`` (``"at_stop"`` while
    dwelling, ``"en_route"`` while moving between stops).

    Dwell is ``arr_s[i] <= now_s < dep_s[i]``: the last stop whose arrival is
    not after ``now_s`` is found by binary search on ``arr_s``; while ``now_s``
    precedes that stop's departure the vehicle sits at the stop with speed 0.
    """
    if now_s < g.dep_s[0]:
        return None
    if now_s >= g.arr_s[-1]:
        return None

    # Last stop index whose arrival is not after now_s (vehicle is at or
    # past that stop).  now_s < arr_s[-1] guarantees index + 1 is valid.
    index = bisect_right(g.arr_s, now_s) - 1
    index = max(0, min(index, len(g.arr_s) - 1))

    if now_s < g.dep_s[index]:
        # Dwelling at stop `index` (arrived, not yet departed).
        point = g.shape[g.stop_shape_idx[index]]
        return {
            "lat": point.lat,
            "lng": point.lng,
            "speed_mps": 0.0,
            "bearing": 0.0,
            "status": "at_stop",
        }

    # En route between stop `index` and stop `index + 1`.
    if index + 1 >= len(g.dep_s):
        return None
    dep = g.dep_s[index]
    arr_next = g.arr_s[index + 1]
    span = arr_next - dep
    if span <= 0:
        return None
    frac = (now_s - dep) / span
    frac = max(0.0, min(1.0, frac))
    dist_a = g.cum_dist[g.stop_shape_idx[index]]
    dist_b = g.cum_dist[g.stop_shape_idx[index + 1]]
    target = dist_a + frac * (dist_b - dist_a)
    lat, lng, bearing = _point_at_distance(g.shape, g.cum_dist, target)
    segment_distance = dist_b - dist_a
    return {
        "lat": lat,
        "lng": lng,
        "speed_mps": segment_distance / span,
        "bearing": bearing,
        "status": "en_route",
    }


# ---------------------------------------------------------------------------
# Feed-wide snapshot
# ---------------------------------------------------------------------------


def vehicles_at(feed: GtfsFeed | None, cache: dict[str, TripGeometry], now_utc: datetime) -> dict:
    """Positions of every trip active at ``now_utc``.

    ``cache`` maps ``trip_id -> TripGeometry`` and is filled lazily (built on
    first access).  Both today's and yesterday's service dates are checked so
    overnight trips with GTFS times >= 24h remain visible after midnight.
    """
    if feed is None:
        return {"source": "unavailable", "vehicles": []}

    service_date, now_s = now_service_time(now_utc)
    yesterday = service_date - timedelta(days=1)

    vehicles: list[dict] = []
    for trip_id, trip in feed.trips.items():
        if not stop_times_present(feed, trip_id):
            continue
        geometry = cache.get(trip_id)
        if geometry is None:
            built = build_trip_geometry(feed, trip_id)
            if built is None:
                continue
            cache[trip_id] = built
            geometry = built

        active = False
        effective_now = now_s
        for candidate_date in (service_date, yesterday):
            if not _service_runs(feed, trip.service_id, candidate_date):
                continue
            if candidate_date == yesterday:
                effective_now = now_s + 86400
            else:
                effective_now = now_s
            if geometry.dep_s[0] <= effective_now < geometry.arr_s[-1]:
                active = True
                break
        if not active:
            continue

        position = position_at(geometry, effective_now)
        if position is None:
            continue
        route = feed.routes.get(trip.route_id)
        vehicles.append(
            {
                "id": trip_id,
                "trip_id": trip_id,
                "route_id": trip.route_id,
                "route_code": route.short_name if route is not None else trip.route_id,
                "lat": position["lat"],
                "lng": position["lng"],
                "speed_mps": position["speed_mps"],
                "bearing": position["bearing"],
                "status": position["status"],
                "geometry": geometry.geometry_type,
            }
        )

    vehicles.sort(key=lambda v: v["trip_id"])
    status = "ok" if vehicles else "outside_service_hours"
    return {
        "source": "scheduled",
        "status": status,
        "server_time": _iso_utc(now_utc),
        "vehicles": vehicles,
    }


def stop_times_present(feed: GtfsFeed, trip_id: str) -> bool:
    """Whether the trip has any stop_times rows."""
    return bool(feed.stop_times.get(trip_id))


def _service_runs(feed: GtfsFeed, service_id: str, day: date) -> bool:
    """Calendar check; an empty service_id is treated as always running."""
    if service_id == "":
        return True
    return service_active_on(feed, service_id, day)


def _iso_utc(value: datetime) -> str:
    """ISO-8601 with ``Z`` suffix (matches repo timestamp convention)."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
