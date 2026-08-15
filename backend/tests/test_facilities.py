from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from backend.config import Settings
from backend.facilities import (FACILITY_STOPS, get_facility_stop, list_facility_stops,
                                stop_occupancy)
from backend.main import create_app

FACILITY_KEYS = ("ramp", "lift", "toilet_accessible", "guiding_block", "staffed", "step_free_access")


def app_for(tmp_path: Path, origins: tuple[str, ...] = ("http://localhost:5173",)):
    return create_app(Settings("test", origins, tmp_path / "demo.sqlite3"))


def test_seed_has_three_to_five_stops_with_complete_facilities():
    assert 3 <= len(FACILITY_STOPS) <= 5
    for stop in FACILITY_STOPS:
        assert isinstance(stop.get("id"), str) and stop["id"]
        assert isinstance(stop.get("name"), str) and stop["name"]
        assert isinstance(stop.get("lat"), float)
        assert isinstance(stop.get("lng"), float)
        facilities = stop.get("facilities")
        assert isinstance(facilities, dict)
        for key in FACILITY_KEYS:
            assert key in facilities, f"stop {stop['id']} missing facility {key}"
            assert isinstance(facilities[key], bool), f"stop {stop['id']} facility {key} not bool"


def test_list_facility_stops_is_deterministic_and_returns_copies():
    first = list_facility_stops()
    second = list_facility_stops()
    assert first == second
    assert len(first) == len(FACILITY_STOPS)
    assert first is not FACILITY_STOPS
    assert first[0] is not FACILITY_STOPS[0]
    assert first[0]["facilities"] is not FACILITY_STOPS[0]["facilities"]


def test_get_facility_stop_finds_by_id_and_misses_unknown():
    stop_id = FACILITY_STOPS[0]["id"]
    stop = get_facility_stop(stop_id)
    assert stop is not None
    assert stop["id"] == stop_id
    assert get_facility_stop("does-not-exist") is None


def test_list_facilities_endpoint_returns_seed_source_without_simulated_marker(tmp_path):
    app = app_for(tmp_path)
    with TestClient(app) as client:
        response = client.get("/api/facilities/stops")
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "facility-seed"
    assert 3 <= len(body["stops"]) <= 5
    assert "simulated" not in body


def test_facility_stop_by_valid_id_returns_stop(tmp_path):
    app = app_for(tmp_path)
    stop_id = FACILITY_STOPS[0]["id"]
    with TestClient(app) as client:
        response = client.get(f"/api/facilities/stops/{stop_id}")
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "facility-seed"
    assert body["stop"]["id"] == stop_id
    assert "simulated" not in body


def test_facility_stop_by_invalid_id_returns_404(tmp_path):
    app = app_for(tmp_path)
    with TestClient(app) as client:
        response = client.get("/api/facilities/stops/does-not-exist")
    assert response.status_code == 404
    assert response.json() == {"detail": "facility stop not found"}


def test_stop_occupancy_is_deterministic_within_bucket():
    fixed = datetime(2026, 8, 16, 9, 30, 0, tzinfo=timezone.utc)
    stop_id = FACILITY_STOPS[0]["id"]
    first = stop_occupancy(stop_id, fixed)
    second = stop_occupancy(stop_id, fixed.replace(second=45, microsecond=123456))
    # Same minute bucket -> identical payload (occupancy, spots, updated_at).
    assert first == second


def test_stop_occupancy_values_are_valid_and_unmarked():
    fixed = datetime(2026, 8, 16, 9, 30, 0, tzinfo=timezone.utc)
    seen: set[tuple[str, int]] = set()
    for stop in FACILITY_STOPS:
        for hour in range(0, 24):
            payload = stop_occupancy(stop["id"], fixed.replace(hour=hour))
            assert payload["occupancy"] in {"low", "moderate", "high"}
            assert isinstance(payload["wheelchair_spots_available"], int)
            assert 0 <= payload["wheelchair_spots_available"] <= 5
            assert payload["source"] == "facility-seed"
            assert payload["updated_at"].endswith("Z")
            assert "simulated" not in payload
            seen.add((payload["occupancy"], payload["wheelchair_spots_available"]))
    # Values actually vary across the day, not a constant snapshot.
    assert len(seen) > 1


def test_occupancy_endpoint_returns_deterministic_unmarked_payload(tmp_path):
    app = app_for(tmp_path)
    stop_id = FACILITY_STOPS[0]["id"]
    with TestClient(app) as client:
        first = client.get(f"/api/facilities/stops/{stop_id}/occupancy")
        second = client.get(f"/api/facilities/stops/{stop_id}/occupancy")
    assert first.status_code == 200
    assert first.json() == second.json()
    body = first.json()
    assert body["occupancy"] in {"low", "moderate", "high"}
    assert 0 <= body["wheelchair_spots_available"] <= 5
    assert body["source"] == "facility-seed"
    assert body["updated_at"].endswith("Z")
    assert "simulated" not in body


def test_occupancy_endpoint_unknown_id_returns_404(tmp_path):
    app = app_for(tmp_path)
    with TestClient(app) as client:
        response = client.get("/api/facilities/stops/does-not-exist/occupancy")
    assert response.status_code == 404
    assert response.json() == {"detail": "facility stop not found"}
