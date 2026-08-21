"""Health + configuration status."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response

from ..deps import get_settings, get_store

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health", response_model=None)
async def health(request: Request) -> Response | dict[str, Any]:
    settings = get_settings(request)
    store = get_store(request)
    missing = settings.missing_required()

    persistence = {"available": False, "detail": "not initialized"}
    if store is not None:
        try:
            store.check_available()
            persistence = {"available": True, "detail": "sqlite available"}
        except Exception as error:
            persistence = {"available": False, "detail": f"sqlite unavailable: {error}"}
    elif hasattr(request.app.state, "persistence_error"):
        persistence = {"available": False, "detail": f"sqlite unavailable: {request.app.state.persistence_error}"}

    healthy = not missing and persistence["available"]
    body: dict[str, Any] = {
        "status": "healthy" if healthy else "unhealthy",
        "environment": settings.environment,
        "persistence": persistence,
        "transit": {"source": "seed", "state_version": request.app.state.transit.state_version},
    }
    if missing:
        body["configuration"] = {"missing": missing}
    if not healthy:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=503, content=body)
    return body
