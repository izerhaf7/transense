"""Shared helpers for the HTTP transport layer.

These functions were previously inline in ``main.py``; they live here so the
route modules stay small and each concern is testable in isolation. They are
imported by ``backend.api.routers.*`` only — nothing outside ``api`` depends on
this module.
"""

from __future__ import annotations

import logging
import math
from datetime import date as date_cls, datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException

from ..commute import CommuteClient, CommuteError, CommuteFeed
from ..gtfs_loader import GtfsFeed, service_active_on
from ..persistence import Store
from ..tj_api import RealtimeBus
from ..walk_graph import WalkGraph, load_walk_graph, walk_graph_from_feed

logger = logging.getLogger(__name__)

# Earth radius (km) for haversine distance helpers.
_EARTH_RADIUS_KM = 6371.0


# ---------------------------------------------------------------------------
# Geometry / nearest-stop helpers
# ---------------------------------------------------------------------------


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2
    return _EARTH_RADIUS_KM * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def find_next_stop(feed: GtfsFeed, trip_id: str, bus_lat: float, bus_lng: float) -> dict[str, object] | None:
    trip = feed.trips.get(trip_id)
    if not trip:
        return None
    st_list = sorted(feed.stop_times.get(trip_id, []), key=lambda st: st.stop_sequence)
    if not st_list:
        return None
    candidates: list[tuple[float, str, int]] = []
    for st in st_list:
        stop = feed.stops.get(st.stop_id)
        if stop is None:
            continue
        dist = haversine_km(bus_lat, bus_lng, stop.lat, stop.lng)
        candidates.append((dist, stop.name, st.stop_sequence))
    if not candidates:
        return None
    candidates.sort(key=lambda c: c[0])
    closest_seq = candidates[0][2]
    for d in candidates:
        if d[2] > closest_seq:
            return {"name": d[1], "sequence": d[2]}
    return {"name": candidates[0][1], "sequence": candidates[0][2]}


def find_nearest_stop(feed: GtfsFeed, lat: float, lng: float) -> str | None:
    best_id: str | None = None
    best_dist = float("inf")
    for stop in feed.stops.values():
        dist = haversine_km(lat, lng, stop.lat, stop.lng)
        if dist < best_dist:
            best_dist = dist
            best_id = stop.stop_id
    return best_id


def normalize_short(value: str) -> str:
    return " ".join(value.casefold().split()).strip()


def to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# GTFS feed access helpers (stop/route/trip lookups)
# ---------------------------------------------------------------------------


def route_by_code(feed: GtfsFeed, route_code: str):
    routes = feed.routes_by_short_name.get(normalize_short(route_code), [])
    return routes[0] if routes else None


def stop_route_codes(feed: GtfsFeed, stop_id: str) -> list[str]:
    codes = list(feed.routes_by_stop.get(stop_id, []))
    codes.extend(feed.routes_by_station.get(stop_id, []))
    stop = feed.stops.get(stop_id)
    if stop is not None and stop.parent_station:
        codes.extend(feed.routes_by_station.get(stop.parent_station, []))
    seen: list[str] = []
    for code in codes:
        if code not in seen:
            seen.append(code)
    return seen


def route_serves_stop(feed: GtfsFeed, route_code: str, stop_id: str) -> bool:
    served = feed.routes_by_stop.get(stop_id, [])
    if route_code in served:
        return True
    station_routes = feed.routes_by_station.get(stop_id, [])
    if route_code in station_routes:
        return True
    stop = feed.stops.get(stop_id)
    if stop is not None and stop.parent_station:
        parent_routes = feed.routes_by_station.get(stop.parent_station, [])
        if route_code in parent_routes:
            return True
    return False


def headsign_for_bus(feed: GtfsFeed, trip_id: str, route_code: str) -> str:
    trip = feed.trips.get(trip_id)
    if trip and trip.headsign:
        return trip.headsign
    routes = feed.routes_by_short_name.get(normalize_short(route_code), [])
    if routes and routes[0].long_name:
        return routes[0].long_name
    return route_code


