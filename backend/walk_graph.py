"""Walk graph for Transense trip planning.

Builds a radius-limited graph of nearby TransJakarta stop pairs so the RAPTOR
planner (``backend/planner.py``) can model walking access, egress, and transfer
legs.  The graph is *estimated* street distance/time, never claimed to be exact.

Two sources of distance are supported:

* ``"osmnx"`` — real street-network distances, computed **offline** by
  :func:`build_walk_graph` when the optional ``osmnx`` package is importable.
  osmnx is deliberately NOT a runtime dependency; the app only ever reads the
  cached JSON edge list produced offline.
* ``"haversine-estimate"`` — the deterministic fallback: great-circle distance
  multiplied by :data:`WALK_PENALTY_FACTOR` (a street-network circuity estimate).
  Every edge carries a ``method`` label so callers can always tell the two apart.

Edges are emitted as a **directed pair** (``A -> B`` and ``B -> A``, same
distance) so the planner can traverse either direction with a single
``WalkGraph.walk_between`` lookup.  The edge list is sorted deterministically
(by from-stops then to-stops) so the cached JSON is stable across builds.
"""

from __future__ import annotations

import importlib.util
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

from backend.gtfs_loader import GtfsFeed, GtfsStop

__all__ = [
    "METHOD_HAVERSINE",
    "METHOD_OSMNX",
    "WALK_CACHE_VERSION",
    "WALK_PENALTY_FACTOR",
    "WALK_SPEED_MPS",
    "WalkEdge",
    "WalkGraph",
    "build_walk_graph",
    "load_walk_graph",
    "save_walk_graph",
    "walk_graph_from_feed",
]

# Average comfortable walking speed, ~4.5 km/h (the Transit Capacity and
# Quality of Service Manual's default walking speed is 1.25 m/s).
WALK_SPEED_MPS = 1.25
# Straight-line to street-network distance ratio.  Typical urban walking routes
# are ~1.3-1.5x the haversine distance; 1.4 is the commonly cited average.
WALK_PENALTY_FACTOR = 1.4
# Version of the JSON cache format; loaders reject any other version.
WALK_CACHE_VERSION = 1
DEFAULT_RADIUS_KM = 1.0

METHOD_OSMNX = "osmnx"
METHOD_HAVERSINE = "haversine-estimate"

_EARTH_RADIUS_KM = 6371.0088
_DEG_LAT_KM = 110.574  # kilometres per degree of latitude (WGS84 meridian, min value)
_INVALID_COORD_RANGE = (-90.0, 90.0, -180.0, 180.0)


def _haversine_km(lat_a: float, lng_a: float, lat_b: float, lng_b: float) -> float:
    """Great-circle distance in kilometres between two WGS84 coordinates."""
    phi_a, phi_b = math.radians(lat_a), math.radians(lat_b)
    d_phi = math.radians(lat_b - lat_a)
    d_lmb = math.radians(lng_b - lng_a)
    a = (
        math.sin(d_phi / 2.0) ** 2
        + math.cos(phi_a) * math.cos(phi_b) * math.sin(d_lmb / 2.0) ** 2
    )
    return 2.0 * _EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def _stop_id(value: str | GtfsStop) -> str:
    """Normalise a planner-facing stop reference to a ``stop_id`` string."""
    if isinstance(value, str):
        return value
    stop_id = getattr(value, "stop_id", None)
    if isinstance(stop_id, str):
        return stop_id
    return str(value)


def _valid_coords(stop: GtfsStop) -> bool:
    lat, lng = stop.lat, stop.lng
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        return False
    if math.isnan(lat) or math.isnan(lng):
        return False
    lo_lat, hi_lat, lo_lng, hi_lng = _INVALID_COORD_RANGE
    return lo_lat <= lat <= hi_lat and lo_lng <= lng <= hi_lng


def _walk_duration_minutes(distance_m: float) -> float:
    """Minutes to walk ``distance_m`` at :data:`WALK_SPEED_MPS`."""
    return distance_m / (WALK_SPEED_MPS * 60.0)


