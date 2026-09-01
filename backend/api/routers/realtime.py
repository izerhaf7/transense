"""Realtime bus endpoints (TJ realtime client)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Request

from ...gtfs_loader import GtfsFeed
from ...tj_api import RealtimeBus, TjApiError, TjRealtimeClient
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


def _parse_hhmmss(value: str) -> int | None:
    """GTFS ``HH:MM:SS`` clock -> seconds since midnight; ``None`` on garbage."""
    try:
        hours, minutes, seconds = (int(part) for part in value.split(":"))
    except (ValueError, AttributeError):
        return None
    return hours * 3600 + minutes * 60 + seconds


def _operator_eta_minutes(bus: RealtimeBus, target_stop_id: str) -> int | None:
    """Operator-provided ETA (minutes) for ``target_stop_id``, when present."""
    for entry in bus.stops:
        if entry.stop_id == target_stop_id or entry.parent_stop_id == target_stop_id:
            return int(entry.eta_minutes)
    return None


def _scheduled_eta_minutes(feed: GtfsFeed, bus: RealtimeBus, now_utc: datetime) -> int | None:
    """Minutes until the next stop's scheduled arrival (GTFS clock vs now, WIB)."""
    nxt = find_next_stop(feed, bus.trip_id or "", bus.lat, bus.lng)
    if nxt is None:
        return None
    sequence = int(nxt.get("sequence", -1))
    stop_times = sorted(feed.stop_times.get(bus.trip_id or "", []), key=lambda st: st.stop_sequence)
    for st in stop_times:
        if st.stop_sequence < sequence or not st.arrival_time:
            continue
        arrival_s = _parse_hhmmss(st.arrival_time)
        if arrival_s is None:
            continue
        wib = now_utc.astimezone(timezone(timedelta(hours=7)))
        now_s = wib.hour * 3600 + wib.minute * 60 + wib.second
        minutes = (arrival_s - now_s) // 60
        if minutes < 0:
            minutes += 1440  # next day's scheduled run
        if minutes < 0:
            return None
        return max(0, minutes)
    return None


@router.get("/arrivals", response_model=None)
async def arrivals(
    request: Request,
    stop_id: str | None = None,
    lat: float | None = None,
    lng: float | None = None,
    route_code: str | None = None,
) -> dict[str, Any]:
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

        now_utc = datetime.now(timezone.utc)
        arrivals_list: list[dict[str, object]] = []
        for b in buses:
            if not route_serves_stop(feed, b.route_code, target_stop_id):
                continue
            if route_code and b.route_code != route_code:
                continue
            dist_km = haversine_km(b.lat, b.lng, stop.lat, stop.lng)
            headsign = headsign_for_bus(feed, b.trip_id, b.route_code) if b.trip_id else b.route_code

            operator_eta = _operator_eta_minutes(b, target_stop_id)
            if operator_eta is not None:
                eta_minutes, eta_source = max(1, operator_eta), "realtime"
            else:
                distance_eta = max(1, round(dist_km / 0.3))
                scheduled_eta = _scheduled_eta_minutes(feed, b, now_utc) if b.trip_id else None
                if scheduled_eta is not None:
                    # Off-schedule buses (e.g. night service) can project absurd
                    # timetable ETAs; never report worse than the physical
                    # distance estimate.
                    eta_minutes, eta_source = min(scheduled_eta, distance_eta), "scheduled"
                else:
                    eta_minutes, eta_source = distance_eta, "estimated"

            arrivals_list.append({
                "bus_id": b.bus_id,
                "route_code": b.route_code,
                "headsign": headsign,
                "eta_minutes": eta_minutes,
                "eta_source": eta_source,
                "distance_km": round(dist_km, 2),
                "lat": b.lat,
                "lng": b.lng,
            })

        arrivals_list.sort(key=lambda a: int(a["eta_minutes"]))
        return {
            "arrivals": arrivals_list[:20],
            "stop": {"id": stop.stop_id, "name": stop.name, "lat": stop.lat, "lng": stop.lng},
            "source": "realtime" if client is not None else "unavailable",
        }
    except Exception as exc:
        return {"arrivals": [], "stop": None, "source": "error", "error": str(exc)}
