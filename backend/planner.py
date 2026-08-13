"""RAPTOR trip planner over the TransJakarta GTFS feed.

Pure-logic module (no web layer, no dependencies beyond the stdlib) that turns
an origin/destination into one or more transit itineraries over a
:class:`~backend.gtfs_loader.GtfsFeed`:

* **Earliest-arrival RAPTOR** over ``stop_times`` — round k produces labels
  reachable with at most k bus trips.  Each round scans every active route's
  trips from the stops reached in the previous round (route-by-route Pareto
  pruning), then expands transfers: ``feed.transfers`` edges (transfer_type 3
  blocks, types 0/1/2 may require ``min_transfer_time``) and walk-graph edges.
* **Calendar-aware trips** — only trips whose ``service_id`` passes
  :func:`~backend.gtfs_loader.service_active_on` for the requested date are
  scanned.  Trips with an *empty* ``service_id`` (feeds without a
  ``service_id`` column) are treated as always running, since there is no
  calendar data to restrict them.
* **Walk access/egress** — coordinate-only origins/destinations are snapped to
  nearby stops (:meth:`WalkGraph.nearest_stops`, or a local haversine snap when
  ``walk_graph`` is ``None``) and the itinerary is padded with WALK legs.  The
  snap distance is a straight-line estimate (haversine * circuity factor),
  labelled ``walk_estimate: true`` in the serialized leg.
* **Transfers** — inter-stop walking uses the walk graph when available
  (``walk_estimate`` reflects the edge's method), otherwise a deterministic
  haversine fallback within the default 1 km radius.
* **Alternatives** — up to ``max_itineraries`` deterministic alternatives are
  produced by *first-leg route banning*: after each search the route of the
  best itinerary's first BUS leg is banned from being the first trip of the
  next search.  This yields alternatives that differ in their first leg route
  (the strategy sanctioned by the OpenSpec design).  It is acceptable to return
  fewer than the requested maximum when fewer genuinely distinct routes exist.
* **Overnight times** — GTFS ``HH:MM:SS`` values may exceed 24:00 (e.g.
  ``25:30:00`` for trips continuing past midnight).  Times are parsed to raw
  seconds since midnight of the service day (possibly >= 86400) and compared
  in that space; displayed ``start_time``/``end_time`` values are normalized
  mod 24h.

The public boundary is :func:`plan_trip` and :func:`itinerary_to_dict`.  The
latter is deliberately a module-level function so the FastAPI endpoint can
serialize planner results without reaching into the dataclasses.  This module
raises nothing for "no route" — :func:`plan_trip` returns ``[]``.

The frontend contract (``frontend/src/PlannerPage.tsx``) requires every number
in the serialized payload to be a real ``int``/``float``; see
:func:`itinerary_to_dict` for the exact shape.
"""

from __future__ import annotations

import datetime
import math
from dataclasses import dataclass

from backend.gtfs_loader import GtfsFeed, GtfsStop, GtfsStopTime, service_active_on
from backend.walk_graph import (
    DEFAULT_RADIUS_KM,
    METHOD_OSMNX,
    WALK_PENALTY_FACTOR,
    WALK_SPEED_MPS,
    WalkEdge,
    WalkGraph,
)

__all__ = [
    "Point",
    "RouteInfo",
    "Leg",
    "Itinerary",
    "plan_trip",
    "itinerary_to_dict",
]

_DAY_SECONDS = 24 * 60 * 60
_ACCESS_POINT_NAME = "Lokasi Anda"
_MAX_ROUND_PADDING = 2


@dataclass(frozen=True)
class Point:
    """A named lat/lng point, optionally tied to a GTFS stop."""

    stop_id: str | None
    name: str
    lat: float
    lng: float

    @classmethod
    def from_stop(cls, stop: GtfsStop) -> "Point":
        return cls(stop_id=stop.stop_id, name=stop.name, lat=stop.lat, lng=stop.lng)

    @classmethod
    def from_coordinate(cls, lat: float, lng: float, name: str = _ACCESS_POINT_NAME) -> "Point":
        return cls(stop_id=None, name=name, lat=lat, lng=lng)


