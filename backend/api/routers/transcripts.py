"""Transcript history + pin/unpin."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...transcription import transcript_history
from ..deps import get_store

router = APIRouter(prefix="/api/transcripts", tags=["transcripts"])


@router.get("", response_model=None)
async def transcripts(request: Request) -> dict[str, Any]:
    store = get_store(request)
    if store is None:
        return {"records": [], "retention_days": 7}
    return {"records": transcript_history(store, datetime.now(timezone.utc)), "retention_days": 7}


@router.patch("/{record_id}/pin", response_model=None)
async def pin_transcript(record_id: str, request: Request, payload: dict[str, Any]) -> dict[str, Any]:
    pinned = payload.get("pinned")
    if not isinstance(pinned, bool):
        raise HTTPException(status_code=422, detail="pinned must be a boolean")
    store = get_store(request)
    if store is None or not store.set_pinned(record_id, pinned):
        raise HTTPException(status_code=404, detail="transcript record not found")
    return {"id": record_id, "pinned": pinned}
