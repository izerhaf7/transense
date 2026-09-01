from datetime import datetime, timezone

from backend.rail_positions import mrt_positions

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


def test_mrt_positions_sorted_by_progress():
    trains = mrt_positions(STATIONS, GEOMETRY, ["07:00", "07:03"], now_wib(7, 5))
    progresses = [train["progress_pct"] for train in trains]
    assert progresses == sorted(progresses)
    assert len(trains) == 2


def test_mrt_positions_omits_completed_trains():
    # A train that departed long ago has finished the whole line.
    trains = mrt_positions(STATIONS, GEOMETRY, ["06:00"], now_wib(7, 0))
    assert trains == []
