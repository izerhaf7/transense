from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
import logging
from typing import Any, cast
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketDisconnect

from .config import Settings
from .gtfs_loader import download_gtfs, parse_gtfs, GtfsError, GtfsFeed
from .persistence import DemoStore
from .notifications import NotificationEngine
from .sources import load_static_schedule
from .tj_api import TjRealtimeClient, RealtimeBus, TjApiError
from .transit import TransitSimulator, TransitValidationError
from .transcription import (MockTranscriptionProvider, ProviderConfigurationError, TranscriptionError,
                            TranscriptionResult, create_provider, persist_transcript, transcript_history)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    store: DemoStore | None = None
    app.state.store = None
    app.state.gtfs_feed = None
    app.state.realtime_buses: list[RealtimeBus] = []
    app.state.gtfs_error: str | None = None
    app.state.realtime_error: str | None = None
    app.state.realtime_client: TjRealtimeClient | None = None

    settings: Settings = app.state.settings
    try:
        zip_path = download_gtfs(url=settings.gtfs_url, cache_path=settings.gtfs_cache_path)
        app.state.gtfs_feed = parse_gtfs(zip_path)
        logger.info("GTFS feed loaded: %d stops, %d routes", len(app.state.gtfs_feed.stops), len(app.state.gtfs_feed.routes))
    except Exception as exc:
        app.state.gtfs_error = str(exc)
        logger.warning("GTFS load failed, using seed data: %s", exc)

    if settings.realtime_enabled:
        try:
            app.state.realtime_client = TjRealtimeClient(api_base=settings.realtime_api_base)
            app.state.realtime_client.authenticate()
            logger.info("TJ realtime API authenticated")
        except Exception as exc:
            app.state.realtime_client = None
            app.state.realtime_error = str(exc)
            logger.warning("TJ realtime API not available: %s", exc)
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
        if app.state.realtime_client is not None:
            app.state.realtime_client.close()


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

    @application.get("/api/gtfs/status", response_model=None)
    async def gtfs_status() -> dict[str, Any]:
        feed: GtfsFeed | None = getattr(application.state, "gtfs_feed", None)
        if feed is not None:
            return {
                "loaded": True,
                "stops": len(feed.stops),
                "routes": len(feed.routes),
                "trips": len(feed.trips),
                "shapes": len(feed.shapes),
                "source": resolved.gtfs_url,
            }
        return {"loaded": False, "error": getattr(application.state, "gtfs_error", "not loaded")}

    @application.get("/api/gtfs/stops", response_model=None)
    async def gtfs_stops() -> dict[str, Any]:
        feed: GtfsFeed | None = getattr(application.state, "gtfs_feed", None)
        if feed is None:
            return {"stops": [], "source": "seed"}
        return {
            "stops": [
                {"id": s.stop_id, "name": s.name, "lat": s.lat, "lng": s.lng}
                for s in feed.stops.values()
            ],
            "source": "gtfs",
        }

    @application.get("/api/gtfs/stops/search", response_model=None)
    async def gtfs_stops_search(q: str = "") -> dict[str, Any]:
        feed: GtfsFeed | None = getattr(application.state, "gtfs_feed", None)
        if feed is None:
            return {"stops": [], "source": "seed"}
        query = q.strip().casefold()
        if not query:
            return {"stops": [], "source": "gtfs"}
        matches = [
            {"id": s.stop_id, "name": s.name, "lat": s.lat, "lng": s.lng}
            for s in feed.stops.values()
            if query in s.name.casefold()
        ]
        matches.sort(key=lambda s: s["name"])
        return {"stops": matches[:20], "source": "gtfs"}

    @application.get("/api/gtfs/routes", response_model=None)
    async def gtfs_routes() -> dict[str, Any]:
        feed: GtfsFeed | None = getattr(application.state, "gtfs_feed", None)
        if feed is None:
            return {"routes": [], "source": "seed"}
        result = []
        for route in feed.routes.values():
            stop_ids = feed.stop_ids_by_route.get(route.route_id, [])
            result.append({
                "id": route.route_id,
                "name": route.short_name,
                "long_name": route.long_name,
                "color": f"#{route.color}" if route.color else "#1677ff",
                "stop_ids": stop_ids,
            })
        return {"routes": result, "source": "gtfs"}

    @application.get("/api/gtfs/route/{route_id}/shape", response_model=None)
    async def gtfs_route_shape(route_id: str) -> dict[str, Any]:
        feed: GtfsFeed | None = getattr(application.state, "gtfs_feed", None)
        if feed is None:
            raise HTTPException(status_code=503, detail="GTFS feed not loaded")
        trip_id = _first_trip_for(route_id, feed)
        if not trip_id:
            raise HTTPException(status_code=404, detail="route not found")
        trip = feed.trips.get(trip_id)
        if not trip or not trip.shape_id:
            return {"coordinates": [], "source": "gtfs"}
        points = feed.shapes.get(trip.shape_id, [])
        return {
            "coordinates": [[pt.lng, pt.lat] for pt in points],
            "source": "gtfs",
        }

    @application.get("/api/buses", response_model=None)
    async def realtime_buses() -> dict[str, Any]:
        try:
            client: TjRealtimeClient | None = getattr(application.state, "realtime_client", None)
            error_detail: str | None = getattr(application.state, "realtime_error", None)
            feed: GtfsFeed | None = getattr(application.state, "gtfs_feed", None)
            if client is None and resolved.realtime_enabled:
                try:
                    client = TjRealtimeClient(api_base=resolved.realtime_api_base)
                    client.authenticate()
                    application.state.realtime_client = client
                    application.state.realtime_error = None
                except Exception as exc:
                    application.state.realtime_error = str(exc)
            if client is not None:
                try:
                    buses = client.get_buses(
                        lat=resolved.realtime_center_lat,
                        lng=resolved.realtime_center_lng,
                        radius_km=resolved.realtime_radius_km,
                    )
                    application.state.realtime_buses = buses
                except TjApiError:
                    pass
            enriched: list[dict[str, object]] = []
            for b in getattr(application.state, "realtime_buses", []):
                info: dict[str, object] = {
                    "id": b.bus_id,
                    "route_code": b.route_code,
                    "lat": b.lat,
                    "lng": b.lng,
                    "observed_at": b.observed_at.isoformat(),
                }
                if feed is not None and b.trip_id:
                    next_stop = _find_next_stop(feed, b.trip_id, b.lat, b.lng)
                    if next_stop is not None:
                        info["next_stop"] = next_stop
                enriched.append(info)
            return {
                "buses": enriched,
                "source": "realtime" if client is not None else "unavailable",
                "error": getattr(application.state, "realtime_error", None),
            }
        except Exception as exc:
            return {"buses": [], "source": "error", "error": str(exc)}

    @application.get("/api/arrivals", response_model=None)
    async def arrivals(stop_id: str | None = None, lat: float | None = None, lng: float | None = None) -> dict[str, Any]:
        try:
            feed: GtfsFeed | None = getattr(application.state, "gtfs_feed", None)
            if feed is None:
                return {"arrivals": [], "stop": None, "source": "unavailable", "error": "GTFS not loaded"}

            target_stop_id = stop_id
            if target_stop_id is None and lat is not None and lng is not None:
                target_stop_id = _find_nearest_stop(feed, lat, lng)
            if target_stop_id is None:
                return {"arrivals": [], "stop": None, "source": "unavailable", "error": "no stop resolved"}

            stop = feed.stops.get(target_stop_id)
            if stop is None:
                return {"arrivals": [], "stop": None, "source": "unavailable", "error": "stop not found"}

            client: TjRealtimeClient | None = getattr(application.state, "realtime_client", None)
            if client is None and resolved.realtime_enabled:
                try:
                    client = TjRealtimeClient(api_base=resolved.realtime_api_base)
                    client.authenticate()
                    application.state.realtime_client = client
                except Exception:
                    client = None

            buses: list[RealtimeBus] = []
            if client is not None:
                try:
                    buses = client.get_buses(lat=stop.lat, lng=stop.lng, radius_km=5.0)
                except TjApiError:
                    buses = []

            arrivals_list: list[dict[str, object]] = []
            for b in buses:
                if not _route_serves_stop(feed, b.route_code, target_stop_id):
                    continue
                dist_km = _haversine_km(b.lat, b.lng, stop.lat, stop.lng)
                eta_minutes = max(1, round(dist_km / 0.3))
                headsign = _headsign_for_bus(feed, b.trip_id, b.route_code) if b.trip_id else b.route_code
                arrivals_list.append({
                    "bus_id": b.bus_id,
                    "route_code": b.route_code,
                    "headsign": headsign,
                    "eta_minutes": eta_minutes,
                    "distance_km": round(dist_km, 2),
                })

            arrivals_list.sort(key=lambda a: int(a["eta_minutes"]))
            return {
                "arrivals": arrivals_list[:20],
                "stop": {"id": stop.stop_id, "name": stop.name, "lat": stop.lat, "lng": stop.lng},
                "source": "realtime" if client is not None else "unavailable",
            }
        except Exception as exc:
            return {"arrivals": [], "stop": None, "source": "error", "error": str(exc)}

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


