"""WebSocket endpoint: deterministic transit simulation + transcription."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect

from ...facilities import get_facility_stop
from ...transit import TransitValidationError, iso_utc, utc_now
from ...transcription import (MockTranscriptionProvider, ProviderConfigurationError,
                              TranscriptionError, TranscriptionResult, create_provider,
                              persist_transcript)

router = APIRouter(prefix="/api", tags=["websocket"])


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    state = websocket.app.state
    origin = websocket.headers.get("origin")
    if origin not in state.settings.allowed_origins:
        await websocket.close(code=1008, reason="origin not allowed")
        return
    await websocket.accept()
    await websocket.send_json({
        "type": "connection.ack",
        "protocol": "transit-demo.v1",
        "state": state.transit.snapshot(),
    })
    transcription_sessions: set[str] = set()
    try:
        while True:
            try:
                message = json.loads(await websocket.receive_text())
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "code": "invalid_json", "message": "message must be valid JSON"})
                continue
            try:
                message_type = message.get("type")
                if message_type == "transit.update":
                    event = state.transit.update(message.get("vehicle_id", ""))
                    await websocket.send_json(event)
                    for notification in state.notifications.on_transit_update(event):
                        await websocket.send_json(notification)
                elif message_type == "transit.reset":
                    reset = state.transit.reset()
                    state.notifications.reset()
                    await websocket.send_json(reset)
                elif message_type in {"journey.subscribe", "journey.start"}:
                    await websocket.send_json(state.notifications.subscribe(state.transit.snapshot(), message))
                elif message_type == "incident.update":
                    incident = state.notifications.incident_event(state.transit.snapshot(), message)
                    store = getattr(state, "store", None)
                    if store is not None:
                        store.add(
                            "incident",
                            incident,
                            datetime.fromisoformat(incident["created_at"].replace("Z", "+00:00")),
                            record_id=incident["event_id"],
                        )
                    await websocket.send_json(incident)
                elif message_type == "journey.off_route":
                    await websocket.send_json(state.notifications.off_route(message))
                elif message_type == "transcription.session.start":
                    source = message.get("source", "conversation_microphone")
                    session_id = message.get("session_id")
                    if source != "conversation_microphone" or "audio_history" in message or "audio" in message:
                        raise TranscriptionError("only person-to-person conversation microphone input is supported")
                    if not isinstance(session_id, str) or not session_id.strip():
                        raise TranscriptionError("session_id must be a non-empty string")
                    transcription_sessions.add(session_id)
                    try:
                        provider = create_provider()
                    except ProviderConfigurationError as error:
                        await websocket.send_json({
                            "type": "transcription.session.error",
                            "code": "provider_configuration",
                            "session_id": session_id,
                            "message": str(error),
                        })
                        continue
                    await websocket.send_json({
                        "type": "transcription.session.started",
                        "session_id": session_id,
                        "source": source,
                        "provider": provider.name,
                        "mode": provider.mode,
                    })
                elif message_type == "transcription.session.stop":
                    session_id = message.get("session_id")
                    if "audio" in message or "audio_history" in message:
                        raise TranscriptionError("raw audio and audio history are not accepted by the persistence boundary")
                    if not isinstance(session_id, str) or session_id not in transcription_sessions:
                        raise TranscriptionError("transcription session is not active")
                    transcription_sessions.remove(session_id)
                    provider = create_provider()
                    try:
                        result = provider.transcribe()
                    except TranscriptionError:
                        result = MockTranscriptionProvider().transcribe()
                    record_id = f"transcript-{session_id}"
                    store = getattr(state, "store", None)
                    if store is None:
                        raise TranscriptionError("transcript persistence is unavailable")
                    created_at = datetime.now(timezone.utc)
                    persist_transcript(store, result, session_id, created_at, record_id)
                    await websocket.send_json({
                        "type": "transcription.result",
                        "id": record_id,
                        "session_id": session_id,
                        "text": result.text,
                        "created_at": created_at.isoformat().replace("+00:00", "Z"),
                        "provider": result.provider,
                        "mode": result.mode,
                        "functional": True,
                    })
                elif message_type == "transcription.save":
                    text = message.get("text", "").strip()
                    session_id = message.get("session_id", "")
                    if not text:
                        raise TranscriptionError("text must be non-empty")
                    if not isinstance(session_id, str) or not session_id.strip():
                        raise TranscriptionError("session_id must be a non-empty string")
                    store = getattr(state, "store", None)
                    if store is None:
                        raise TranscriptionError("transcript persistence is unavailable")
                    record_id = f"transcript-{session_id}-{uuid4().hex[:8]}"
                    created_at = datetime.now(timezone.utc)
                    result = TranscriptionResult(text=text, provider="elevenlabs_scribe", mode="live")
                    persist_transcript(store, result, session_id, created_at, record_id)
                    await websocket.send_json({
                        "type": "transcription.result",
                        "id": record_id,
                        "session_id": session_id,
                        "text": text,
                        "created_at": created_at.isoformat().replace("+00:00", "Z"),
                        "provider": "live",
                        "mode": "live",
                        "functional": True,
                    })
                elif message_type == "ramp.request":
                    stop_id = message.get("stop_id")
                    if not isinstance(stop_id, str) or get_facility_stop(stop_id) is None:
                        await websocket.send_json({
                            "type": "error",
                            "code": "invalid_stop_reference",
                            "message": f"unknown facility stop reference: {stop_id or ''}",
                        })
                        continue
                    await websocket.send_json({
                        "type": "ramp.request.ack",
                        "stop_id": stop_id,
                        "status": "received",
                        "occurred_at": iso_utc(utc_now()),
                    })
                else:
                    await websocket.send_json({"type": "error", "code": "unknown_message", "message": "message type is not supported"})
            except (TransitValidationError, TypeError, AttributeError) as error:
                await websocket.send_json({"type": "error", "code": "invalid_transit_reference", "message": str(error)})
            except TranscriptionError as error:
                await websocket.send_json({"type": "transcription.session.error", "code": "invalid_request", "message": str(error)})
    except WebSocketDisconnect:
        return
