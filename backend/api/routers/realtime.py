"""Realtime bus endpoints (TJ realtime client)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from ...gtfs_loader import GtfsFeed
from ...tj_api import TjApiError, TjRealtimeClient
from ..deps import get_gtfs_feed, get_realtime_client, get_settings
from ..utils import find_nearest_stop, find_next_stop, haversine_km, headsign_for_bus, route_serves_stop

router = APIRouter(prefix="/api", tags=["realtime"])


def _ensure_realtime_client(request: Request) -> TjRealtimeClient | None:
    """Lazily authenticate the TJ realtime client when realtime is enabled."""
    settings = get_settings(request)
    client: TjRealtimeClient | None = get_realtime_client(request)
    if client is None and settings.realtime_enabled:
        try:
            client = TjRealtimeClient(api_base=settings.realtime_api_base)
            client.authenticate()
            request.app.state.realtime_client = client
            request.app.state.realtime_error = None
        except Exception as exc:
            request.app.state.realtime_error = str(exc)
    return client


@router.get("/buses", response_model=None)
async def realtime_buses(request: Request) -> dict[str, Any]:
    try:
        settings = get_settings(request)
        client = _ensure_realtime_client(request)
        feed: GtfsFeed | None = get_gtfs_feed(request)
        if client is not None:
            try:
                buses = client.get_buses(
                    lat=settings.realtime_center_lat,
                    lng=settings.realtime_center_lng,
                    radius_km=settings.realtime_radius_km,
                )
                request.app.state.realtime_buses = buses
            except TjApiError:
                pass
        enriched: list[dict[str, object]] = []
        for b in getattr(request.app.state, "realtime_buses", []):
            info: dict[str, object] = {
                "id": b.bus_id,
                "route_code": b.route_code,
                "lat": b.lat,
                "lng": b.lng,
                "observed_at": b.observed_at.isoformat(),
            }
            if feed is not None and b.trip_id:
                next_stop = find_next_stop(feed, b.trip_id, b.lat, b.lng)
                if next_stop is not None:
                    info["next_stop"] = next_stop
            enriched.append(info)
        return {
            "buses": enriched,
            "source": "realtime" if client is not None else "unavailable",
            "error": getattr(request.app.state, "realtime_error", None),
        }
    except Exception as exc:
        return {"buses": [], "source": "error", "error": str(exc)}


@router.get("/arrivals", response_model=None)
async def arrivals(request: Request, stop_id: str | None = None, lat: float | None = None, lng: float | None = None) -> dict[str, Any]:
    try:
        feed: GtfsFeed | None = get_gtfs_feed(request)
        if feed is None:
            return {"arrivals": [], "stop": None, "source": "unavailable", "error": "GTFS not loaded"}

        target_stop_id = stop_id
        if target_stop_id is None and lat is not None and lng is not None:
            target_stop_id = find_nearest_stop(feed, lat, lng)
        if target_stop_id is None:
            return {"arrivals": [], "stop": None, "source": "unavailable", "error": "no stop resolved"}

        stop = feed.stops.get(target_stop_id)
        if stop is None:
            return {"arrivals": [], "stop": None, "source": "unavailable", "error": "stop not found"}

        client = _ensure_realtime_client(request)

        buses = []
        if client is not None:
            try:
                buses = client.get_buses(lat=stop.lat, lng=stop.lng, radius_km=5.0)
            except TjApiError:
                buses = []

        arrivals_list: list[dict[str, object]] = []
        for b in buses:
            if not route_serves_stop(feed, b.route_code, target_stop_id):
                continue
            dist_km = haversine_km(b.lat, b.lng, stop.lat, stop.lng)
            eta_minutes = max(1, round(dist_km / 0.3))
            headsign = headsign_for_bus(feed, b.trip_id, b.route_code) if b.trip_id else b.route_code
            arrivals_list.append({
                "bus_id": b.bus_id,
                "route_code": b.route_code,
                "headsign": headsign,
                "eta_minutes": eta_minutes,
                "distance_km": round(dist_km, 2),
            })

        arrivals_list.sort(key=lambda a: int(a["eta_minutes"]))
        return {
            "arrivals": arrivals_list[:20],
            "stop": {"id": stop.stop_id, "name": stop.name, "lat": stop.lat, "lng": stop.lng},
            "source": "realtime" if client is not None else "unavailable",
        }
    except Exception as exc:
        return {"arrivals": [], "stop": None, "source": "error", "error": str(exc)}
