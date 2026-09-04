import math
from datetime import datetime, timezone

import pytest

from backend.rail_positions import _on_route, _point_at_distance, _polyline, mrt_positions

# Two-segment line, ~5 km long in total (lng/lat pairs, GeoJSON order).
GEOMETRY = [[[106.79, -6.29], [106.795, -6.265], [106.80, -6.24]], [[106.80, -6.24], [106.81, -6.215], [106.82, -6.19]]]

STATIONS = [
    {"id": "m1", "code": "M01", "name": "Lebak Bulus", "lat": -6.29, "lng": 106.79},
    {"id": "m2", "code": "M02", "name": "Blok M", "lat": -6.24, "lng": 106.80},
    {"id": "m3", "code": "M03", "name": "Bundaran HI", "lat": -6.19, "lng": 106.82},
]


def now_wib(hour: int, minute: int) -> datetime:
    return datetime(2026, 9, 1, hour - 7, minute, 0, tzinfo=timezone.utc)  # WIB = UTC+7


def test_mrt_positions_empty_on_missing_inputs():
    assert mrt_positions([], [], [], now_wib(7, 0)) == []
    assert mrt_positions(STATIONS, GEOMETRY, [], now_wib(7, 0)) == []


def test_mrt_positions_interpolates_departed_trains_only():
    trains = mrt_positions(STATIONS, GEOMETRY, ["07:00", "07:05"], now_wib(7, 3))
    assert len(trains) == 1  # 07:05 has not departed yet
    train = trains[0]
    assert train["next_station"] is not None
    assert 0.0 < train["progress_pct"] < 100.0
    assert -90.0 < train["lat"] < 90.0
    assert -180.0 < train["lng"] < 180.0


def test_mrt_positions_include_bounded_distance_metadata_on_route():
    trains = mrt_positions(STATIONS, GEOMETRY, ["07:00"], now_wib(7, 3))
    train = trains[0]
    line = _polyline(GEOMETRY)

    assert 0.0 <= train["distance_m"] <= line[-1][2]
    assert train["route_distance_m"] == pytest.approx(line[-1][2], abs=0.001)
    assert train["distance_m"] <= train["route_distance_m"]
    assert _on_route(line, train["distance_m"], (train["lat"], train["lng"]))


def test_polyline_ignores_duplicate_points_and_disconnected_segments():
    line = _polyline([[[106.79, -6.29], [106.79, -6.29], [106.80, -6.29]], [[107.0, -6.0], [107.01, -6.0]]])
    assert len(line) == 2
    assert line[-1][2] > 0


def test_on_route_rejects_points_outside_segment_tolerance():
    line = _polyline([[[106.79, -6.29], [106.80, -6.29]]])
    assert _on_route(line, line[-1][2] / 2, (-6.29, 106.795))
    assert not _on_route(line, line[-1][2] / 2, (-6.28, 106.795))


def test_mrt_positions_sorted_by_progress():
    trains = mrt_positions(STATIONS, GEOMETRY, ["07:00", "07:03"], now_wib(7, 5))
    progresses = [train["progress_pct"] for train in trains]
    assert progresses == sorted(progresses)
    assert len(trains) == 2


def test_mrt_positions_omits_completed_trains():
    # A train that departed long ago has finished the whole line.
    trains = mrt_positions(STATIONS, GEOMETRY, ["06:00"], now_wib(7, 0))
    assert trains == []


# ---------------------------------------------------------------------------
# Integration regression guards — added for merge of MRT + Antar Aku
# ---------------------------------------------------------------------------


def test_on_route_rejects_nonfinite_position():
    """_on_route must return False when position contains NaN or inf."""
    line = _polyline(GEOMETRY)
    assert not _on_route(line, 100.0, (float("nan"), 106.795))
    assert not _on_route(line, 100.0, (-6.29, float("inf")))
    assert not _on_route(line, float("nan"), (-6.29, 106.795))
    assert not _on_route(line, float("inf"), (-6.29, 106.795))


def test_point_at_distance_empty_line_returns_none():
    assert _point_at_distance([], 100.0) is None


def test_point_at_distance_zero_distance_returns_first_point():
    line = _polyline(GEOMETRY)
    point = _point_at_distance(line, 0.0)
    assert point is not None
    assert point == (line[0][0], line[0][1])


def test_point_at_distance_past_end_returns_last_point():
    line = _polyline(GEOMETRY)
    total = line[-1][2]
    point = _point_at_distance(line, total + 9999)
    assert point is not None
    assert point == (line[-1][0], line[-1][1])


def test_point_at_distance_negative_returns_first_point():
    line = _polyline(GEOMETRY)
    point = _point_at_distance(line, -500.0)
    assert point is not None
    assert point == (line[0][0], line[0][1])


def test_mrt_positions_zero_total_distance_yields_no_trains():
    """Degenerate geometry where all points collapse: no trains produced."""
    collapsed = [[[106.80, -6.24], [106.80, -6.24], [106.80, -6.24]]]
    trains = mrt_positions(STATIONS, collapsed, ["07:00"], now_wib(7, 3))
    assert trains == []


def test_mrt_positions_station_missing_coords_skipped():
    """Stations without lat/lng are silently excluded from station offsets."""
    stations_no_coords = [
        {"id": "m1", "code": "M01", "name": "Lebak Bulus"},
        {"id": "m2", "code": "M02", "name": "Blok M", "lat": -6.24, "lng": 106.80},
        {"id": "m3", "code": "M03", "name": "Bundaran HI", "lat": -6.19, "lng": 106.82},
    ]
    trains = mrt_positions(stations_no_coords, GEOMETRY, ["07:00"], now_wib(7, 3))
    # Should still produce a train (station m1 missing coords is skipped, not fatal)
    assert len(trains) == 1
    assert trains[0]["next_station"] == "Blok M"  # nearest station after m1 is m2


def test_mrt_positions_single_point_segment():
    """A single-point geometry segment produces no distance — no trains."""
    single_point = [[[106.80, -6.24]]]
    trains = mrt_positions(STATIONS, single_point, ["07:00"], now_wib(7, 3))
    assert trains == []


def test_mrt_positions_distance_m_never_exceeds_route_distance_m():
    """Regression guard: distance_m <= route_distance_m for every train."""
    trains = mrt_positions(STATIONS, GEOMETRY, ["07:00", "07:01", "07:02"], now_wib(7, 5))
    for train in trains:
        assert train["distance_m"] <= train["route_distance_m"]
        assert 0.0 <= train["progress_pct"] <= 100.0
        assert math.isfinite(train["distance_m"])
        assert math.isfinite(train["route_distance_m"])
