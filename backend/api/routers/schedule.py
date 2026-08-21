"""Static schedule (seed / Commute TJ)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api", tags=["schedule"])


@router.get("/schedule", response_model=None)
async def schedule(request: Request) -> dict[str, Any]:
    result = request.app.state.schedule
    return {"source": result.source, "attribution": result.attribution, "simulated": True, "data": result.data}
