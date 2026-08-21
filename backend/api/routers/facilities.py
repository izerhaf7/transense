"""Accessibility facility stops (Side-by-Side / Daksa)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from ...facilities import get_facility_stop, list_facility_stops, stop_occupancy

router = APIRouter(prefix="/api/facilities", tags=["facilities"])


@router.get("/stops", response_model=None)
async def facility_stops() -> dict[str, Any]:
    try:
        stops = list_facility_stops()
    except Exception:
        return {"stops": [], "source": "unavailable"}
    return {"stops": stops, "source": "facility-seed"}


@router.get("/stops/{stop_id}", response_model=None)
async def facility_stop(stop_id: str) -> dict[str, Any]:
    try:
        stop = get_facility_stop(stop_id)
    except Exception:
        stop = None
    if stop is None:
        raise HTTPException(status_code=404, detail="facility stop not found")
    return {"stop": stop, "source": "facility-seed"}


@router.get("/stops/{stop_id}/occupancy", response_model=None)
async def facility_stop_occupancy(stop_id: str) -> dict[str, Any]:
    try:
        stop = get_facility_stop(stop_id)
    except Exception:
        stop = None
    if stop is None:
        raise HTTPException(status_code=404, detail="facility stop not found")
    return stop_occupancy(stop_id)
