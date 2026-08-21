"""Conversation CRUD."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...conversation import (ConversationError, create_conversation, delete_conversation,
                             list_conversations, update_conversation)
from ..deps import get_store

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


@router.get("", response_model=None)
async def conversations(request: Request) -> dict[str, Any]:
    store = get_store(request)
    if store is None:
        return {"conversations": [], "retention_days": 7}
    return {"conversations": list_conversations(store), "retention_days": 7}


@router.post("", response_model=None)
async def create_conversation_endpoint(request: Request, payload: dict[str, Any]) -> dict[str, Any]:
    store = get_store(request)
    if store is None:
        raise HTTPException(status_code=503, detail="persistence unavailable")
    try:
        return create_conversation(store, payload)
    except ConversationError as error:
        raise HTTPException(status_code=422, detail=str(error))


@router.patch("/{record_id}", response_model=None)
async def update_conversation_endpoint(record_id: str, request: Request, payload: dict[str, Any]) -> dict[str, Any]:
    store = get_store(request)
    if store is None:
        raise HTTPException(status_code=503, detail="persistence unavailable")
    try:
        result = update_conversation(store, record_id, payload)
    except ConversationError as error:
        raise HTTPException(status_code=422, detail=str(error))
    if result is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    return result


@router.delete("/{record_id}", response_model=None)
async def delete_conversation_endpoint(record_id: str, request: Request) -> dict[str, Any]:
    store = get_store(request)
    if store is None or not delete_conversation(store, record_id):
        raise HTTPException(status_code=404, detail="conversation not found")
    return {"id": record_id, "deleted": True}