@dataclass(frozen=True)
class RouteInfo:
    """Route metadata carried by BUS legs (matches the frontend PlanRouteInfo)."""

    id: str
    short_name: str
    color: str | None


@dataclass(frozen=True)
class Leg:
    """One leg of an itinerary: a walk or a single bus ride.

    BUS legs carry ``route``/``headsign``/``trip_id`` and schedule-based
    ``start_time``/``end_time``; WALK legs carry neither route nor trip info.
    ``walk_estimate`` marks legs whose distance/duration were computed from the
    haversine straight-line estimate (never claimed exact).
    """

    mode: str  # "WALK" | "BUS"
    from_point: Point
    to_point: Point
    duration_minutes: int
    distance_m: float
    start_time: str | None = None  # "HH:MM"
    end_time: str | None = None  # "HH:MM"
    route: RouteInfo | None = None
    headsign: str | None = None
    trip_id: str | None = None
    walk_estimate: bool = False


@dataclass(frozen=True)
class Itinerary:
    """An ordered set of legs from origin to destination."""

    legs: tuple[Leg, ...]
    transfers: int
    walk_distance_m: float
    walk_minutes: int
    waiting_minutes: int
    total_minutes: int

    @classmethod
    def build(cls, legs: list[Leg], departure_seconds: int, arrival_seconds: int) -> "Itinerary":
        """Aggregate totals from raw leg lists.

        ``total_minutes`` is the elapsed time from ``departure_seconds`` to
        ``arrival_seconds``; ``waiting_minutes`` is the residual that is not
        spent on a leg (so ``total == sum(legs) + waiting`` holds exactly).
        """
        bus_legs = [leg for leg in legs if leg.mode == "BUS"]
        transfers = max(0, len(bus_legs) - 1)
        walk_legs = [leg for leg in legs if leg.mode == "WALK"]
        walk_distance = sum(leg.distance_m for leg in walk_legs)
        walk_minutes = round(sum(leg.duration_minutes for leg in walk_legs))
        total_minutes = max(0, round((arrival_seconds - departure_seconds) / 60))
        leg_minutes = sum(leg.duration_minutes for leg in legs)
        waiting_minutes = max(0, total_minutes - leg_minutes)
        return cls(
            legs=tuple(legs),
            transfers=transfers,
            walk_distance_m=walk_distance,
            walk_minutes=walk_minutes,
            waiting_minutes=waiting_minutes,
            total_minutes=total_minutes,
        )


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


def _parse_time(value: str) -> int:
    """Parse a GTFS ``HH:MM:SS`` (or ``HH:MM``) clock into seconds since
    midnight of the service day.  Hours beyond 24 (e.g. ``"25:10:00"``) are
    allowed and returned as seconds >= 86400."""
    parts = value.split(":")
    hours = int(parts[0]) if parts else 0
    minutes = int(parts[1]) if len(parts) > 1 else 0
    seconds = int(parts[2]) if len(parts) > 2 else 0
    return hours * 3600 + minutes * 60 + seconds


def _format_time(total_seconds: int) -> str:
    """Normalize seconds-since-midnight to ``"HH:MM"`` display time (mod 24h)."""
    seconds = total_seconds % _DAY_SECONDS
    return f"{seconds // 3600:02d}:{(seconds % 3600) // 60:02d}"


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

_EARTH_RADIUS_KM = 6371.0088


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


def _estimate_walk_seconds(distance_m: float) -> float:
    """Seconds to walk ``distance_m`` at the walk-graph walking speed."""
    return distance_m / WALK_SPEED_MPS


def _estimate_street_m(lat_a: float, lng_a: float, lat_b: float, lng_b: float) -> float:
    """Straight-line distance (haversine) inflated by the circuity factor."""
    return _haversine_m(lat_a, lng_a, lat_b, lng_b) * WALK_PENALTY_FACTOR


