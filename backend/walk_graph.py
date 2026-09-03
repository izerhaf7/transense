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

import html
import importlib.util
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

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


# Grid cell size (degrees, ~6.7 km) for chunked osmnx processing.  A 1 km
# walk radius keeps every nearby pair inside one cell (plus margin), so each
# cell graph can be loaded and routed separately with bounded memory.
OSMNX_CELL_DEG = 0.06
# Extra cell padding (degrees, ~2.8 km) so pairs near cell borders are covered.
OSMNX_CELL_MARGIN_DEG = 0.025
# Stops farther than this from the street graph are not routed (haversine fallback).
OSMNX_SNAP_MAX_M = 750.0


def _cell_key(lat: float, lng: float) -> tuple[int, int]:
    return (math.floor(lat / OSMNX_CELL_DEG), math.floor(lng / OSMNX_CELL_DEG))


def _osmnx_distances(
    stops: list[GtfsStop], radius_km: float, osm_file: str | None = None
) -> dict[tuple[str, str], float]:
    """Real street-network walking distances (metres) between nearby stops.

    With ``osm_file`` the OSM XML extract is bucketed into grid cells and each
    cell graph is loaded and routed separately (bounded memory, progress logged
    to stdout) — a full-city extract stays processable on a small machine.
    Without it, one graph covering the stops' bounding box is fetched from
    Overpass.  Only pairs with a connected path are returned; the caller falls
    back to the haversine estimate for anything missing.  Never called at
    runtime by the app — this is offline precompute only (osmnx is not a
    project dependency).
    """
    if osm_file:
        return _osmnx_distances_chunked(stops, radius_km, osm_file)

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


