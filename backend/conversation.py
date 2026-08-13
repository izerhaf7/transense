from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from .persistence import DemoStore, parse_timestamp, TimestampValidationError


class ConversationError(ValueError):
    """Raised when a conversation payload cannot be safely handled."""


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_message(message: Any) -> dict[str, Any]:
    if not isinstance(message, dict):
        raise ConversationError("message must be an object")
    sender = message.get("sender")
    text = message.get("text")
    if sender not in ("user", "other"):
        raise ConversationError("message sender must be 'user' or 'other'")
    if not isinstance(text, str) or not text.strip():
        raise ConversationError("message text must be non-empty")
    source = message.get("source", "typed")
    if source not in ("typed", "stt"):
        raise ConversationError("message source must be 'typed' or 'stt'")
    return {
        "id": message.get("id") or f"msg-{uuid4()}",
        "sender": sender,
        "text": text.strip(),
        "timestamp": message.get("timestamp") or _iso_now(),
        "source": source,
    }


def _validate_conversation(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ConversationError("conversation must be an object")
    messages = payload.get("messages", [])
    if not isinstance(messages, list):
        raise ConversationError("messages must be a list")
    return {
        "title": (payload.get("title") or "Percakapan").strip()[:80],
        "messages": [_validate_message(m) for m in messages],
    }


def create_conversation(store: DemoStore, payload: dict[str, Any]) -> dict[str, Any]:
    validated = _validate_conversation(payload)
    record_id = f"conv-{uuid4()}"
    now = datetime.now(timezone.utc)
    full = {
        **validated,
        "created_at": now.isoformat().replace("+00:00", "Z"),
        "updated_at": now.isoformat().replace("+00:00", "Z"),
    }
    store.add("conversation", full, now, record_id=record_id)
    return {"id": record_id, **full}


def update_conversation(store: DemoStore, record_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    existing = _get_conversation(store, record_id)
    if existing is None:
        return None
    validated = _validate_conversation(payload)
    now = datetime.now(timezone.utc)
    full = {
        **validated,
        "created_at": existing["created_at"],
        "updated_at": now.isoformat().replace("+00:00", "Z"),
    }
    store.update_record(record_id, full, now)
    return {"id": record_id, **full}


def delete_conversation(store: DemoStore, record_id: str) -> bool:
    return store.delete_record(record_id)


def list_conversations(store: DemoStore) -> list[dict[str, Any]]:
    rows = store.list_records("conversation")
    result: list[dict[str, Any]] = []
    for row in rows:
        payload = row["payload"]
        if not isinstance(payload, dict):
            continue
        result.append({
            "id": row["id"],
            "title": payload.get("title", "Percakapan"),
            "messages": payload.get("messages", []),
            "created_at": payload.get("created_at", row["created_at"]),
            "updated_at": payload.get("updated_at", row["created_at"]),
        })
    result.sort(key=lambda c: c.get("updated_at", ""), reverse=True)
    return result


def _get_conversation(store: DemoStore, record_id: str) -> dict[str, Any] | None:
    for row in store.list_records("conversation"):
        if row["id"] == record_id:
            payload = row["payload"]
            if isinstance(payload, dict):
                return payload
    return None


def validate_timestamp(value: Any) -> str:
    if not isinstance(value, str):
        raise ConversationError("timestamp must be a string")
    try:
        parse_timestamp(value)
    except TimestampValidationError as error:
        raise ConversationError(str(error)) from error
    return value