# ---------------------------------------------------------------------------
# Feed access helpers
# ---------------------------------------------------------------------------


def _trip_runs_on(feed: GtfsFeed, trip_id: str, date: datetime.date | str) -> bool:
    """Whether ``trip_id`` is active on ``date``.

    An empty ``service_id`` is treated as always-running (the feed carries no
    calendar data for it); otherwise ``service_active_on`` decides.
    """
    trip = feed.trips.get(trip_id)
    if trip is None or trip.service_id == "":
        return True
    return service_active_on(feed, trip.service_id, date)


def _active_trips_by_route(
    feed: GtfsFeed, date: datetime.date | str
) -> dict[str, list[str]]:
    """route_id -> sorted trip_ids whose service runs on ``date``."""
    by_route: dict[str, list[str]] = {}
    for trip_id in feed.trips:
        if not _trip_runs_on(feed, trip_id, date):
            continue
        route_id = feed.trips[trip_id].route_id
        by_route.setdefault(route_id, []).append(trip_id)
    for route_id in by_route:
        by_route[route_id].sort()
    return by_route


def _walk_neighbors_map(graph: WalkGraph) -> dict[str, list[tuple[str, WalkEdge]]]:
    """from_stop -> sorted [(to_stop, edge)] adjacency for a walk graph."""
    neighbors: dict[str, list[tuple[str, WalkEdge]]] = {}
    for edge in graph.edges:
        neighbors.setdefault(edge.from_stop, []).append((edge.to_stop, edge))
    for stop_id in neighbors:
        neighbors[stop_id].sort(key=lambda item: (item[0], item[1].distance_m))
    return neighbors


def _haversine_neighbors(
    feed: GtfsFeed, stop_id: str, radius_km: float = DEFAULT_RADIUS_KM
) -> list[tuple[str, float]]:
    """stop_id -> [(neighbor_stop_id, walk_seconds)] haversine fallback edges.

    Only pairs strictly closer than ``radius_km`` are considered (matching the
    walk-graph build rule).  Deterministic order: distance then stop id.
    """
    origin = feed.stops.get(stop_id)
    if origin is None:
        return []
    radius_m = radius_km * 1000.0
    results: list[tuple[str, float]] = []
    for neighbor in feed.stops.values():
        if neighbor.stop_id == stop_id:
            continue
        straight = _haversine_m(origin.lat, origin.lng, neighbor.lat, neighbor.lng)
        if straight < radius_m:
            street = straight * WALK_PENALTY_FACTOR
            results.append((neighbor.stop_id, _estimate_walk_seconds(street)))
    results.sort(key=lambda item: (item[0], item[1]))
    return results


def _snap_nearest_stops(
    feed: GtfsFeed, lat: float, lng: float, limit: int = 3
) -> list[tuple[GtfsStop, float]]:
    """Coordinate -> nearby stops sorted by (straight-line distance, stop_id).

    Mirrors ``WalkGraph.nearest_stops`` so the planner behaves identically when
    the walk graph is unavailable.
    """
    radius_m = DEFAULT_RADIUS_KM * 1000.0
    results: list[tuple[GtfsStop, float]] = []
    for stop in feed.stops.values():
        distance = _haversine_m(lat, lng, stop.lat, stop.lng)
        if distance <= radius_m:
            results.append((stop, distance))
    results.sort(key=lambda item: (item[1], item[0].stop_id))
    if limit and limit > 0:
        results = results[:limit]
    return results


# ---------------------------------------------------------------------------
# RAPTOR internals
# ---------------------------------------------------------------------------


@dataclass
class _Label:
    """Earliest-arrival label for one stop.

    ``kind`` is ``"initial"`` (origin, no predecessor), ``"walk"`` (arrived by
    a walk/transfer edge) or ``"bus"`` (arrived by a bus trip).  The fields
    mirror what the leg reconstruction needs.
    """

    arrival: int
    kind: str
    prev_stop: str | None = None
    # walk leg details (kind == "walk")
    walk_start: int = 0
    walk_distance: float = 0.0
    walk_estimate: bool = False
    # bus leg details (kind == "bus")
    trip_id: str | None = None
    board_stop: str | None = None
    board_time: int = 0