def _osmnx_distances_chunked(
    stops: list[GtfsStop], radius_km: float, osm_file: str
) -> dict[tuple[str, str], float]:
    """Chunked street-distance routing over a local OSM XML extract.

    Buckets the XML once into per-grid-cell files (cell bbox padded by
    ``OSMNX_CELL_MARGIN_DEG``), then loads and routes each cell graph
    separately so peak memory stays bounded regardless of the extract size.
    Progress is logged to stdout per cell and periodically inside the routing
    loop.  Pairs whose stops fall into different cells, or whose stop cannot be
    snapped within ``OSMNX_SNAP_MAX_M`` of the street graph, are skipped — the
    caller falls back to haversine per edge.
    """
    import shutil
    import tempfile
    import time
    import xml.etree.ElementTree as ET

    nx = importlib.import_module("networkx")  # optional offline dependency
    ox = importlib.import_module("osmnx")  # optional offline dependency

    cell_stops: dict[tuple[int, int], list[GtfsStop]] = {}
    for stop in stops:
        cell_stops.setdefault(_cell_key(stop.lat, stop.lng), []).append(stop)
    if not cell_stops:
        return {}

    workdir = Path(tempfile.mkdtemp(prefix="transense-osmnx-"))
    try:
        writers: dict[tuple[int, int], tuple[Path, Any]] = {}
        margin = OSMNX_CELL_MARGIN_DEG
        for cell in cell_stops:
            path = workdir / f"cell-{cell[0]}-{cell[1]}.osm"
            handle = open(path, "w", encoding="utf-8")
            handle.write('<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6">\n')
            writers[cell] = (path, handle)

        # Single streaming pass: assign every node/way to the cells it belongs to.
        node_cells: dict[str, set[tuple[int, int]]] = {}
        try:
            for _event, elem in ET.iterparse(osm_file, events=("end",)):
                if elem.tag == "node":
                    lat = float(elem.get("lat"))
                    lon = float(elem.get("lon"))
                    cells = {
                        cell for cell in writers
                        if (cell[0] * OSMNX_CELL_DEG - margin <= lat < (cell[0] + 1) * OSMNX_CELL_DEG + margin
                            and cell[1] * OSMNX_CELL_DEG - margin <= lon < (cell[1] + 1) * OSMNX_CELL_DEG + margin)
                    }
                    if cells:
                        node_id = str(elem.get("id"))
                        node_cells[node_id] = cells
                        for cell in cells:
                            writers[cell][1].write(
                                f'  <node id="{node_id}" lat="{lat:.7f}" lon="{lon:.7f}"/>\n'
                            )
                elif elem.tag == "way":
                    tags = {tag.get("k"): tag.get("v") for tag in elem.findall("tag")}
                    if tags.get("highway"):
                        per_cell: dict[tuple[int, int], list[str]] = {}
                        for nd in elem.findall("nd"):
                            ref = nd.get("ref")
                            for cell in node_cells.get(ref, ()):
                                per_cell.setdefault(cell, []).append(ref)
                        for cell, refs in per_cell.items():
                            if len(set(refs)) < 2:
                                continue
                            handle = writers[cell][1]
                            handle.write(f'  <way id="{elem.get("id")}">\n')
                            seen: set[str] = set()
                            for ref in refs:
                                if ref in seen:
                                    continue
                                seen.add(ref)
                                handle.write(f'    <nd ref="{ref}"/>\n')
                            for key, value in tags.items():
                                handle.write(
                                    f'    <tag k="{html.escape(key)}" v="{html.escape(value)}"/>\n'
                                )
                            handle.write("  </way>\n")
                # Only clear node/way: iterparse also yields their children
                # (nd/tag) first, and clearing those would strip the parent's
                # attributes before its own end event.
                if elem.tag in ("node", "way"):
                    elem.clear()
        finally:
            for _path, handle in writers.values():
                handle.write("</osm>\n")
                handle.close()
        node_cells.clear()

        result: dict[tuple[str, str], float] = {}
        for index, (cell, cell_stop_list) in enumerate(cell_stops.items()):
            path = writers[cell][0]
            print(
                f"[osmnx] cell {index + 1}/{len(cell_stops)} {cell}: {len(cell_stop_list)} stops",
                flush=True,
            )
            try:
                graph = ox.graph_from_xml(str(path), simplify=True)
            except Exception as exc:
                print(f"[osmnx]   cell skipped ({exc}); fallback haversine", flush=True)
                continue
            print(
                f"[osmnx]   graph {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges",
                flush=True,
            )

            nearest: dict[str, int] = {}
            snap_ok: dict[str, bool] = {}
            for stop in cell_stop_list:
                node = ox.nearest_nodes(graph, X=[stop.lng], Y=[stop.lat])
                nearest[stop.stop_id] = int(node[0])
                node_y = float(graph.nodes[nearest[stop.stop_id]]["y"])
                node_x = float(graph.nodes[nearest[stop.stop_id]]["x"])
                snap_m = _haversine_km(stop.lat, stop.lng, node_y, node_x) * 1000
                snap_ok[stop.stop_id] = snap_m <= OSMNX_SNAP_MAX_M

            started = time.time()
            pairs_done = 0
            for i, stop_a in enumerate(cell_stop_list):
                for stop_b in cell_stop_list[i + 1 :]:
                    if not snap_ok[stop_a.stop_id] or not snap_ok[stop_b.stop_id]:
                        continue
                    if (
                        _haversine_km(stop_a.lat, stop_a.lng, stop_b.lat, stop_b.lng) * 1000
                        >= radius_km * 1000
                    ):
                        continue
                    try:
                        length = nx.shortest_path_length(
                            graph, nearest[stop_a.stop_id], nearest[stop_b.stop_id], weight="length"
                        )
                    except (nx.NetworkXNoPath, nx.NetworkXError):
                        continue
                    result[(stop_a.stop_id, stop_b.stop_id)] = float(length)
                    pairs_done += 1
                if (i + 1) % 300 == 0:
                    print(
                        f"[osmnx]   {i + 1}/{len(cell_stop_list)} stops, {pairs_done} pairs "
                        f"({time.time() - started:.0f}s)",
                        flush=True,
                    )
            print(f"[osmnx]   cell done: {pairs_done} pairs", flush=True)
        return result
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


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


def build_walk_graph(
    feed: GtfsFeed,
    radius_km: float = DEFAULT_RADIUS_KM,
    osm_file: str | None = None,
    method: str = METHOD_HAVERSINE,
) -> WalkGraph:
    """Deterministically build the walk graph for ``feed``.

    Generates every nearby stop pair (haversine < ``radius_km``) as a directed
    edge pair.  ``method`` picks the distance source:

    * ``"haversine-estimate"`` (default) — great-circle distance scaled by
      :data:`WALK_PENALTY_FACTOR`.  No street network, no external calls: this
      is what the app builds at runtime.
    * ``"osmnx"`` — real street-network distances from a **local** ``osm_file``
      (offline precompute only; requires the optional osmnx + networkx stack).

    Edges a street network cannot connect fall back to the haversine estimate
    (labelled ``"haversine-estimate"``).
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
    if method == METHOD_OSMNX:
        try:
            osm_distances = _osmnx_distances(stops, radius_km, osm_file)
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
