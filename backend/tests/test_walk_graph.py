import json

import pytest

from backend.gtfs_loader import GtfsFeed, GtfsStop
from backend import walk_graph as wg
from backend.walk_graph import (
    METHOD_HAVERSINE,
    METHOD_OSMNX,
    WALK_PENALTY_FACTOR,
    WALK_SPEED_MPS,
    WalkGraph,
    build_walk_graph,
    load_walk_graph,
    save_walk_graph,
    walk_graph_from_feed,
)


def synthetic_feed() -> GtfsFeed:
    """Five stops clustered around (-6.24, 106.80), s4/s5 outside the 1 km radius."""
    stops = [
        GtfsStop("s1", "A", -6.2400, 106.8000),
        GtfsStop("s2", "B", -6.2410, 106.8010),  # ~157 m from s1
        GtfsStop("s3", "C", -6.2450, 106.8050),  # ~784 m from s1
        GtfsStop("s4", "D", -6.2500, 106.8100),  # ~1.57 km from s1 (out of range)
        GtfsStop("s5", "E", -6.2400, 106.8500),  # ~5.5 km from s1 (out of range)
    ]
    return GtfsFeed(stops={stop.stop_id: stop for stop in stops})


def test_build_walk_graph_emits_radius_limited_symmetric_edges():
    feed = synthetic_feed()
    graph = build_walk_graph(feed, radius_km=1.0)

    # 4 nearby pairs -> 8 directed edges, deterministic sorted order.
    assert len(graph.edges) == 8
    assert graph.method == METHOD_HAVERSINE
    pairs = {(edge.from_stop, edge.to_stop) for edge in graph.edges}
    assert pairs == {
        ("s1", "s2"),
        ("s2", "s1"),
        ("s1", "s3"),
        ("s3", "s1"),
        ("s2", "s3"),
        ("s3", "s2"),
        ("s3", "s4"),
        ("s4", "s3"),
    }
    # s5 is never reachable within the radius.
    assert all("s5" not in (edge.from_stop, edge.to_stop) for edge in graph.edges)
    # Every edge is a labelled haversine estimate and symmetric with equal length.
    for edge in graph.edges:
        assert edge.method == METHOD_HAVERSINE
        reverse = graph.walk_between(edge.to_stop, edge.from_stop)
        assert reverse is not None
        assert reverse.distance_m == pytest.approx(edge.distance_m)
        assert reverse.duration_minutes == pytest.approx(edge.duration_minutes)
        assert edge.duration_minutes == pytest.approx(edge.distance_m / (WALK_SPEED_MPS * 60))
        # Estimate equals haversine * circuity factor (never claimed exact).
        expected = wg._haversine_km(
            feed.stops[edge.from_stop].lat,
            feed.stops[edge.from_stop].lng,
            feed.stops[edge.to_stop].lat,
            feed.stops[edge.to_stop].lng,
        ) * 1000.0 * WALK_PENALTY_FACTOR
        assert edge.distance_m == pytest.approx(expected)
    # Determinism: rebuilding produces an identical graph.
    assert build_walk_graph(feed, radius_km=1.0) == graph
    # Nodes are the stops participating in at least one walk edge.
    assert graph.nodes == ("s1", "s2", "s3", "s4")


def test_walk_between_returns_edge_or_none():
    graph = build_walk_graph(synthetic_feed(), radius_km=1.0)

    edge = graph.walk_between("s1", "s2")
    assert edge is not None and edge.distance_m > 0
    assert graph.walk_between("s2", "s1") is not None  # directed pair is symmetric
    # Accepts GtfsStop objects as well as ids.
    stop_a = synthetic_feed().stops["s1"]
    assert graph.walk_between(stop_a, "s3") is not None
    # Unknown stops / out-of-radius pairs have no walk edge.
    assert graph.walk_between("s1", "s5") is None
    assert graph.walk_between("s1", "missing-stop") is None
    assert graph.walk_between("missing-a", "missing-b") is None


def test_nearest_stops_snaps_user_coordinates_sorted_by_distance():
    feed = synthetic_feed()
    graph = build_walk_graph(feed, radius_km=1.0)

    results = graph.nearest_stops(feed, lat=-6.2403, lng=106.8003)
    assert isinstance(results, list)
    assert len(results) == 3  # default limit
    assert all(isinstance(stop, GtfsStop) and isinstance(dist, float) for stop, dist in results)
    # Sorted ascending by distance; s1 is the closest stop to the probe point.
    distances = [dist for _, dist in results]
    assert distances == sorted(distances)
    assert results[0][0].stop_id == "s1"
    assert distances[0] < distances[1]
    # Radius excludes s4 (~1.6 km away) by default.
    assert all(stop.stop_id != "s4" for stop, _ in results)
    # Larger radius and no limit returns every in-range stop deterministically.
    wide = graph.nearest_stops(feed, lat=-6.2403, lng=106.8003, radius_km=2.0, limit=None)
    assert [stop.stop_id for stop, _ in wide] == ["s1", "s2", "s3", "s4"]
    # limit caps the result.
    assert len(graph.nearest_stops(feed, lat=-6.2403, lng=106.8003, limit=1)) == 1