def _run_raptor(
    feed: GtfsFeed,
    walk_graph: WalkGraph | None,
    active_routes: dict[str, list[str]],
    origin_stop: str,
    destination_stop: str,
    departure_seconds: int,
    banned_first_routes: set[str],
    walk_neighbors: dict[str, list[tuple[str, WalkEdge]]] | None,
    _haversine_cache: dict[str, list[tuple[str, float]]],
) -> dict[str, _Label] | None:
    """Run one earliest-arrival RAPTOR search.

    Returns the ``best`` label table, or ``None`` when the destination is
    unreachable.  ``banned_first_routes`` are excluded from round-1 route scans
    only (they may still be used as later legs), which is how alternative
    itineraries differing in their first leg are produced.
    """
    best: dict[str, _Label] = {
        origin_stop: _Label(arrival=departure_seconds, kind="initial")
    }
    marked: dict[str, _Label] = {origin_stop: best[origin_stop]}

    # Round 0 transfer relaxation: walking out of the origin (still zero bus
    # trips) so a first bus can be boarded at a nearby stop.
    _expand_transfers(
        feed,
        walk_graph,
        origin_stop,
        departure_seconds,
        best,
        marked,
        walk_neighbors,
        _haversine_cache,
    )

    max_rounds = len(active_routes) + _MAX_ROUND_PADDING
    for round_index in range(max_rounds):
        first_leg_round = round_index == 0
        next_marked: dict[str, _Label] = {}

        # --- route scanning -------------------------------------------------
        for route_id in sorted(active_routes):
            if first_leg_round and route_id in banned_first_routes:
                continue
            trip_ids = active_routes[route_id]
            # Trips with no stop_times are skipped; stop_times are pre-sorted
            # by stop_sequence by the GTFS loader.
            for trip_id in trip_ids:
                stop_times = feed.stop_times.get(trip_id)
                if not stop_times:
                    continue
                _scan_trip(
                    trip_id,
                    stop_times,
                    best,
                    marked,
                    next_marked,
                )

        # --- transfer / walk expansion --------------------------------------
        for stop_id in sorted(next_marked):
            label = next_marked[stop_id]
            _expand_transfers(
                feed,
                walk_graph,
                stop_id,
                label.arrival,
                best,
                next_marked,
                walk_neighbors,
                _haversine_cache,
            )

        if not next_marked:
            break
        marked = next_marked

    if destination_stop not in best:
        return None
    return best


def _scan_trip(
    trip_id: str,
    stop_times: list[GtfsStopTime],
    best: dict[str, _Label],
    marked: dict[str, _Label],
    next_marked: dict[str, _Label],
) -> None:
    """Scan one trip: board at the first marked stop we can catch, then relax
    every later stop."""
    board_index: int | None = None
    board_time = 0
    for index, stop_time in enumerate(stop_times):
        label = marked.get(stop_time.stop_id)
        if label is None:
            continue
        departure = _parse_time(stop_time.departure_time)
        if label.arrival <= departure:
            board_index = index
            board_time = departure
            break
    if board_index is None:
        return

    for stop_time in stop_times[board_index + 1 :]:
        arrival = _parse_time(stop_time.arrival_time)
        current = best.get(stop_time.stop_id)
        if current is not None and current.arrival <= arrival:
            continue
        best[stop_time.stop_id] = _Label(
            arrival=arrival,
            kind="bus",
            prev_stop=stop_times[board_index].stop_id,
            trip_id=trip_id,
            board_stop=stop_times[board_index].stop_id,
            board_time=board_time,
        )
        next_marked[stop_time.stop_id] = best[stop_time.stop_id]


