"""Schedule-interpolated vehicle positions (Gapeka-style tracker)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Request

from ...vehicle_positions import vehicles_at
from ..deps import get_gtfs_feed

router = APIRouter(prefix="/api", tags=["vehicles"])


@router.get("/vehicle-positions", response_model=None)
async def vehicle_positions(request: Request) -> dict[str, Any]:
    """Deterministic schedule-based positions for all active trips.

    Always HTTP 200: degrades to ``source: "unavailable"`` when the GTFS feed
    is missing, never raises.  The per-trip geometry cache lives on
    ``app.state`` and is rebuilt lazily per trip.
    """
    try:
        feed = get_gtfs_feed(request)
        if feed is None:
            return {"source": "unavailable", "vehicles": []}
        cache = getattr(request.app.state, "vehicle_geometry_cache", None)
        if cache is None:
            cache = {}
            request.app.state.vehicle_geometry_cache = cache
        return vehicles_at(feed, cache, datetime.now(timezone.utc))
    except Exception as exc:
        return {"source": "error", "vehicles": [], "error": str(exc)}
