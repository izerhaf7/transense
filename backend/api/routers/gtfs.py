"""GTFS (TransJakarta) data endpoints."""

from __future__ import annotations

from datetime import date as date_cls
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...gtfs_loader import GtfsFeed, stop_type_label
from ...tj_api import TjApiError, TjRealtimeClient
from ..deps import get_gtfs_feed, get_realtime_client, get_settings
from ..utils import (bus_eta_to_stop, haversine_km, headsign_for_bus,
                     route_by_code, route_station_stops, stop_route_codes,
                     stop_timetable)

router = APIRouter(prefix="/api/gtfs", tags=["gtfs"])


@router.get("/status", response_model=None)
async def gtfs_status(request: Request) -> dict[str, Any]:
    feed = get_gtfs_feed(request)
    if feed is not None:
        return {
            "loaded": True,
            "stops": len(feed.stops),
            "routes": len(feed.routes),
            "trips": len(feed.trips),
            "shapes": len(feed.shapes),
            "source": get_settings(request).gtfs_url,
        }
    return {"loaded": False, "error": getattr(request.app.state, "gtfs_error", "not loaded")}


@router.get("/stops", response_model=None)
async def gtfs_stops(request: Request) -> dict[str, Any]:
    feed = get_gtfs_feed(request)
    if feed is None:
        return {"stops": [], "source": "seed"}
    return {
        "stops": [
            {"id": s.stop_id, "name": s.name, "lat": s.lat, "lng": s.lng,
             "location_type": s.location_type, "parent_station": s.parent_station,
             "platform_code": s.platform_code, "wheelchair_boarding": s.wheelchair_boarding}
            for s in feed.stops.values()
        ],
        "source": "gtfs",
    }


@router.get("/stops/search", response_model=None)
async def gtfs_stops_search(request: Request, q: str = "") -> dict[str, Any]:
    feed = get_gtfs_feed(request)
    if feed is None:
        return {"stops": [], "source": "seed"}
    query = q.strip().casefold()
    if not query:
        return {"stops": [], "source": "gtfs"}
    by_name: dict[str, dict[str, object]] = {}
    for s in feed.stops.values():
        if query not in s.name.casefold():
            continue
        key = s.name.strip().casefold()
        entry = {
            "id": s.stop_id,
            "name": s.name,
            "lat": s.lat,
            "lng": s.lng,
            "type": stop_type_label(s),
            "wheelchair_boarding": s.wheelchair_boarding,
        }
        existing = by_name.get(key)
        if existing is None or s.location_type == "1":
            by_name[key] = entry
    matches = sorted(by_name.values(), key=lambda s: str(s["name"]))
    return {"stops": matches[:20], "source": "gtfs"}


@router.get("/stops/nearby", response_model=None)
async def gtfs_stops_nearby(request: Request, lat: float, lng: float, limit: int = 5) -> dict[str, Any]:
    feed = get_gtfs_feed(request)
    if feed is None:
        return {"stops": [], "source": "unavailable"}
    bound = min(max(limit, 1), 20)
    ranked = sorted(
        (
            {
                "id": s.stop_id,
                "name": s.name,
                "lat": s.lat,
                "lng": s.lng,
                "distance_km": round(haversine_km(lat, lng, s.lat, s.lng), 4),
            }
            for s in feed.stops.values()
        ),
        key=lambda item: item["distance_km"],
    )
    return {"stops": ranked[:bound], "source": "gtfs"}


@router.get("/routes", response_model=None)
async def gtfs_routes(request: Request) -> dict[str, Any]:
    feed = get_gtfs_feed(request)
    if feed is None:
        return {"routes": [], "source": "seed"}
    result = []
    for route in feed.routes.values():
        stop_ids = feed.stop_ids_by_route.get(route.route_id, [])
        result.append({
            "id": route.route_id,
            "name": route.short_name,
            "long_name": route.long_name,
            "color": f"#{route.color}" if route.color else "#1677ff",
            "stop_ids": stop_ids,
        })
    return {"routes": result, "source": "gtfs"}


@router.get("/route/{route_id}/stops", response_model=None)
async def gtfs_route_stops(route_id: str, request: Request) -> dict[str, Any]:
    feed = get_gtfs_feed(request)
    if feed is None:
        raise HTTPException(status_code=503, detail="GTFS feed not loaded")
    if route_id not in feed.routes:
        raise HTTPException(status_code=404, detail="route not found")
    stops = route_station_stops(feed, route_id)
    return {"stops": stops, "source": "gtfs"}