def _expand_transfers(
    feed: GtfsFeed,
    walk_graph: WalkGraph | None,
    stop_id: str,
    arrival: int,
    best: dict[str, _Label],
    marked: dict[str, _Label],
    walk_neighbors: dict[str, list[tuple[str, WalkEdge]]] | None,
    haversine_cache: dict[str, list[tuple[str, float]]],
) -> None:
    """Relax walking/transfer edges leaving ``stop_id`` (arrived at ``arrival``)."""
    # transfers.txt edges (directed).  transfer_type 3 = "not possible" blocks.
    for (from_stop, to_stop), transfer in feed.transfers.items():
        if from_stop != stop_id or transfer.transfer_type == "3":
            continue
        to_label = best.get(to_stop)
        if to_label is not None and to_label.arrival <= arrival:
            continue
        min_seconds = max(0, transfer.min_transfer_time)
        if min_seconds <= 0:
            min_seconds = 0
        wait = arrival + min_seconds
        current = best.get(to_stop)
        if current is not None and current.arrival <= wait:
            continue
        best[to_stop] = _Label(
            arrival=wait,
            kind="walk",
            prev_stop=stop_id,
            walk_start=arrival,
            walk_distance=_transfer_distance(feed, stop_id, to_stop),
            walk_estimate=True,
        )
        marked[to_stop] = best[to_stop]

    # walk graph edges (or the deterministic haversine fallback).
    edges: list[tuple[str, float, float, bool]] = []
    if walk_graph is not None and walk_neighbors is not None:
        for to_stop, edge in walk_neighbors.get(stop_id, []):
            estimated = edge.method != METHOD_OSMNX
            edges.append((to_stop, edge.duration_minutes * 60.0, edge.distance_m, estimated))
    else:
        cached = haversine_cache.get(stop_id)
        if cached is None:
            cached = _haversine_neighbors(feed, stop_id)
            haversine_cache[stop_id] = cached
        edges = [
            (to_stop, walk_seconds, _estimate_street_m_from_stops(feed, stop_id, to_stop), True)
            for to_stop, walk_seconds in cached
        ]

    for to_stop, walk_seconds, distance_m, estimated in edges:
        wait = arrival + round(walk_seconds)
        current = best.get(to_stop)
        if current is not None and current.arrival <= wait:
            continue
        best[to_stop] = _Label(
            arrival=wait,
            kind="walk",
            prev_stop=stop_id,
            walk_start=arrival,
            walk_distance=distance_m,
            walk_estimate=estimated,
        )
        marked[to_stop] = best[to_stop]


def _transfer_distance(feed: GtfsFeed, from_stop: str, to_stop: str) -> float:
    """Street-estimated distance (m) for a transfers.txt edge."""
    return _estimate_street_m_from_stops(feed, from_stop, to_stop)


def _estimate_street_m_from_stops(feed: GtfsFeed, from_stop: str, to_stop: str) -> float:
    """Haversine * circuity-factor street estimate (m) between two stops."""
    from_stop_obj = feed.stops.get(from_stop)
    to_stop_obj = feed.stops.get(to_stop)
    if from_stop_obj is None or to_stop_obj is None:
        return 0.0
    return _estimate_street_m(from_stop_obj.lat, from_stop_obj.lng, to_stop_obj.lat, to_stop_obj.lng)


# ---------------------------------------------------------------------------
# Itinerary reconstruction
# ---------------------------------------------------------------------------


def _reconstruct_legs(
    feed: GtfsFeed,
    best: dict[str, _Label],
    destination_stop: str,
) -> list[tuple[str, str, _Label]]:
    """Walk the label chain from ``destination_stop`` back to the origin.

    Returns ``[(prev_stop, stop, label)]`` in travel order.  The chain is
    acyclic because arrival times strictly increase along ``prev_stop`` links.
    """
    chain: list[tuple[str, str, _Label]] = []
    current = destination_stop
    while current is not None:
        label = best.get(current)
        if label is None:
            break
        prev = label.prev_stop
        if prev is None:
            break
        chain.append((prev, current, label))
        current = prev
    chain.reverse()
    return chain


