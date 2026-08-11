from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
from typing import Any, cast
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketDisconnect

from .config import Settings
from .persistence import DemoStore
from .notifications import NotificationEngine
from .sources import load_static_schedule
from .transit import TransitSimulator, TransitValidationError
from .transcription import (MockTranscriptionProvider, ProviderConfigurationError, TranscriptionError,
                            TranscriptionResult, create_provider, persist_transcript, transcript_history)


@asynccontextmanager
async def lifespan(app: FastAPI):
    store: DemoStore | None = None
    app.state.store = None
    try:
        store = DemoStore(app.state.settings.database_path)
        app.state.store = store
        store.cleanup(datetime.now(timezone.utc))
        if not store.list_records("incident"):
            seed_incident = app.state.transit.snapshot()["incidents"][0]
            now = datetime.now(timezone.utc)
            store.add(
                "incident",
                {
                    **seed_incident,
                    "cause": "Tidak ada gangguan pada simulasi seed.",
                    "action": "Layanan berjalan sesuai skenario demo.",
                    "instruction": "Tetap lihat pembaruan visual di aplikasi.",
                    "updated_at": now.isoformat().replace("+00:00", "Z"),
                    "simulated": True,
                },
                now,
                record_id=f"seed-{seed_incident['id']}",
            )
        yield
    except Exception as error:
        app.state.persistence_error = str(error)
        yield
    finally:
        if store is not None:
            store.close()


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings or Settings.from_env()
    application = FastAPI(title="Transense Demo Backend", version="1.0.0", lifespan=lifespan)
    application.state.settings = resolved
    application.state.transit = TransitSimulator.create()
    application.state.notifications = NotificationEngine()
    application.state.schedule = load_static_schedule(application.state.transit.snapshot(), resolved.commute_api_url)
    application.add_middleware(cast(Any, CORSMiddleware), allow_origins=list(resolved.allowed_origins), allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

    @application.get("/api/health", response_model=None)
    async def health() -> Response | dict[str, Any]:
        missing = resolved.missing_required()
        persistence = {"available": False, "detail": "not initialized"}
        store: DemoStore | None = getattr(application.state, "store", None)
        if store is not None:
            try:
                store.check_available()
                persistence = {"available": True, "detail": "sqlite available"}
            except Exception as error:
                persistence = {"available": False, "detail": f"sqlite unavailable: {error}"}
        elif hasattr(application.state, "persistence_error"):
            persistence = {"available": False, "detail": f"sqlite unavailable: {application.state.persistence_error}"}
        healthy = not missing and persistence["available"]
        body: dict[str, Any] = {"status": "healthy" if healthy else "unhealthy", "environment": resolved.environment, "persistence": persistence, "transit": {"source": "seed", "state_version": application.state.transit.state_version}}
        if missing:
            body["configuration"] = {"missing": missing}
        if not healthy:
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=503, content=body)
        return body

    @application.get("/api/schedule", response_model=None)
    async def schedule() -> dict[str, Any]:
        result = application.state.schedule
        return {"source": result.source, "attribution": result.attribution, "simulated": True, "data": result.data}

    @application.get("/api/incidents", response_model=None)
    async def incidents() -> dict[str, Any]:
        store: DemoStore | None = getattr(application.state, "store", None)
        if store is None:
            return {"records": [], "retention_days": 7}
        return {"records": store.list_records("incident"), "retention_days": 7}

    @application.patch("/api/incidents/{record_id}/pin", response_model=None)
    async def pin_incident(record_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        pinned = payload.get("pinned")
        if not isinstance(pinned, bool):
            raise HTTPException(status_code=422, detail="pinned must be a boolean")
        store: DemoStore | None = getattr(application.state, "store", None)
        if store is None or not store.set_pinned(record_id, pinned):
            raise HTTPException(status_code=404, detail="incident record not found")
        return {"id": record_id, "pinned": pinned}

    @application.get("/api/transcripts", response_model=None)
    async def transcripts() -> dict[str, Any]:
        store: DemoStore | None = getattr(application.state, "store", None)
        if store is None:
            return {"records": [], "retention_days": 7}
        return {"records": transcript_history(store, datetime.now(timezone.utc)), "retention_days": 7}

    @application.patch("/api/transcripts/{record_id}/pin", response_model=None)
    async def pin_transcript(record_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        pinned = payload.get("pinned")
        if not isinstance(pinned, bool):
            raise HTTPException(status_code=422, detail="pinned must be a boolean")
        store: DemoStore | None = getattr(application.state, "store", None)
        if store is None or not store.set_pinned(record_id, pinned):
            raise HTTPException(status_code=404, detail="transcript record not found")
        return {"id": record_id, "pinned": pinned}

    @application.get("/api/scribe-token", response_model=None)
    async def scribe_token() -> dict[str, Any]:
        api_key = resolved.elevenlabs_api_key
        if not api_key:
            raise HTTPException(status_code=503, detail="ElevenLabs API key not configured")
        try:
            from elevenlabs import ElevenLabs
            client = ElevenLabs(api_key=api_key)
            token = client.tokens.single_use.create("realtime_scribe")
        except Exception as error:
            raise HTTPException(status_code=502, detail=f"ElevenLabs token creation failed: {error}")
        return {"token": getattr(token, "token", str(token))}

    @application.websocket("/api/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        origin = websocket.headers.get("origin")
        if origin not in resolved.allowed_origins:
            await websocket.close(code=1008, reason="origin not allowed")
            return
        await websocket.accept()
        await websocket.send_json({"type": "connection.ack", "protocol": "transit-demo.v1", "state": application.state.transit.snapshot()})
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
                        event = application.state.transit.update(message.get("vehicle_id", ""))
                        await websocket.send_json(event)
                        for notification in application.state.notifications.on_transit_update(event):
                            await websocket.send_json(notification)
                    elif message_type == "transit.reset":
                        reset = application.state.transit.reset()
                        application.state.notifications.reset()
                        await websocket.send_json(reset)
                    elif message_type in {"journey.subscribe", "journey.start"}:
                        await websocket.send_json(application.state.notifications.subscribe(application.state.transit.snapshot(), message))
                    elif message_type == "incident.update":
                        incident = application.state.notifications.incident_event(application.state.transit.snapshot(), message)
                        store = getattr(application.state, "store", None)
                        if store is not None:
                            store.add("incident", incident, datetime.fromisoformat(incident["created_at"].replace("Z", "+00:00")), record_id=incident["event_id"])
                        await websocket.send_json(incident)
                    elif message_type == "journey.off_route":
                        await websocket.send_json(application.state.notifications.off_route(message))
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
                            await websocket.send_json({"type": "transcription.session.error", "code": "provider_configuration", "session_id": session_id, "message": str(error)})
                            continue
                        await websocket.send_json({"type": "transcription.session.started", "session_id": session_id, "source": source, "provider": provider.name, "mode": provider.mode})
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
                        store = getattr(application.state, "store", None)
                        if store is None:
                            raise TranscriptionError("transcript persistence is unavailable")
                        created_at = datetime.now(timezone.utc)
                        persist_transcript(store, result, session_id, created_at, record_id)
                        await websocket.send_json({"type": "transcription.result", "id": record_id, "session_id": session_id, "text": result.text, "created_at": created_at.isoformat().replace("+00:00", "Z"), "provider": result.provider, "mode": result.mode, "functional": True})
                    elif message_type == "transcription.save":
                        text = message.get("text", "").strip()
                        session_id = message.get("session_id", "")
                        if not text:
                            raise TranscriptionError("text must be non-empty")
                        if not isinstance(session_id, str) or not session_id.strip():
                            raise TranscriptionError("session_id must be a non-empty string")
                        store = getattr(application.state, "store", None)
                        if store is None:
                            raise TranscriptionError("transcript persistence is unavailable")
                        record_id = f"transcript-{session_id}-{uuid4().hex[:8]}"
                        created_at = datetime.now(timezone.utc)
                        result = TranscriptionResult(text=text, provider="elevenlabs_scribe", mode="live")
                        persist_transcript(store, result, session_id, created_at, record_id)
                        await websocket.send_json({"type": "transcription.result", "id": record_id, "session_id": session_id, "text": text, "created_at": created_at.isoformat().replace("+00:00", "Z"), "provider": "live", "mode": "live", "functional": True})
                    else:
                        await websocket.send_json({"type": "error", "code": "unknown_message", "message": "message type is not supported"})
                except (TransitValidationError, TypeError, AttributeError) as error:
                    await websocket.send_json({"type": "error", "code": "invalid_transit_reference", "message": str(error)})
                except TranscriptionError as error:
                    await websocket.send_json({"type": "transcription.session.error", "code": "invalid_request", "message": str(error)})
        except WebSocketDisconnect:
            return

    return application


app = create_app()