def stop_platform_ids(feed: GtfsFeed, stop_id: str) -> set[str]:
    stop = feed.stops.get(stop_id)
    if stop is None:
        return {stop_id}
    if stop.location_type == "1" or not stop.parent_station:
        station_id = stop.stop_id
    else:
        station_id = stop.parent_station
    platform_ids = {station_id}
    for sid, s in feed.stops.items():
        if s.parent_station == station_id:
            platform_ids.add(sid)
    return platform_ids


def route_station_stops(feed: GtfsFeed, route_id: str) -> list[dict[str, Any]]:
    stop_ids = feed.stop_ids_by_route.get(route_id, [])
    ordered: list[dict[str, Any]] = []
    seen: set[str] = set()
    for sid in stop_ids:
        s = feed.stops.get(sid)
        if s is None:
            continue
        station_id = s.stop_id if (s.location_type == "1" or not s.parent_station) else s.parent_station
        if not station_id or station_id in seen:
            continue
        station = feed.stops.get(station_id)
        seen.add(station_id)
        ordered.append({
            "id": station_id,
            "name": station.name if station else station_id,
            "lat": station.lat if station else s.lat,
            "lng": station.lng if station else s.lng,
        })
    return ordered


def stop_timetable(feed: GtfsFeed, stop_id: str, date: date_cls) -> list[dict[str, Any]]:
    platform_ids = stop_platform_ids(feed, stop_id)
    grouped: dict[tuple[str, str, str], list[str]] = {}
    for trip_id, stop_times in feed.stop_times.items():
        trip = feed.trips.get(trip_id)
        if trip is None:
            continue
        if trip.service_id and not service_active_on(feed, trip.service_id, date):
            continue
        route = feed.routes.get(trip.route_id)
        if route is None:
            continue
        for st in stop_times:
            if st.stop_id not in platform_ids:
                continue
            arrival = st.arrival_time[:5]
            if not arrival:
                continue
            key = (route.short_name, trip.headsign, str(trip.direction_id))
            grouped.setdefault(key, []).append(arrival)

    result: list[dict[str, Any]] = []
    for (short_name, headsign, direction), times in grouped.items():
        route = route_by_code(feed, short_name)
        result.append({
            "route_code": short_name,
            "color": f"#{route.color}" if route and route.color else "#1677ff",
            "headsign": headsign,
            "direction": direction,
            "times": sorted(times),
        })
    result.sort(key=lambda r: (r["route_code"], r["headsign"]))
    return result


def bus_eta_to_stop(bus: RealtimeBus, stop_id: str) -> int | None:
    for eta_stop in bus.stops:
        if eta_stop.stop_id == stop_id or eta_stop.parent_stop_id == stop_id:
            return eta_stop.eta_minutes
    return None


# ---------------------------------------------------------------------------
# Commute (rail) helpers
# ---------------------------------------------------------------------------


def commute_line_stations(application: FastAPI, line: Any) -> list[dict[str, Any]]:
    """Ordered station list for a rail line (uses the live line-detail endpoint).

    Falls back to an empty list on any network error — the frontend degrades.
    """
    feed: CommuteFeed | None = getattr(application.state, "commute_feed", None)
    if feed is None:
        return []
    try:
        client = CommuteClient(base_url=getattr(application.state, "settings").commute_api_base)
        detail = client.line_detail(line.operator, line.code)
    except CommuteError:
        return []
    ordered: list[dict[str, Any]] = []
    for segment in detail.get("segments", []) if isinstance(detail.get("segments"), list) else []:
        if not isinstance(segment, dict):
            continue
        for station in segment.get("stations", []) if isinstance(segment.get("stations"), list) else []:
            if not isinstance(station, dict):
                continue
            sid = str(station.get("id") or "")
            name = str(station.get("name") or "")
            if not sid:
                continue
            ref = feed.stations.get(sid)
            ordered.append({
                "id": sid,
                "code": str(station.get("code") or ""),
                "name": name,
                "lat": ref.lat if ref else to_float(station.get("latitude")),
                "lng": ref.lng if ref else to_float(station.get("longitude")),
            })
    return ordered