def _bus_distance_m(feed: GtfsFeed, trip_id: str, board_stop: str, alight_stop: str) -> float:
    """Cumulative straight-line distance between consecutive trip stops from
    the boarding stop to the alighting stop (metres)."""
    stop_times = feed.stop_times.get(trip_id, [])
    stops = [feed.stops.get(st.stop_id) for st in stop_times]
    start = end = None
    for index, st in enumerate(stop_times):
        if st.stop_id == board_stop:
            start = index
        if st.stop_id == alight_stop:
            end = index
    if start is None or end is None or end <= start:
        return 0.0
    distance = 0.0
    for index in range(start, end):
        a, b = stops[index], stops[index + 1]
        if a is None or b is None:
            continue
        distance += _haversine_m(a.lat, a.lng, b.lat, b.lng)
    return distance


def _legs_from_chain(
    feed: GtfsFeed, best: dict[str, _Label], chain: list[tuple[str, str, _Label]]
) -> list[Leg]:
    """Build frontend-facing Leg objects from a reconstructed label chain."""
    legs: list[Leg] = []
    for prev_stop, stop_id, label in chain:
        prev_label = best.get(prev_stop)
        prev_arrival = prev_label.arrival if prev_label is not None else label.walk_start
        to_stop = feed.stops.get(stop_id)
        if label.kind == "walk":
            from_stop = feed.stops.get(prev_stop)
            if to_stop is None or from_stop is None:
                continue
            legs.append(
                Leg(
                    mode="WALK",
                    from_point=Point.from_stop(from_stop),
                    to_point=Point.from_stop(to_stop),
                    duration_minutes=round((label.arrival - prev_arrival) / 60.0),
                    distance_m=label.walk_distance,
                    start_time=_format_time(prev_arrival),
                    end_time=_format_time(label.arrival),
                    walk_estimate=label.walk_estimate,
                )
            )
            continue
        # bus leg
        if to_stop is None or label.board_stop is None:
            continue
        trip = feed.trips.get(label.trip_id or "")
        route = feed.routes.get(trip.route_id) if trip is not None else None
        board_stop = feed.stops.get(label.board_stop)
        if trip is None or route is None or board_stop is None:
            continue
        duration = round((label.arrival - label.board_time) / 60.0)
        legs.append(
            Leg(
                mode="BUS",
                from_point=Point.from_stop(board_stop),
                to_point=Point.from_stop(to_stop),
                duration_minutes=max(0, duration),
                distance_m=_bus_distance_m(feed, label.trip_id or "", label.board_stop or "", stop_id),
                start_time=_format_time(label.board_time),
                end_time=_format_time(label.arrival),
                route=RouteInfo(
                    id=route.route_id,
                    short_name=route.short_name,
                    color=route.color or None,
                ),
                headsign=trip.headsign or None,
                trip_id=label.trip_id,
            )
        )
    return legs


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def plan_trip(
    feed: GtfsFeed,
    walk_graph: WalkGraph | None,
    origin: dict | object,
    destination: dict | object,
    date: datetime.date | str,
    departure_time: str = "00:00",
    max_itineraries: int = 3,
) -> list[Itinerary]:
    """Plan trips from ``origin`` to ``destination`` over ``feed``.

    ``origin``/``destination`` are dicts (or objects) with a ``stop_id`` key OR
    ``lat``/``lng`` keys.  A ``stop_id`` pins the point to that stop (no access
    walk); ``lat``/``lng`` snaps to the nearest stops and pads the itinerary
    with WALK access/egress legs.

    Returns up to ``max_itineraries`` (default 3) deterministic alternatives
    ordered by total duration.  Returns ``[]`` when no route exists — never
    raises.  ``walk_graph`` may be ``None`` (degraded mode); walking then uses a
    haversine straight-line estimate labelled ``walk_estimate`` in the legs.
    """
    origin_stop, origin_walk = _resolve_point(feed, walk_graph, origin)
    destination_stop, destination_walk = _resolve_point(feed, walk_graph, destination)
    if origin_stop is None or destination_stop is None or origin_stop == destination_stop:
        return []

    active_routes = _active_trips_by_route(feed, date)
    if not active_routes:
        return []
    departure_seconds = _parse_time(departure_time)

    walk_neighbors = _walk_neighbors_map(walk_graph) if walk_graph is not None else None
    haversine_cache: dict[str, list[tuple[str, float]]] = {}

    # With an access walk the user effectively reaches the boarding stop after
    # walking, so the RAPTOR search starts there at that later time.
    raptor_departure = departure_seconds
    origin_leg = None
    if origin_walk is not None:
        origin_leg = origin_walk.access_leg(departure_seconds)
        raptor_departure = departure_seconds + origin_walk.walk_seconds()

    itineraries: list[Itinerary] = []
    banned_first_routes: set[str] = set()
    for _ in range(max_itineraries):
        best = _run_raptor(
            feed,
            walk_graph,
            active_routes,
            origin_stop,
            destination_stop,
            raptor_departure,
            banned_first_routes,
            walk_neighbors,
            haversine_cache,
        )
        if best is None:
            break
        chain = _reconstruct_legs(feed, best, destination_stop)
        if not chain:
            break
        legs = _legs_from_chain(feed, best, chain)
        if not legs:
            break
        if origin_leg is not None:
            legs.insert(0, origin_leg)
        arrival_seconds = best[destination_stop].arrival
        if destination_walk is not None:
            egress = _egress_leg(destination_walk, arrival_seconds)
            legs.append(egress)
            arrival_seconds += destination_walk.walk_seconds()
        itineraries.append(Itinerary.build(legs, departure_seconds, arrival_seconds))

        first_bus = next((leg for leg in legs if leg.mode == "BUS"), None)
        if first_bus is None or first_bus.route is None:
            break
        banned_first_routes.add(first_bus.route.id)

    itineraries.sort(key=lambda it: (it.total_minutes, _itinerary_signature(it)))
    return itineraries