def _nearby_pairs(
    stops: list[GtfsStop], radius_km: float
) -> list[tuple[GtfsStop, GtfsStop, float]]:
    """All distinct stop pairs with haversine distance strictly < ``radius_km``.

    Returns ``(stop_a, stop_b, haversine_distance_m)``.  Uses a latitude-band
    prefilter (a necessary condition: if |Δlat| >= radius the pair is out of
    range) to avoid an O(n^2) haversine scan on large feeds, then the haversine
    check remains the final arbiter.
    """
    radius_m = radius_km * 1000.0
    lat_window = radius_km / _DEG_LAT_KM
    ordered = sorted(stops, key=lambda stop: (stop.lat, stop.stop_id))
    pairs: list[tuple[GtfsStop, GtfsStop, float]] = []
    for i, stop_a in enumerate(ordered):
        j = i + 1
        while j < len(ordered):
            stop_b = ordered[j]
            if stop_b.lat - stop_a.lat > lat_window:
                break
            dist_km = _haversine_km(stop_a.lat, stop_a.lng, stop_b.lat, stop_b.lng)
            if dist_km < radius_km:
                pairs.append((stop_a, stop_b, dist_km * 1000.0))
            j += 1
    return pairs


def _osmnx_available() -> bool:
    """True when the optional offline OSM stack is importable."""
    return (
        importlib.util.find_spec("osmnx") is not None
        and importlib.util.find_spec("networkx") is not None
    )


def _osmnx_distances(
    stops: list[GtfsStop], radius_km: float
) -> dict[tuple[str, str], float]:
    """Real street-network walking distances (metres) between nearby stops.

    Builds ONE walkable street graph covering the stops' bounding box (plus
    padding) and shortest-paths every nearby pair over it.  Only pairs with a
    connected path are returned; the caller falls back to the haversine estimate
    for anything missing.  Never called at runtime by the app — this is offline
    precompute only (osmnx is not a project dependency).
    """
    nx = importlib.import_module("networkx")  # optional offline dependency
    ox = importlib.import_module("osmnx")  # optional offline dependency

    padding_km = radius_km * 1.5
    lats = [stop.lat for stop in stops]
    lngs = [stop.lng for stop in stops]
    north, south = max(lats) + padding_km, min(lats) - padding_km
    east, west = max(lngs) + padding_km, min(lngs) - padding_km
    graph = ox.graph_from_bbox(north, south, east, west, network_type="walk")

    nearest: dict[str, object] = {}
    for stop in stops:
        node = ox.nearest_nodes(graph, X=[stop.lng], Y=[stop.lat])
        nearest[stop.stop_id] = node[0]

    result: dict[tuple[str, str], float] = {}
    for i, stop_a in enumerate(stops):
        for stop_b in stops[i + 1 :]:
            try:
                length = nx.shortest_path_length(
                    graph, nearest[stop_a.stop_id], nearest[stop_b.stop_id], weight="length"
                )
            except (nx.NetworkXNoPath, nx.NetworkXError):
                continue
            result[(stop_a.stop_id, stop_b.stop_id)] = float(length)
    return result


@dataclass(frozen=True)
class WalkEdge:
    """A directed walking leg between two stops.

    ``from_stop``/``to_stop`` are GTFS stop ids.  ``method`` labels how
    ``distance_m`` was obtained: ``"osmnx"`` (real street network, offline) or
    ``"haversine-estimate"`` (great-circle * circuity factor).  The latter is an
    estimate and must never be presented as an exact street distance.
    """

    from_stop: str
    to_stop: str
    distance_m: float
    duration_minutes: float
    method: str

    def as_dict(self) -> dict[str, object]:
        """JSON-serialisable payload (``from``/``to`` keys, per cache format)."""
        return {
            "from": self.from_stop,
            "to": self.to_stop,
            "distance_m": self.distance_m,
            "duration_minutes": self.duration_minutes,
            "method": self.method,
        }