def test_save_load_round_trip(tmp_path):
    graph = build_walk_graph(synthetic_feed(), radius_km=1.0)
    path = tmp_path / "walk_graph_cache.json"

    written = save_walk_graph(graph, path)
    assert written == path and path.exists()

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["version"] == wg.WALK_CACHE_VERSION
    assert payload["method"] == METHOD_HAVERSINE
    assert len(payload["edges"]) == 8
    assert set(payload["edges"][0]) == {"from", "to", "distance_m", "duration_minutes", "method"}

    loaded = load_walk_graph(path)
    assert loaded is not None
    assert loaded == graph
    assert loaded.method == graph.method == METHOD_HAVERSINE
    assert loaded.walk_between("s1", "s2") == graph.walk_between("s1", "s2")
    # Round-trip of an empty graph also works.
    empty_path = tmp_path / "empty.json"
    empty_graph = build_walk_graph(GtfsFeed(), radius_km=1.0)
    save_walk_graph(empty_graph, empty_path)
    assert load_walk_graph(empty_path) == empty_graph


def test_load_walk_graph_rejects_invalid_cache(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text("{not json", encoding="utf-8")
    assert load_walk_graph(path) is None

    path.write_text(json.dumps({"version": 999, "edges": []}), encoding="utf-8")
    assert load_walk_graph(path) is None

    missing_key = {
        "version": wg.WALK_CACHE_VERSION,
        "edges": [{"to": "s2", "distance_m": 100.0, "duration_minutes": 1.3}],
    }
    path.write_text(json.dumps(missing_key), encoding="utf-8")
    assert load_walk_graph(path) is None

    negative = {
        "version": wg.WALK_CACHE_VERSION,
        "edges": [{"from": "s1", "to": "s2", "distance_m": -5.0, "duration_minutes": 1.0}],
    }
    path.write_text(json.dumps(negative), encoding="utf-8")
    assert load_walk_graph(path) is None

    assert load_walk_graph(tmp_path / "does-not-exist.json") is None


def test_osmnx_unavailable_falls_back_to_haversine_estimate(monkeypatch):
    feed = synthetic_feed()

    monkeypatch.setattr(wg, "_osmnx_available", lambda: False)
    graph = build_walk_graph(feed, radius_km=1.0)
    assert graph.method == METHOD_HAVERSINE
    assert graph.edges and all(edge.method == METHOD_HAVERSINE for edge in graph.edges)


def test_osmnx_failure_degrades_to_haversine_estimate(monkeypatch):
    def exploding_osmnx(_stops, _radius_km):
        raise RuntimeError("osmnx unavailable")

    monkeypatch.setattr(wg, "_osmnx_available", lambda: True)
    monkeypatch.setattr(wg, "_osmnx_distances", exploding_osmnx)
    graph = build_walk_graph(synthetic_feed(), radius_km=1.0)
    assert graph.method == METHOD_HAVERSINE
    assert len(graph.edges) == 8
    assert all(edge.method == METHOD_HAVERSINE for edge in graph.edges)


def test_build_walk_graph_ignores_stops_without_valid_coords():
    feed = synthetic_feed()
    feed.stops["broken"] = GtfsStop("broken", "X", float("nan"), 106.8)
    graph = build_walk_graph(feed, radius_km=1.0)
    assert len(graph.edges) == 8
    assert all("broken" not in (edge.from_stop, edge.to_stop) for edge in graph.edges)


def test_radius_parameter_controls_edge_count():
    feed = synthetic_feed()
    wide = build_walk_graph(feed, radius_km=2.0)
    # s4 comes into range, s5 still does not.
    pairs = {(edge.from_stop, edge.to_stop) for edge in wide.edges}
    assert ("s3", "s4") in pairs and ("s1", "s5") not in pairs
    assert len(wide.edges) > 8
    assert wide.radius_km == 2.0


def test_walk_graph_from_feed_is_a_wrapper():
    feed = synthetic_feed()
    assert walk_graph_from_feed(feed, radius_km=1.0) == build_walk_graph(feed, radius_km=1.0)


def test_load_with_osmnx_method_label_preserved(tmp_path):
    path = tmp_path / "osmnx_cache.json"
    path.write_text(
        json.dumps(
            {
                "version": wg.WALK_CACHE_VERSION,
                "method": METHOD_OSMNX,
                "radius_km": 1.0,
                "edges": [
                    {"from": "s1", "to": "s2", "distance_m": 220.0, "duration_minutes": 2.9}
                ],
            }
        ),
        encoding="utf-8",
    )
    loaded = load_walk_graph(path)
    assert loaded is not None
    assert loaded.method == METHOD_OSMNX
    assert loaded.edges[0].method == METHOD_OSMNX
    assert isinstance(loaded, WalkGraph)


def test_build_walk_graph_passes_osm_file_to_osmnx(monkeypatch):
    seen: list[str | None] = []

    def fake_osmnx(_stops, _radius_km, osm_file):
        seen.append(osm_file)
        return {}

    monkeypatch.setattr(wg, "_osmnx_available", lambda: True)
    monkeypatch.setattr(wg, "_osmnx_distances", fake_osmnx)
    graph = build_walk_graph(synthetic_feed(), radius_km=1.0, osm_file="data/osm/jakarta.osm")
    assert seen == ["data/osm/jakarta.osm"]
    assert graph.method == METHOD_OSMNX