def commute_grouped_to_timetable(grouped: list[dict[str, Any]], feed: CommuteFeed) -> list[dict[str, Any]]:
    """Map the grouped (compact) departure board onto the GTFS-like timetable shape.

    Each line/direction/destination becomes one group with sorted ``times``.
    """
    result: list[dict[str, Any]] = []
    for line_group in grouped:
        if not isinstance(line_group, dict):
            continue
        line_key = str(line_group.get("line") or "")
        op_code, _, code = line_key.partition(":")
        color = "#1677ff"
        for candidate in feed.lines:
            if candidate.operator == op_code and candidate.code == code:
                color = f"#{candidate.color}" if candidate.color and not candidate.color.startswith("#") else (candidate.color or "#1677ff")
                break
        for entry in line_group.get("timetable", []) if isinstance(line_group.get("timetable"), list) else []:
            if not isinstance(entry, dict):
                continue
            for destination in entry.get("destinations", []) if isinstance(entry.get("destinations"), list) else []:
                if not isinstance(destination, dict):
                    continue
                times: list[str] = []
                for schedule in destination.get("schedules", []) if isinstance(destination.get("schedules"), list) else []:
                    if isinstance(schedule, list) and len(schedule) >= 2:
                        minutes = int(schedule[1])
                        times.append(f"{minutes // 60:02d}:{minutes % 60:02d}")
                    elif isinstance(schedule, dict):
                        dep = str(schedule.get("estimatedDeparture") or "")[:5]
                        if dep:
                            times.append(dep)
                result.append({
                    "route_code": code,
                    "color": color,
                    "headsign": str(destination.get("boundFor") or ""),
                    "direction": str(entry.get("key") or ""),
                    "platform": entry.get("platformCode"),
                    "times": sorted(times),
                })
    result.sort(key=lambda r: (r["route_code"], r["headsign"]))
    return result


def line_terminus_departures(
    application: FastAPI, operator: str, stations: list[dict[str, Any]]
) -> list[str]:
    """Departure times (``HH:MM``) from the first (terminus) station of a rail line.

    Shared by the positions endpoint and the rail planner so both clocks use
    the same timetable source.  Cached on ``app.state`` with a 5-minute TTL;
    returns ``[]`` when the feed/API is unavailable (callers fall back to
    duration estimates).
    """
    state = application.state
    now = datetime.now(timezone.utc).timestamp()
    cache_key = f"{operator}:{stations[0]['id'] if stations else '?'}"
    cached = getattr(state, "transit_departures_cache", None)
    if cached and now - cached[0] < 300 and cached[1] == cache_key:
        return cached[2]
    grouped: list[dict[str, Any]] = []
    feed: CommuteFeed | None = getattr(state, "commute_feed", None)
    if feed is not None and stations:
        try:
            base_url = getattr(getattr(state, "settings", None), "commute_api_base", None)
            if base_url:
                client = CommuteClient(base_url=base_url)
                grouped = client.timetable_grouped(operator, stations[0].get("code") or stations[0]["id"])
        except CommuteError:
            grouped = []
    times: list[str] = []
    for entry in commute_grouped_to_timetable(grouped, feed):
        times.extend(entry.get("times", []))
    times = sorted({str(value).strip() for value in times})
    state.transit_departures_cache = (now, cache_key, times)
    return times


# ---------------------------------------------------------------------------
# Journey planning helpers
# ---------------------------------------------------------------------------


def default_plan_now() -> datetime:
    """Current time in Asia/Jakarta (UTC fallback), rounded down to the minute."""
    try:
        from zoneinfo import ZoneInfo
        now = datetime.now(ZoneInfo("Asia/Jakarta"))
    except Exception:
        now = datetime.now(timezone.utc)
    return now.replace(second=0, microsecond=0)


def resolve_plan_point(stop_id: str | None, lat: float | None, lng: float | None, label: str) -> dict[str, Any]:
    """Normalize a plan origin/destination to the planner's point dict."""
    if stop_id is not None and stop_id != "":
        return {"stop_id": stop_id}
    if lat is not None and lng is not None:
        return {"lat": lat, "lng": lng}
    raise HTTPException(status_code=422, detail=f"{label} requires a stop id or lat/lng coordinates")