@dataclass(frozen=True)
class WalkGraph:
    """Radius-limited walk graph over a GTFS feed's stops.

    ``nodes`` are the sorted stop ids that participate in at least one walk
    edge; ``edges`` is the deterministic, sorted, symmetric edge list
    (``A -> B`` and ``B -> A`` are both present with the same distance).
    ``method`` is the primary build method for the whole graph; each
    :class:`WalkEdge` carries the exact method used for that pair.
    """

    nodes: tuple[str, ...]
    edges: tuple[WalkEdge, ...]
    method: str = METHOD_HAVERSINE
    radius_km: float = DEFAULT_RADIUS_KM
    _by_pair: dict[tuple[str, str], WalkEdge] = field(
        init=False, repr=False, compare=False, default_factory=dict
    )

    def __post_init__(self) -> None:
        lookup: dict[tuple[str, str], WalkEdge] = {}
        for edge in self.edges:
            lookup[(edge.from_stop, edge.to_stop)] = edge
        object.__setattr__(self, "_by_pair", lookup)

    def walk_between(self, stop_a: str | GtfsStop, stop_b: str | GtfsStop) -> WalkEdge | None:
        """Directed walk edge from ``stop_a`` to ``stop_b``, or ``None``.

        Accepts stop ids or :class:`~backend.gtfs_loader.GtfsStop` objects.
        Returns ``None`` when either stop is unknown or no walk connection
        exists between them.
        """
        return self._by_pair.get((_stop_id(stop_a), _stop_id(stop_b)))

    def nearest_stops(
        self,
        feed: GtfsFeed,
        lat: float,
        lng: float,
        radius_km: float = DEFAULT_RADIUS_KM,
        limit: int | None = 3,
    ) -> list[tuple[GtfsStop, float]]:
        """Snap a user coordinate to nearby feed stops, sorted by distance.

        Returns ``[(GtfsStop, distance_m), ...]`` ascending; only stops whose
        haversine distance is ``<= radius_km`` are considered.  ``limit`` caps
        the result (``None`` returns every stop in range).  Distances are
        straight-line, not street-network, and are sorted deterministically
        (distance, then stop id) so equal-distance stops tie-break stably.
        """
        radius_m = radius_km * 1000.0
        results: list[tuple[GtfsStop, float]] = []
        for stop in feed.stops.values():
            if not _valid_coords(stop):
                continue
            dist_m = _haversine_km(lat, lng, stop.lat, stop.lng) * 1000.0
            if dist_m <= radius_m:
                results.append((stop, dist_m))
        results.sort(key=lambda item: (item[1], item[0].stop_id))
        if limit is not None and limit > 0:
            results = results[:limit]
        return results


def _emit_edge(
    stop_a: GtfsStop, stop_b: GtfsStop, distance_m: float, method: str
) -> tuple[WalkEdge, WalkEdge]:
    duration = _walk_duration_minutes(distance_m)
    forward = WalkEdge(stop_a.stop_id, stop_b.stop_id, distance_m, duration, method)
    backward = WalkEdge(stop_b.stop_id, stop_a.stop_id, distance_m, duration, method)
    return forward, backward


def build_walk_graph(feed: GtfsFeed, radius_km: float = DEFAULT_RADIUS_KM) -> WalkGraph:
    """Deterministically build the walk graph for ``feed``.

    Generates every nearby stop pair (haversine < ``radius_km``) as a directed
    edge pair.  When the optional ``osmnx`` package is importable the street
    network is queried (offline) for real distances; otherwise — or for any pair
    the street network cannot connect — the distance is ``haversine *
    WALK_PENALTY_FACTOR`` and the edge is labelled ``"haversine-estimate"``.
    """
    stops = sorted(
        (stop for stop in feed.stops.values() if _valid_coords(stop)),
        key=lambda stop: stop.stop_id,
    )
    if radius_km <= 0 or len(stops) < 2:
        return WalkGraph(nodes=(), edges=(), method=METHOD_HAVERSINE, radius_km=radius_km)

    pairs = _nearby_pairs(stops, radius_km)
    edges: list[WalkEdge] = []
    graph_method = METHOD_HAVERSINE
    osm_distances: dict[tuple[str, str], float] = {}
    if _osmnx_available():
        try:
            osm_distances = _osmnx_distances(stops, radius_km)
            graph_method = METHOD_OSMNX
        except Exception:
            # osmnx is optional and best-effort; never let it break the build.
            osm_distances = {}
            graph_method = METHOD_HAVERSINE

    for stop_a, stop_b, haversine_m in pairs:
        street_m = osm_distances.get((stop_a.stop_id, stop_b.stop_id))
        if street_m is not None:
            distance_m, edge_method = street_m, METHOD_OSMNX
        else:
            distance_m = haversine_m * WALK_PENALTY_FACTOR
            edge_method = METHOD_HAVERSINE
        edges.extend(_emit_edge(stop_a, stop_b, distance_m, edge_method))

    edges.sort(key=lambda edge: (edge.from_stop, edge.to_stop))
    node_ids = sorted({edge.from_stop for edge in edges} | {edge.to_stop for edge in edges})
    return WalkGraph(
        nodes=tuple(node_ids),
        edges=tuple(edges),
        method=graph_method,
        radius_km=radius_km,
    )