def _itinerary_signature(itinerary: Itinerary) -> tuple:
    """Deterministic tie-break for equal-total itineraries."""
    return tuple(
        (leg.mode, leg.from_point.stop_id, leg.to_point.stop_id, leg.trip_id)
        for leg in itinerary.legs
    )


def _resolve_point(
    feed: GtfsFeed,
    walk_graph: WalkGraph | None,
    point: object,
) -> tuple[str | None, "AccessWalk | None"]:
    """Normalize an origin/destination to ``(stop_id, access_walk)``.

    ``AccessWalk`` carries the coordinate snap needed to build a WALK
    access/egress leg; it is ``None`` when the point is a stop itself or when
    no stop is within snapping range (caller treats that as "no route").
    """
    if isinstance(point, dict):
        data: dict = dict(point)
    else:
        data = {
            "stop_id": getattr(point, "stop_id", None),
            "lat": getattr(point, "lat", None),
            "lng": getattr(point, "lng", None),
        }
    stop_id = data.get("stop_id")
    if stop_id is not None and stop_id != "":
        stop = feed.stops.get(stop_id)
        if stop is None:
            return None, None
        return stop.stop_id, None

    lat = data.get("lat")
    lng = data.get("lng")
    if lat is None or lng is None:
        return None, None
    lat = float(lat)
    lng = float(lng)

    if walk_graph is not None:
        snapped = walk_graph.nearest_stops(feed, lat, lng, limit=1)
    else:
        snapped = _snap_nearest_stops(feed, lat, lng, limit=1)
    if not snapped:
        return None, None
    stop, straight_distance = snapped[0]
    return stop.stop_id, AccessWalk(stop=stop, lat=lat, lng=lng, straight_distance_m=straight_distance)