def _first_trip_for(route_id: str, feed: "GtfsFeed") -> str | None:
    for trip_id, trip in feed.trips.items():
        if trip.route_id == route_id:
            return trip_id
    return None


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    import math
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _find_next_stop(feed: "GtfsFeed", trip_id: str, bus_lat: float, bus_lng: float) -> dict[str, object] | None:
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
        dist = _haversine_km(bus_lat, bus_lng, stop.lat, stop.lng)
        candidates.append((dist, stop.name, st.stop_sequence))
    if not candidates:
        return None
    candidates.sort(key=lambda c: c[0])
    closest_seq = candidates[0][2]
    for d in candidates:
        if d[2] > closest_seq:
            return {"name": d[1], "sequence": d[2]}
    return {"name": candidates[0][1], "sequence": candidates[0][2]}


def _find_nearest_stop(feed: "GtfsFeed", lat: float, lng: float) -> str | None:
    best_id: str | None = None
    best_dist = float("inf")
    for stop in feed.stops.values():
        dist = _haversine_km(lat, lng, stop.lat, stop.lng)
        if dist < best_dist:
            best_dist = dist
            best_id = stop.stop_id
    return best_id


def _route_serves_stop(feed: "GtfsFeed", route_code: str, stop_id: str) -> bool:
    served = feed.routes_by_stop.get(stop_id, [])
    return route_code in served


def _headsign_for_bus(feed: "GtfsFeed", trip_id: str, route_code: str) -> str:
    trip = feed.trips.get(trip_id)
    if trip and trip.headsign:
        return trip.headsign
    routes = feed.routes_by_short_name.get(_normalize_short(route_code), [])
    if routes and routes[0].long_name:
        return routes[0].long_name
    return route_code


def _normalize_short(value: str) -> str:
    return " ".join(value.casefold().split()).strip()


app = create_app()