def walk_graph_from_feed(feed: GtfsFeed, radius_km: float = DEFAULT_RADIUS_KM) -> WalkGraph:
    """Convenience wrapper: build a :class:`WalkGraph` directly from a ``GtfsFeed``."""
    return build_walk_graph(feed, radius_km=radius_km)


def _edge_from_json(item: object, default_method: str) -> WalkEdge | None:
    """Parse one cache edge entry; ``None`` on any schema violation."""
    if not isinstance(item, dict):
        return None
    raw = cast("dict[str, object]", item)
    from_stop = raw.get("from")
    to_stop = raw.get("to")
    distance_m = raw.get("distance_m")
    duration_minutes = raw.get("duration_minutes")
    if not isinstance(from_stop, str) or not from_stop or not isinstance(to_stop, str) or not to_stop:
        return None
    if not isinstance(distance_m, (int, float)) or isinstance(distance_m, bool):
        return None
    if not isinstance(duration_minutes, (int, float)) or isinstance(duration_minutes, bool):
        return None
    if distance_m < 0 or duration_minutes < 0:
        return None
    method = raw.get("method", default_method)
    if not isinstance(method, str) or not method:
        method = default_method
    return WalkEdge(
        from_stop=from_stop,
        to_stop=to_stop,
        distance_m=float(distance_m),
        duration_minutes=float(duration_minutes),
        method=method,
    )


def save_walk_graph(graph: WalkGraph, path: str | Path) -> Path:
    """Persist ``graph`` as a versioned JSON cache (edge list only).

    The payload is ``{"version", "method", "radius_km", "edges": [...]}`` where
    every edge carries its own ``method`` label.  Runtime callers read this file
    and never need osmnx.
    """
    path = Path(path)
    payload = {
        "version": WALK_CACHE_VERSION,
        "method": graph.method,
        "radius_km": graph.radius_km,
        "edges": [edge.as_dict() for edge in graph.edges],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def load_walk_graph(path: str | Path) -> WalkGraph | None:
    """Load a cached walk graph, or ``None`` when it is missing/invalid.

    Validates the version and every edge's required keys (``from``, ``to``,
    ``distance_m``, ``duration_minutes``); any mismatch returns ``None`` so the
    caller can fall back to building the graph.
    """
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict) or raw.get("version") != WALK_CACHE_VERSION:
        return None
    edges_raw = raw.get("edges")
    if not isinstance(edges_raw, list):
        return None

    top_method = raw.get("method", METHOD_HAVERSINE)
    if not isinstance(top_method, str) or not top_method:
        top_method = METHOD_HAVERSINE
    radius_km = raw.get("radius_km", DEFAULT_RADIUS_KM)
    if not isinstance(radius_km, (int, float)) or isinstance(radius_km, bool) or radius_km <= 0:
        radius_km = DEFAULT_RADIUS_KM

    edges: list[WalkEdge] = []
    for item in edges_raw:
        edge = _edge_from_json(item, top_method)
        if edge is None:
            return None
        edges.append(edge)

    edges.sort(key=lambda edge: (edge.from_stop, edge.to_stop))
    node_ids = sorted({edge.from_stop for edge in edges} | {edge.to_stop for edge in edges})
    return WalkGraph(
        nodes=tuple(node_ids),
        edges=tuple(edges),
        method=top_method,
        radius_km=radius_km,
    )