def time_bucket_for(hhmm: str | None) -> int:
    """Hour-of-day bucket (``hour // 2``) for stable per-day simulated delays."""
    try:
        hour = int(str(hhmm).split(":", 1)[0])
    except (TypeError, ValueError, IndexError):
        return 0
    return hour // 2


def simulated_delay_minutes(route_id: str, stop_id: str, time_bucket: int) -> int:
    """Deterministic 1-15 minute simulated delay for a BUS leg."""
    import zlib
    key = f"{route_id}|{stop_id}|{time_bucket}".encode("utf-8")
    return 1 + (zlib.crc32(key) % 15)


def enrich_bus_legs_eta(itineraries: list[dict], realtime_available: bool) -> None:
    """Annotate every BUS leg with deterministic ETA fields, in place."""
    for itinerary in itineraries:
        for leg in itinerary.get("legs", []):
            if leg.get("mode") != "BUS":
                continue
            route = leg.get("route") or {}
            route_id = route.get("id")
            stop_id = (leg.get("from") or {}).get("stop_id")
            if not route_id or not stop_id:
                continue
            delay_minutes = simulated_delay_minutes(
                route_id, stop_id, time_bucket_for(leg.get("start_time"))
            )
            leg["delay_minutes"] = delay_minutes
            leg["live_eta_minutes"] = int(leg.get("duration_minutes", 0)) + delay_minutes
            leg["eta_source"] = "realtime" if realtime_available else "simulated"


def active_incidents(store: Store, itineraries: list[dict]) -> list[dict]:
    """Active (``delay``/``diverted``) incident payloads for a plan."""
    route_keys: set[str] = set()
    for itinerary in itineraries:
        for leg in itinerary.get("legs", []):
            if leg.get("mode") != "BUS":
                continue
            route = leg.get("route") or {}
            if route.get("id"):
                route_keys.add(route["id"])
            if route.get("short_name"):
                route_keys.add(route["short_name"])

    active: list[dict] = []
    for record in store.list_records("incident"):
        payload = dict(record.get("payload") or {})
        if payload.get("status") not in {"delay", "diverted"}:
            continue
        payload["affects_route"] = payload.get("route_id") in route_keys
        if not payload.get("id"):
            payload["id"] = record.get("id") or payload.get("event_id") or ""
        active.append(payload)
    active.sort(key=lambda incident: str(incident.get("id", "")))
    active.sort(key=lambda incident: str(incident.get("updated_at", "")), reverse=True)
    return active


def incidents_for_plan(application: FastAPI, itineraries: list[dict]) -> list[dict]:
    """Active incidents for the plan response (``[]`` when no store)."""
    store: Store | None = getattr(application.state, "store", None)
    if store is None:
        return []
    return active_incidents(store, itineraries)


def load_or_build_walk_graph(feed: GtfsFeed) -> WalkGraph | None:
    """Load the cached walk graph for ``feed``, or build one from it.

    Never raises: a failure leaves the plan endpoint degraded to
    ``source: "unavailable"``.
    """
    cache_path = Path(__file__).resolve().parent.parent / "walk_graph_cache.json"
    cached = load_walk_graph(cache_path)
    if cached is not None:
        logger.info("Walk graph loaded from cache: %d edges", len(cached.edges))
        return cached
    try:
        graph = walk_graph_from_feed(feed)
        logger.info("Walk graph built from feed: %d edges", len(graph.edges))
        return graph
    except Exception as exc:
        logger.warning("Walk graph build failed: %s", exc)
        return None


def extract_ocr_text(body: Any) -> str:
    """Best-effort text extraction from a Vision ``images:annotate`` response."""
    try:
        responses = body.get("responses") or []
        first = responses[0] if responses else {}
        annotations = first.get("textAnnotations") or []
        if annotations and annotations[0].get("description"):
            return str(annotations[0]["description"])
        full = first.get("fullTextAnnotation") or {}
        if full.get("text"):
            return str(full["text"])
    except (AttributeError, IndexError, KeyError, TypeError):
        pass
    return ""
