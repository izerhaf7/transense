"""Rail transit endpoints (KCI / MRT / LRT) over the Commute Data Platform."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...commute import CommuteClient, CommuteError, CommuteFeed, amenity_label, mode_label
from ...rail_positions import mrt_positions
from ..deps import get_commute_feed, get_settings
from ..utils import commute_grouped_to_timetable, commute_line_stations, line_terminus_departures

router = APIRouter(prefix="/api/transit", tags=["transit"])


@router.get("/lines", response_model=None)
async def transit_lines(request: Request) -> dict[str, Any]:
    feed = get_commute_feed(request)
    if feed is None:
        return {"lines": [], "source": "unavailable"}
    lines = [
        {
            "operator": line.operator,
            "operator_name": line.operator_name,
            "code": line.code,
            "name": line.name,
            "color": f"#{line.color}" if line.color and not line.color.startswith("#") else (line.color or "#1677ff"),
            "mode": line.mode,
            "mode_label": mode_label(line.mode),
        }
        for line in feed.lines
    ]
    return {"lines": lines, "source": "commute"}


@router.get("/stations", response_model=None)
async def transit_stations(request: Request) -> dict[str, Any]:
    feed = get_commute_feed(request)
    if feed is None:
        return {"stations": [], "source": "unavailable"}
    stations = [
        {
            "id": s.id,
            "operator": s.operator,
            "code": s.code,
            "name": s.name,
            "lat": s.lat,
            "lng": s.lng,
            "lines": list(s.lines),
        }
        for s in feed.stations.values()
        if s.lat is not None and s.lng is not None
    ]
    return {"stations": stations, "source": "commute"}


@router.get("/line/{operator}/{code}/stations", response_model=None)
async def transit_line_stations(operator: str, code: str, request: Request) -> dict[str, Any]:
    feed = get_commute_feed(request)
    if feed is None:
        raise HTTPException(status_code=503, detail="Commute feed not loaded")
    key = f"{operator}:{code}"
    matching = [line for line in feed.lines if f"{line.operator}:{line.code}" == key]
    if not matching:
        raise HTTPException(status_code=404, detail="line not found")
    line = matching[0]
    ordered = commute_line_stations(request.app, line)
    return {"line": line.code, "name": line.name, "color": line.color, "stations": ordered, "source": "commute"}


@router.get("/stop/{operator}/{code}/info", response_model=None)
async def transit_stop_info(operator: str, code: str, request: Request) -> dict[str, Any]:
    feed = get_commute_feed(request)
    if feed is None:
        raise HTTPException(status_code=503, detail="Commute feed not loaded")
    station = feed.stations.get(f"{operator}-{code}")
    if station is None:
        raise HTTPException(status_code=404, detail="station not found")
    amenities = [
        {"type": a["type"], "label": amenity_label(a["type"]), "text": a.get("text", "")}
        for a in station.amenities
    ]
    return {
        "stop": {
            "id": station.id,
            "name": station.name,
            "operator": station.operator,
            "official_name": station.official_name,
            "lines": list(station.lines),
            "amenities": amenities,
        },
        "source": "commute",
    }


@router.get("/stop/{operator}/{code}/schedule", response_model=None)
async def transit_stop_schedule(operator: str, code: str, request: Request) -> dict[str, Any]:
    feed: CommuteFeed | None = get_commute_feed(request)
    if feed is None:
        raise HTTPException(status_code=503, detail="Commute feed not loaded")
    station = feed.stations.get(f"{operator}-{code}")
    if station is None:
        raise HTTPException(status_code=404, detail="station not found")

    client = CommuteClient(base_url=get_settings(request).commute_api_base)
    try:
        grouped = client.timetable_grouped(operator, code)
    except CommuteError:
        grouped = []

    timetable = commute_grouped_to_timetable(grouped, feed)
    amenities = [
        {"type": a["type"], "label": amenity_label(a["type"]), "text": a.get("text", "")}
        for a in station.amenities
    ]
    return {
        "stop": {
            "id": station.id,
            "name": station.name,
            "operator": station.operator,
            "official_name": station.official_name,
            "lines": list(station.lines),
            "amenities": amenities,
        },
        "timetable": timetable,
        "source": "commute",
    }


@router.get("/lines/geometry", response_model=None)
async def transit_lines_geometry(request: Request) -> dict[str, Any]:
    feed = get_commute_feed(request)
    if feed is None:
        return {"lines": [], "source": "unavailable"}
    rail_geometry: dict[str, list[list[list[float]]]] = getattr(request.app.state, "rail_geometry", {})
    cache: dict[str, list[dict[str, Any]]] | None = getattr(request.app.state, "commute_line_geometry", None)
    if cache is None:
        cache = {}
        request.app.state.commute_line_geometry = cache
    result = []
    for line in feed.lines:
        key = f"{line.operator}:{line.code}"
        color = f"#{line.color}" if line.color and not line.color.startswith("#") else (line.color or "#1677ff")
        segments: list[list[list[float]]] = []
        source = "commute"
        if key in rail_geometry:
            segments = rail_geometry[key]
            source = "ritj-2021"
        else:
            if key not in cache:
                cache[key] = commute_line_stations(request.app, line)
            stations = cache[key]
            coords = [[s["lng"], s["lat"]] for s in stations if s.get("lng") is not None and s.get("lat") is not None]
            if len(coords) >= 2:
                segments = [coords]
        result.append({
            "operator": line.operator,
            "code": line.code,
            "name": line.name,
            "color": color,
            "mode_label": mode_label(line.mode),
            "segments": segments,
            "source": source,
        })
    return {"lines": result, "source": "commute"}


def _cached_departures(request: Request, operator: str, stations: list[dict[str, Any]]) -> list[str]:
    """Departure times from the line terminus station (shared util + cache)."""
    return line_terminus_departures(request.app, operator, stations)


@router.get("/positions", response_model=None)
async def transit_positions(
    request: Request, operator: str = "MRTJ", code: str = "M"
) -> dict[str, Any]:
    """Schedule-based train positions (deterministic reference while waiting).

    Interpolates every departed train from the terminus timetable over the
    rail geometry.  Degrades to ``source: "unavailable"`` (HTTP 200, never a
    500) when the Commute feed, rail geometry, or terminus timetable is
    missing.
    """
    feed = get_commute_feed(request)
    geometry = getattr(request.app.state, "rail_geometry", {}).get(f"{operator}:{code}")
    if feed is None or not geometry:
        return {"source": "unavailable", "trains": []}

    line = next((candidate for candidate in feed.lines if candidate.operator == operator and candidate.code == code), None)
    if line is None:
        return {"source": "unavailable", "trains": []}
    stations = commute_line_stations(request.app, line)
    if not stations:
        return {"source": "unavailable", "trains": []}

    departures = _cached_departures(request, operator, stations)
    trains = mrt_positions(stations, geometry, departures, datetime.now(timezone.utc))
    return {"source": "scheduled", "trains": trains}