@dataclass(frozen=True)
class AccessWalk:
    """Coordinate snap used to build a WALK access/egress leg."""

    stop: GtfsStop
    lat: float
    lng: float
    straight_distance_m: float

    def street_distance_m(self) -> float:
        return self.straight_distance_m * WALK_PENALTY_FACTOR

    def walk_seconds(self) -> int:
        return round(_estimate_walk_seconds(self.street_distance_m()))

    def access_leg(self, start_seconds: int) -> "Leg":
        """WALK leg from the raw coordinate to the snapped stop."""
        seconds = self.walk_seconds()
        return Leg(
            mode="WALK",
            from_point=Point.from_coordinate(self.lat, self.lng),
            to_point=Point.from_stop(self.stop),
            duration_minutes=max(1, round(seconds / 60.0)),
            distance_m=self.street_distance_m(),
            start_time=_format_time(start_seconds),
            end_time=_format_time(start_seconds + seconds),
            walk_estimate=True,
        )


def _egress_leg(snap: AccessWalk, arrival_seconds: int) -> "Leg":
    """WALK leg from the destination stop to the raw coordinate."""
    seconds = snap.walk_seconds()
    return Leg(
        mode="WALK",
        from_point=Point.from_stop(snap.stop),
        to_point=Point.from_coordinate(snap.lat, snap.lng),
        duration_minutes=max(1, round(seconds / 60.0)),
        distance_m=snap.street_distance_m(),
        start_time=_format_time(arrival_seconds),
        end_time=_format_time(arrival_seconds + seconds),
        walk_estimate=True,
    )


def itinerary_to_dict(itinerary: "Itinerary") -> dict:
    """Serialize an :class:`Itinerary` to the exact frontend plan contract.

    Shapes (from ``frontend/src/PlannerPage.tsx``):

    * Point: ``{"stop_id"?: string, "name": string, "lat": number, "lng": number}``
    * Route: ``{"id": string, "short_name": string, "color"?: string}``
    * Leg: ``{"mode": "WALK"|"BUS", "from": Point, "to": Point,
      "start_time"?: "HH:MM", "end_time"?: "HH:MM", "duration_minutes": number,
      "distance_m": number, "route"?: Route, "headsign"?: string,
      "trip_id"?: string}``
    * Itinerary: ``{"legs": Leg[], "transfers": number,
      "walk_distance_m": number, "walk_minutes"?: number,
      "waiting_minutes"?: number, "total_minutes": number}``

    ``walk_estimate`` is added to WALK legs whose distance came from the
    haversine estimate (optional extra key; the frontend type guard tolerates
    it and the fields above remain stable).
    """
    return {
        "legs": [_leg_to_dict(leg) for leg in itinerary.legs],
        "transfers": itinerary.transfers,
        "walk_distance_m": itinerary.walk_distance_m,
        "walk_minutes": itinerary.walk_minutes,
        "waiting_minutes": itinerary.waiting_minutes,
        "total_minutes": itinerary.total_minutes,
    }


def _leg_to_dict(leg: "Leg") -> dict:
    """Serialize one leg to the frontend contract (optional keys omitted)."""
    payload: dict = {
        "mode": leg.mode,
        "from": _point_to_dict(leg.from_point),
        "to": _point_to_dict(leg.to_point),
        "duration_minutes": leg.duration_minutes,
        "distance_m": leg.distance_m,
    }
    if leg.start_time is not None:
        payload["start_time"] = leg.start_time
    if leg.end_time is not None:
        payload["end_time"] = leg.end_time
    if leg.route is not None:
        route: dict = {"id": leg.route.id, "short_name": leg.route.short_name}
        if leg.route.color:
            route["color"] = leg.route.color
        payload["route"] = route
    if leg.headsign is not None:
        payload["headsign"] = leg.headsign
    if leg.trip_id is not None:
        payload["trip_id"] = leg.trip_id
    if leg.walk_estimate:
        payload["walk_estimate"] = True
    return payload


def _point_to_dict(point: "Point") -> dict:
    """Serialize one point to the frontend contract."""
    payload: dict = {
        "name": point.name,
        "lat": point.lat,
        "lng": point.lng,
    }
    if point.stop_id is not None:
        payload["stop_id"] = point.stop_id
    return payload
