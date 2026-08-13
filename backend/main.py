from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import date as date_cls, datetime, timezone
import json
import logging
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketDisconnect

from .config import Settings
from .conversation import (ConversationError, create_conversation, delete_conversation,
                           list_conversations, update_conversation)
from .gtfs_loader import download_gtfs, parse_gtfs, GtfsError, GtfsFeed, stop_type_label
from .persistence import DemoStore
from .planner import itinerary_to_dict, plan_trip
from .notifications import NotificationEngine
from .sources import load_static_schedule
from .tj_api import TjRealtimeClient, RealtimeBus, TjApiError
from .transit import TransitSimulator, TransitValidationError
from .transcription import (MockTranscriptionProvider, ProviderConfigurationError, TranscriptionError,
                            TranscriptionResult, create_provider, persist_transcript, transcript_history)
from .walk_graph import WalkGraph, load_walk_graph, walk_graph_from_feed

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    store: DemoStore | None = None
    app.state.store = None
    app.state.gtfs_feed = None
    app.state.walk_graph: WalkGraph | None = None
    app.state.realtime_buses: list[RealtimeBus] = []
    app.state.gtfs_error: str | None = None
    app.state.realtime_error: str | None = None
    app.state.realtime_client: TjRealtimeClient | None = None

    settings: Settings = app.state.settings
    try:
        zip_path = download_gtfs(url=settings.gtfs_url, cache_path=settings.gtfs_cache_path)
        app.state.gtfs_feed = parse_gtfs(zip_path)
        logger.info("GTFS feed loaded: %d stops, %d routes", len(app.state.gtfs_feed.stops), len(app.state.gtfs_feed.routes))
        app.state.walk_graph = _load_or_build_walk_graph(app.state.gtfs_feed)
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

    @application.get("/api/conversations", response_model=None)
    async def conversations() -> dict[str, Any]:
        store: DemoStore | None = getattr(application.state, "store", None)
        if store is None:
            return {"conversations": [], "retention_days": 7}
        return {"conversations": list_conversations(store), "retention_days": 7}

    @application.post("/api/conversations", response_model=None)
    async def create_conversation_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
        store: DemoStore | None = getattr(application.state, "store", None)
        if store is None:
            raise HTTPException(status_code=503, detail="persistence unavailable")
        try:
            return create_conversation(store, payload)
        except ConversationError as error:
            raise HTTPException(status_code=422, detail=str(error))

    @application.patch("/api/conversations/{record_id}", response_model=None)
    async def update_conversation_endpoint(record_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        store: DemoStore | None = getattr(application.state, "store", None)
        if store is None:
            raise HTTPException(status_code=503, detail="persistence unavailable")
        try:
            result = update_conversation(store, record_id, payload)
        except ConversationError as error:
            raise HTTPException(status_code=422, detail=str(error))
        if result is None:
            raise HTTPException(status_code=404, detail="conversation not found")
        return result

    @application.delete("/api/conversations/{record_id}", response_model=None)
    async def delete_conversation_endpoint(record_id: str) -> dict[str, Any]:
        store: DemoStore | None = getattr(application.state, "store", None)
        if store is None or not delete_conversation(store, record_id):
            raise HTTPException(status_code=404, detail="conversation not found")
        return {"id": record_id, "deleted": True}

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
        by_name: dict[str, dict[str, object]] = {}
        for s in feed.stops.values():
            if query not in s.name.casefold():
                continue
            key = s.name.strip().casefold()
            entry = {
                "id": s.stop_id,
                "name": s.name,
                "lat": s.lat,
                "lng": s.lng,
                "type": stop_type_label(s),
            }
            existing = by_name.get(key)
            if existing is None or s.location_type == "1":
                by_name[key] = entry
        matches = sorted(by_name.values(), key=lambda s: str(s["name"]))
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

    @application.get("/api/journey/track", response_model=None)
    async def journey_track(
        vehicle_id: str | None = None,
        target_stop_id: str | None = None,
        user_lat: float | None = None,
        user_lng: float | None = None,
    ) -> dict[str, Any]:
        """Return one live bus, its route stops, and target-stop status."""
        feed: GtfsFeed | None = getattr(application.state, "gtfs_feed", None)
        if feed is None or not target_stop_id:
            return {"status": "unavailable", "error": "GTFS or target stop unavailable"}
        target = feed.stops.get(target_stop_id)
        if target is None:
            return {"status": "unavailable", "error": "target stop not found"}

        client: TjRealtimeClient | None = getattr(application.state, "realtime_client", None)
        if client is None and resolved.realtime_enabled:
            try:
                client = TjRealtimeClient(api_base=resolved.realtime_api_base)
                client.authenticate()
                application.state.realtime_client = client
            except Exception as exc:
                return {"status": "unavailable", "error": str(exc)}
        if client is None:
            return {"status": "unavailable", "error": "realtime bus tracking disabled"}

        try:
            buses = client.get_buses(
                lat=user_lat if user_lat is not None else resolved.realtime_center_lat,
                lng=user_lng if user_lng is not None else resolved.realtime_center_lng,
                radius_km=resolved.realtime_radius_km,
            )
        except TjApiError as exc:
            return {"status": "unavailable", "error": str(exc)}

        bus: RealtimeBus | None = next((b for b in buses if vehicle_id and b.bus_id.casefold() == vehicle_id.casefold()), None)
        if bus is None and user_lat is not None and user_lng is not None:
            bus = min(buses, key=lambda b: _haversine_km(user_lat, user_lng, b.lat, b.lng), default=None)
        if bus is None:
            return {"status": "not_found", "error": "vehicle not found in realtime feed"}

        trip = feed.trips.get(bus.trip_id or "")
        if trip is None:
            return {"status": "unavailable", "error": "vehicle trip not found in GTFS", "vehicle_id": bus.bus_id}
        ordered = feed.stop_times.get(trip.trip_id, [])
        target_ids = {target_stop_id}
        target_ids.update(sid for sid, stop in feed.stops.items() if stop.parent_station == target_stop_id)
        target_indexes = [i for i, st in enumerate(ordered) if st.stop_id in target_ids]
        if not target_indexes:
            return {"status": "not_on_route", "vehicle_id": bus.bus_id, "route_code": bus.route_code, "target_stop": {"id": target.stop_id, "name": target.name}}

        nearest_index = min(
            range(len(ordered)),
            key=lambda i: _haversine_km(bus.lat, bus.lng, feed.stops[ordered[i].stop_id].lat, feed.stops[ordered[i].stop_id].lng),
        )
        target_index = min((i for i in target_indexes if i >= nearest_index), default=target_indexes[-1])
        distance_km = _haversine_km(bus.lat, bus.lng, target.lat, target.lng)
        eta_minutes = max(0, round(distance_km / 0.3))
        status = "arrived" if distance_km < 0.15 else "approaching" if target_index - nearest_index <= 3 else "en_route"
        route_stop_ids = [st.stop_id for st in ordered]
        route_stops = [
            {"id": sid, "name": feed.stops[sid].name, "lat": feed.stops[sid].lat, "lng": feed.stops[sid].lng}
            for sid in route_stop_ids if sid in feed.stops
        ]
        return {
            "status": status,
            "vehicle": {"id": bus.bus_id, "route_code": bus.route_code, "lat": bus.lat, "lng": bus.lng, "observed_at": bus.observed_at.isoformat()},
            "route": {"id": trip.route_id, "name": feed.routes.get(trip.route_id).short_name if feed.routes.get(trip.route_id) else bus.route_code, "headsign": trip.headsign, "stops": route_stops},
            "target_stop": {"id": target.stop_id, "name": target.name, "lat": target.lat, "lng": target.lng},
            "next_stop": _find_next_stop(feed, trip.trip_id, bus.lat, bus.lng),
            "eta_minutes": eta_minutes,
        }

    @application.get("/api/journey/plan", response_model=None)
    async def journey_plan(
        from_stop: str | None = None,
        to_stop: str | None = None,
        from_lat: float | None = None,
        from_lng: float | None = None,
        to_lat: float | None = None,
        to_lng: float | None = None,
        date: str | None = None,
        time: str | None = None,
    ) -> dict[str, Any]:
        """Plan up to three transit itineraries from an origin to a destination.

        Each point is a GTFS stop id (``from_stop``/``to_stop``) or coordinates
        (``from_lat``+``from_lng``, ``to_lat``+``to_lng``).  ``date`` is
        ``YYYY-MM-DD`` (default: today in Asia/Jakarta) and ``time`` is ``HH:MM``
        (default: current local time rounded to the minute — planning at
        midnight would almost never find a running bus).  Degrades to
        ``{"itineraries": [], "source": "unavailable"}`` with HTTP 200 when the
        GTFS feed or walk graph is not loaded; invalid origin/destination or
        date/time params return HTTP 422 with a plain ``{"detail": ...}`` body.
        """
        feed: GtfsFeed | None = getattr(application.state, "gtfs_feed", None)
        walk_graph: WalkGraph | None = getattr(application.state, "walk_graph", None)
        if feed is None or walk_graph is None:
            return {"itineraries": [], "source": "unavailable"}

        origin = _resolve_plan_point(from_stop, from_lat, from_lng, "origin")
        destination = _resolve_plan_point(to_stop, to_lat, to_lng, "destination")

        now = _default_plan_now()
        try:
            plan_date: date_cls = now.date() if date is None else date_cls.fromisoformat(date)
        except ValueError:
            raise HTTPException(status_code=422, detail="date must be YYYY-MM-DD")
        plan_time = time if time is not None else now.strftime("%H:%M")

        try:
            itineraries = plan_trip(
                feed,
                walk_graph,
                origin,
                destination,
                plan_date,
                departure_time=plan_time,
            )
        except (ValueError, KeyError) as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        return {
            "itineraries": [itinerary_to_dict(it) for it in itineraries],
            "source": "gtfs",
        }

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


def _default_plan_now() -> datetime:
    """Current time in Asia/Jakarta (UTC fallback), rounded down to the minute.

    The plan endpoint defaults ``date`` to today and ``time`` to now when the
    caller omits them.  Asia/Jakarta keeps the defaults on the TransJakarta
    service day; the rest of the backend uses UTC, which could shift the
    "today" boundary by up to 7 hours.
    """
    try:
        from zoneinfo import ZoneInfo
        now = datetime.now(ZoneInfo("Asia/Jakarta"))
    except Exception:
        now = datetime.now(timezone.utc)
    return now.replace(second=0, microsecond=0)


def _resolve_plan_point(
    stop_id: str | None, lat: float | None, lng: float | None, label: str
) -> dict[str, Any]:
    """Normalize a plan origin/destination to the planner's point dict.

    A stop id wins over coordinates; coordinates require both ``lat`` and
    ``lng`` (missing ones are indistinguishable from "absent" here — FastAPI
    already 422s non-float values).  Raises HTTP 422 with a plain
    ``{"detail": ...}`` body when the caller supplied neither.
    """
    if stop_id is not None and stop_id != "":
        return {"stop_id": stop_id}
    if lat is not None and lng is not None:
        return {"lat": lat, "lng": lng}
    raise HTTPException(status_code=422, detail=f"{label} requires a stop id or lat/lng coordinates")


def _load_or_build_walk_graph(feed: "GtfsFeed") -> "WalkGraph | None":
    """Load the cached walk graph for ``feed``, or build one from it.

    Prefers the offline JSON cache produced by ``scripts/build_walk_graph.py``
    (``backend/walk_graph_cache.json``) so startup never re-derives street
    distances.  When the cache is missing or invalid the graph is built
    in-memory with ``walk_graph_from_feed`` — radius-limited (1 km) with a
    latitude-band prefilter, still seconds for a full city feed.  Never raises:
    a failure leaves the plan endpoint degraded to ``source: "unavailable"``.
    """
    cache_path = Path(__file__).resolve().parent / "walk_graph_cache.json"
    cached = load_walk_graph(cache_path)
    if cached is not None:
        logger.info("Walk graph loaded from cache: %d edges", len(cached.edges))
        return cached
    try:
        graph = walk_graph_from_feed(feed)
        logger.info("Walk graph built from feed: %d edges", len(graph.edges))
        return graph
    except Exception as exc:
        logger.warning("Walk graph build failed: %s", exc)
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
    if route_code in served:
        return True
    station_routes = feed.routes_by_station.get(stop_id, [])
    if route_code in station_routes:
        return True
    stop = feed.stops.get(stop_id)
    if stop is not None and stop.parent_station:
        parent_routes = feed.routes_by_station.get(stop.parent_station, [])
        if route_code in parent_routes:
            return True
    return False


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