@router.get("/route/{route_id}/shape", response_model=None)
async def gtfs_route_shape(route_id: str, request: Request) -> dict[str, Any]:
    feed: GtfsFeed | None = get_gtfs_feed(request)
    if feed is None:
        raise HTTPException(status_code=503, detail="GTFS feed not loaded")
    shape_ids: list[str] = []
    seen_ids: set[str] = set()
    for trip in feed.trips.values():
        if trip.route_id == route_id and trip.shape_id and trip.shape_id not in seen_ids:
            seen_ids.add(trip.shape_id)
            shape_ids.append(trip.shape_id)
    if not shape_ids:
        raise HTTPException(status_code=404, detail="route not found")
    lines: list[list[list[float]]] = []
    seen_geoms: set[tuple[tuple[float, float], ...]] = set()
    for shape_id in shape_ids:
        points = feed.shapes.get(shape_id, [])
        if len(points) < 2:
            continue
        coords = [[pt.lng, pt.lat] for pt in points]
        geom_key = tuple((round(pt.lat, 5), round(pt.lng, 5)) for pt in points)
        if geom_key in seen_geoms:
            continue
        seen_geoms.add(geom_key)
        lines.append(coords)
    return {
        "coordinates": lines[0] if lines else [],
        "lines": lines,
        "source": "gtfs",
    }


@router.get("/stop/{stop_id}/info", response_model=None)
async def gtfs_stop_info(stop_id: str, request: Request) -> dict[str, Any]:
    feed = get_gtfs_feed(request)
    if feed is None:
        raise HTTPException(status_code=503, detail="GTFS feed not loaded")
    stop = feed.stops.get(stop_id)
    if stop is None:
        raise HTTPException(status_code=404, detail="stop not found")

    route_codes = stop_route_codes(feed, stop_id)
    routes_info = []
    for code in route_codes:
        route = route_by_code(feed, code)
        routes_info.append({
            "route_code": code,
            "color": f"#{route.color}" if route and route.color else "#1677ff",
        })

    client: TjRealtimeClient | None = get_realtime_client(request)
    arrivals: list[dict[str, Any]] = []
    if client is not None:
        try:
            buses = client.get_buses(lat=stop.lat, lng=stop.lng, radius_km=3.0)
            for bus in buses:
                eta = bus_eta_to_stop(bus, stop_id)
                if eta is None:
                    continue
                arrivals.append({
                    "bus_id": bus.bus_id,
                    "route_code": bus.route_code,
                    "eta_minutes": eta,
                })
        except TjApiError:
            arrivals = []
    arrivals.sort(key=lambda a: a["eta_minutes"])

    return {
        "stop": {
            "id": stop.stop_id,
            "name": stop.name,
            "lat": stop.lat,
            "lng": stop.lng,
            "location_type": stop.location_type,
            "parent_station": stop.parent_station,
            "platform_code": stop.platform_code,
            "wheelchair_boarding": stop.wheelchair_boarding,
        },
        "routes": routes_info,
        "arrivals": arrivals,
        "source": "gtfs",
    }


@router.get("/stop/{stop_id}/schedule", response_model=None)
async def gtfs_stop_schedule(stop_id: str, request: Request) -> dict[str, Any]:
    feed = get_gtfs_feed(request)
    if feed is None:
        raise HTTPException(status_code=503, detail="GTFS feed not loaded")
    stop = feed.stops.get(stop_id)
    if stop is None:
        raise HTTPException(status_code=404, detail="stop not found")

    today = date_cls.today()
    timetable = stop_timetable(feed, stop_id, today)

    client: TjRealtimeClient | None = get_realtime_client(request)
    live: list[dict[str, Any]] = []
    if client is not None:
        try:
            buses = client.get_buses(lat=stop.lat, lng=stop.lng, radius_km=3.0)
            for bus in buses:
                eta = bus_eta_to_stop(bus, stop_id)
                if eta is None:
                    continue
                live.append({
                    "bus_id": bus.bus_id,
                    "route_code": bus.route_code,
                    "eta_minutes": eta,
                    "headsign": headsign_for_bus(feed, bus.trip_id, bus.route_code) if bus.trip_id else bus.route_code,
                })
        except TjApiError:
            live = []
    live.sort(key=lambda a: a["eta_minutes"])

    return {
        "stop": {
            "id": stop.stop_id,
            "name": stop.name,
            "lat": stop.lat,
            "lng": stop.lng,
            "wheelchair_boarding": stop.wheelchair_boarding,
        },
        "timetable": timetable,
        "live": live,
        "source": "gtfs",
    }
