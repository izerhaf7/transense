"""Integration regression tests for rail transit API endpoints.

These tests verify that the `/api/transit/*` endpoints degrade gracefully
when the Commute feed, rail geometry, or ordered stations are missing.
They were added for the MRT + Antar Aku integration merge (task 13).
"""

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.routers import transit as transit_mod


def _app(commute_feed=None, rail_geometry=None):
    """Minimal app with the transit router mounted and no real config."""
    app = FastAPI()
    app.include_router(transit_mod.router)
    app.state.commute_feed = commute_feed
    app.state.rail_geometry = rail_geometry or {}
    app.state.commute_line_geometry = None
    app.state.settings = SimpleNamespace(commute_api_base="https://unused")
    return app


# ---------------------------------------------------------------------------
# /api/transit/lines — unavailable fallback
# ---------------------------------------------------------------------------


def test_transit_lines_returns_unavailable_without_feed():
    with TestClient(_app()) as client:
        resp = client.get("/api/transit/lines")
    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "unavailable"
    assert body["lines"] == []


def test_transit_stations_returns_unavailable_without_feed():
    with TestClient(_app()) as client:
        resp = client.get("/api/transit/stations")
    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "unavailable"
    assert body["stations"] == []


def test_transit_lines_geometry_returns_unavailable_without_feed():
    with TestClient(_app()) as client:
        resp = client.get("/api/transit/lines/geometry")
    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "unavailable"
    assert body["lines"] == []


def test_transit_positions_returns_unavailable_without_feed():
    with TestClient(_app()) as client:
        resp = client.get("/api/transit/positions")
    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "unavailable"
    assert body["trains"] == []


def test_transit_line_stations_returns_503_without_feed():
    with TestClient(_app()) as client:
        resp = client.get("/api/transit/line/MRTJ/M/stations")
    assert resp.status_code == 503


def test_transit_stop_info_returns_503_without_feed():
    with TestClient(_app()) as client:
        resp = client.get("/api/transit/stop/MRTJ/M01/info")
    assert resp.status_code == 503


def test_transit_stop_schedule_returns_503_without_feed():
    with TestClient(_app()) as client:
        resp = client.get("/api/transit/stop/MRTJ/M01/schedule")
    assert resp.status_code == 503


# ---------------------------------------------------------------------------
# /api/transit/positions — unavailable when geometry missing
# ---------------------------------------------------------------------------


def test_transit_positions_returns_unavailable_without_geometry():
    """Feed present but no rail geometry → positions degrade to unavailable."""
    fake_feed = SimpleNamespace(lines=[SimpleNamespace(operator="MRTJ", code="M")])
    with TestClient(_app(commute_feed=fake_feed)) as client:
        resp = client.get("/api/transit/positions")
    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "unavailable"
    assert body["trains"] == []


def test_transit_lines_geometry_uses_ritj_source_for_rail_geometry():
    """When rail_geometry is provided, geometry endpoint uses 'ritj-2021' source."""
    fake_feed = SimpleNamespace(
        lines=[SimpleNamespace(operator="MRTJ", code="M", name="MRT Jakarta", color="AB0000", mode="SUBWAY")]
    )
    geometry = {"MRTJ:M": [[[106.79, -6.29], [106.80, -6.24], [106.82, -6.19]]]}
    with TestClient(_app(commute_feed=fake_feed, rail_geometry=geometry)) as client:
        resp = client.get("/api/transit/lines/geometry")
    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "commute"
    assert len(body["lines"]) == 1
    line = body["lines"][0]
    assert line["source"] == "ritj-2021"
    assert line["operator"] == "MRTJ"
    assert line["code"] == "M"
    assert len(line["segments"]) >= 1
