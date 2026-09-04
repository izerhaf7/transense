"""Journey endpoints: live tracking and RAPTOR trip planning."""

from __future__ import annotations

from datetime import date as date_cls
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...gtfs_loader import GtfsFeed
from ...planner import itinerary_to_dict, plan_trip
from ...rail_planner import plan_intermodal, plan_standalone_rail
from ...tj_api import TjApiError, TjRealtimeClient
from ...walk_graph import WalkGraph
from ..deps import get_gtfs_feed, get_realtime_client, get_settings, get_walk_graph
from ..utils import (default_plan_now, enrich_bus_legs_eta, find_next_stop,
                     haversine_km, incidents_for_plan, resolve_plan_point)

router = APIRouter(prefix="/api/journey", tags=["journey"])


@router.get("/track", response_model=None)
async def journey_track(
    request: Request,
    vehicle_id: str | None = None,
    target_stop_id: str | None = None,
    user_lat: float | None = None,
    user_lng: float | None = None,
) -> dict[str, Any]:
    """Return one live bus, its route stops, and target-stop status."""
    settings = get_settings(request)
    feed: GtfsFeed | None = get_gtfs_feed(request)
    if feed is None or not target_stop_id:
        return {"status": "unavailable", "error": "GTFS or target stop unavailable"}
    target = feed.stops.get(target_stop_id)
    if target is None:
        return {"status": "unavailable", "error": "target stop not found"}

    client: TjRealtimeClient | None = get_realtime_client(request)
    if client is None and settings.realtime_enabled:
        try:
            client = TjRealtimeClient(api_base=settings.realtime_api_base)
            client.authenticate()
            request.app.state.realtime_client = client
        except Exception as exc:
            return {"status": "unavailable", "error": str(exc)}
    if client is None:
        return {"status": "unavailable", "error": "realtime bus tracking disabled"}

    try:
        buses = client.get_buses(
            lat=user_lat if user_lat is not None else settings.realtime_center_lat,
            lng=user_lng if user_lng is not None else settings.realtime_center_lng,
            radius_km=settings.realtime_radius_km,
        )
    except TjApiError as exc:
        return {"status": "unavailable", "error": str(exc)}

    bus = next((b for b in buses if vehicle_id and b.bus_id.casefold() == vehicle_id.casefold()), None)
    if bus is None and user_lat is not None and user_lng is not None:
        bus = min(buses, key=lambda b: haversine_km(user_lat, user_lng, b.lat, b.lng), default=None)
    if bus is None:
        return {"status": "not_found", "error": "vehicle not found in realtime feed"}

    trip = feed.trips.get(bus.trip_id or "")
    if trip is None:
        return {"status": "unavailable", "error": "vehicle trip not found in GTFS", "vehicle_id": bus.bus_id}
    ordered = feed.stop_times.get(trip.trip_id, [])
    target_ids = {target_stop_id}
    target_ids.update(sid for sid, stop in feed.stops.items() if stop.parent_station == target_stop_id)
    target_indexes = [i for i, st in enumerate(ordered) if st.stop_id in target_ids]
    if not target_indexes:
        return {"status": "not_on_route", "vehicle_id": bus.bus_id, "route_code": bus.route_code, "target_stop": {"id": target.stop_id, "name": target.name}}

    nearest_index = min(
        range(len(ordered)),
        key=lambda i: haversine_km(bus.lat, bus.lng, feed.stops[ordered[i].stop_id].lat, feed.stops[ordered[i].stop_id].lng),
    )
    target_index = min((i for i in target_indexes if i >= nearest_index), default=target_indexes[-1])
    distance_km = haversine_km(bus.lat, bus.lng, target.lat, target.lng)
    eta_minutes = max(0, round(distance_km / 0.3))
    status = "arrived" if distance_km < 0.15 else "approaching" if target_index - nearest_index <= 3 else "en_route"
    route_stop_ids = [st.stop_id for st in ordered]
    route_stops = [
        {"id": sid, "name": feed.stops[sid].name, "lat": feed.stops[sid].lat, "lng": feed.stops[sid].lng}
        for sid in route_stop_ids if sid in feed.stops
    ]
    return {
        "status": status,
        "vehicle": {"id": bus.bus_id, "route_code": bus.route_code, "lat": bus.lat, "lng": bus.lng, "observed_at": bus.observed_at.isoformat()},
        "route": {"id": trip.route_id, "name": feed.routes.get(trip.route_id).short_name if feed.routes.get(trip.route_id) else bus.route_code, "headsign": trip.headsign, "stops": route_stops},
        "target_stop": {"id": target.stop_id, "name": target.name, "lat": target.lat, "lng": target.lng},
        "next_stop": find_next_stop(feed, trip.trip_id, bus.lat, bus.lng),
        "eta_minutes": eta_minutes,
    }


@router.get("/plan", response_model=None)
async def journey_plan(
    request: Request,
    from_stop: str | None = None,
    to_stop: str | None = None,
    from_lat: float | None = None,
    from_lng: float | None = None,
    to_lat: float | None = None,
    to_lng: float | None = None,
    date: str | None = None,
    time: str | None = None,
    arrive_by: str | None = None,
    include_eta: bool = False,
) -> dict[str, Any]:
    """Plan up to three transit itineraries from an origin to a destination."""
    feed: GtfsFeed | None = get_gtfs_feed(request)
    walk_graph: WalkGraph | None = get_walk_graph(request)
    if feed is None or walk_graph is None:
        return {"itineraries": [], "source": "unavailable", "incidents": []}

    origin = resolve_plan_point(from_stop, from_lat, from_lng, "origin")
    destination = resolve_plan_point(to_stop, to_lat, to_lng, "destination")

    now = default_plan_now()
    try:
        plan_date: date_cls = now.date() if date is None else date_cls.fromisoformat(date)
    except ValueError:
        raise HTTPException(status_code=422, detail="date must be YYYY-MM-DD")
    plan_time = time if time is not None else now.strftime("%H:%M")

    try:
        itineraries = plan_trip(
            feed,
            walk_graph,
            origin,
            destination,
            plan_date,
            departure_time=plan_time,
            arrive_by=arrive_by,
        )
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    itinerary_dicts = [itinerary_to_dict(it) for it in itineraries]
    # Rail suggestions: standalone WALK->RAIL->WALK plus bus->RAIL->bus chains.
    # Skipped for arrive_by searches: rail legs are duration estimates without
    # clock times, so they cannot honor a "latest departure to arrive by X".
    if arrive_by is None:
        itinerary_dicts.extend(
            plan_standalone_rail(origin, destination, request.app, walk_graph, departure_time=plan_time)
        )
        itinerary_dicts.extend(
            plan_intermodal(origin, destination, request.app, walk_graph, plan_date, plan_time)
        )
    # "Utamakan transportasi umum": rank transit-heavy options ahead of long
    # walking stretches when total times are comparable (soft walk penalty so
    # fast rail options are not demoted by their access walk).
    itinerary_dicts.sort(
        key=lambda it: (it["total_minutes"] or 0) + (it.get("walk_minutes") or 0) * 0.5
    )
    # Keep the alternatives list scannable for the itinerary tabs.
    itinerary_dicts = itinerary_dicts[:8]
    if include_eta:
        enrich_bus_legs_eta(
            itinerary_dicts,
            realtime_available=get_realtime_client(request) is not None,
            buses=getattr(request.app.state, "realtime_buses", None) or [],
        )
    return {
        "itineraries": itinerary_dicts,
        "source": "gtfs",
        "incidents": incidents_for_plan(request.app, itinerary_dicts),
    }
