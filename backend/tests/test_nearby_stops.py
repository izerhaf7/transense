"""API tests for ``GET /api/gtfs/stops/nearby`` (backend/main.py).

Synthetic feed: a small deterministic network of coordinate-bearing halte,
built directly — no network, no zip.  Tests inject the feed onto
``app.state`` after the lifespan has run (the lifespan resets it to ``None``
at startup), then hit the endpoint.  A separate app with a broken GTFS url
exercises the ``source: "unavailable"`` degradation.
"""

from fastapi.testclient import TestClient

from backend.config import Settings
from backend.gtfs_loader import GtfsFeed, GtfsStop
from backend.main import create_app

# A GTFS url/cache that always fails so the lifespan leaves the feed unset
# regardless of any local ``backend/gtfs_cache.zip``.  The discard port
# refuses instantly, no network needed.
_BROKEN_GTFS_URL = "http://127.0.0.1:9/nonexistent.zip"


def synthetic_feed() -> GtfsFeed:
    """Deterministic coordinate-bearing stops used by the nearby tests.

    User location ``(-6.2000, 106.8000)`` sits exactly on ``s1``, so the
    expected distance ordering is ``s1, s7, s2, s3, s5, s4, s6``.
    """
    stops = {
        "s1": GtfsStop("s1", "Halte Bundaran", -6.2000, 106.8000),
        "s2": GtfsStop("s2", "Halte Karet", -6.2000, 106.8100),
        "s3": GtfsStop("s3", "Halte Sudirman", -6.2100, 106.8100),
        "s4": GtfsStop("s4", "Halte Semanggi", -6.2100, 106.8200),
        "s5": GtfsStop("s5", "Halte Gatot", -6.2000, 106.8200),
        "s6": GtfsStop("s6", "Halte Senayan", -6.2400, 106.8200),
        "s7": GtfsStop("s7", "Halte Sarinah", -6.1950, 106.7950),
    }
    return GtfsFeed(stops=stops)


def app_for(tmp_path, origins: tuple[str, ...] = ("http://localhost:5173",)):
    return create_app(Settings("test", origins, tmp_path / "demo.sqlite3"))


def no_feed_app(tmp_path, origins: tuple[str, ...] = ("http://localhost:5173",)):
    """App whose lifespan never loads a feed (broken GTFS settings)."""
    return create_app(
        Settings(
            "test",
            origins,
            tmp_path / "demo.sqlite3",
            gtfs_url=_BROKEN_GTFS_URL,
            gtfs_cache_path=str(tmp_path / "missing.zip"),
        )
    )


def _inject_feed(app, feed) -> None:
    app.state.gtfs_feed = feed


# ---------------------------------------------------------------------------
# happy path / ordering
# ---------------------------------------------------------------------------


def test_nearby_orders_by_distance_ascending(tmp_path):
    app = app_for(tmp_path)
    with TestClient(app) as client:
        _inject_feed(app, synthetic_feed())
        response = client.get(
            "/api/gtfs/stops/nearby", params={"lat": -6.2000, "lng": 106.8000}
        )
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "gtfs"
    stops = body["stops"]
    assert [s["id"] for s in stops] == ["s1", "s7", "s2", "s3", "s5"]
    for stop in stops:
        assert set(stop) == {"id", "name", "lat", "lng", "distance_km"}
    # The user location is exactly on s1, so it must be distance 0 and first.
    assert stops[0]["id"] == "s1"
    assert stops[0]["distance_km"] == 0.0
    distances = [s["distance_km"] for s in stops]
    assert distances == sorted(distances)


# ---------------------------------------------------------------------------
# required params
# ---------------------------------------------------------------------------


def test_nearby_requires_coordinates(tmp_path):
    app = app_for(tmp_path)
    with TestClient(app) as client:
        _inject_feed(app, synthetic_feed())
        missing_lat = client.get("/api/gtfs/stops/nearby", params={"lng": 106.8000})
        missing_lng = client.get("/api/gtfs/stops/nearby", params={"lat": -6.2000})
        missing_both = client.get("/api/gtfs/stops/nearby")
    assert missing_lat.status_code == 422
    assert missing_lng.status_code == 422
    assert missing_both.status_code == 422


# ---------------------------------------------------------------------------
# limit clamp
# ---------------------------------------------------------------------------


def test_nearby_limit_applies(tmp_path):
    app = app_for(tmp_path)
    with TestClient(app) as client:
        _inject_feed(app, synthetic_feed())
        response = client.get(
            "/api/gtfs/stops/nearby",
            params={"lat": -6.2000, "lng": 106.8000, "limit": 3},
        )
    assert response.status_code == 200
    assert [s["id"] for s in response.json()["stops"]] == ["s1", "s7", "s2"]


def test_nearby_limit_clamped_low_and_high(tmp_path):
    app = app_for(tmp_path)
    with TestClient(app) as client:
        _inject_feed(app, synthetic_feed())
        clamped_low = client.get(
            "/api/gtfs/stops/nearby",
            params={"lat": -6.2000, "lng": 106.8000, "limit": 0},
        )
        clamped_negative = client.get(
            "/api/gtfs/stops/nearby",
            params={"lat": -6.2000, "lng": 106.8000, "limit": -5},
        )
        clamped_high = client.get(
            "/api/gtfs/stops/nearby",
            params={"lat": -6.2000, "lng": 106.8000, "limit": 999},
        )
    # limit <= 0 clamps to 1 (nearest stop).
    assert clamped_low.status_code == 200
    assert clamped_negative.status_code == 200
    assert [s["id"] for s in clamped_low.json()["stops"]] == ["s1"]
    assert [s["id"] for s in clamped_negative.json()["stops"]] == ["s1"]
    # limit clamps to 20; the feed only has 7 stops, so all come back.
    assert clamped_high.status_code == 200
    assert len(clamped_high.json()["stops"]) == 7


# ---------------------------------------------------------------------------
# degradation
# ---------------------------------------------------------------------------


def test_nearby_unavailable_when_feed_not_loaded(tmp_path):
    # Fresh app: the lifespan GTFS download fails offline, so the feed stays
    # None and the endpoint degrades (never an HTTP error).
    app = no_feed_app(tmp_path)
    with TestClient(app) as client:
        response = client.get(
            "/api/gtfs/stops/nearby", params={"lat": -6.2000, "lng": 106.8000}
        )
    assert response.status_code == 200
    assert response.json() == {"stops": [], "source": "unavailable"}
