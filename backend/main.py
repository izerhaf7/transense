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
import httpx
from starlette.websockets import WebSocketDisconnect

from .config import Settings
from .commute import CommuteClient, CommuteFeed, CommuteError, mode_label, amenity_label
from .facilities import get_facility_stop, list_facility_stops, stop_occupancy
from .conversation import (ConversationError, create_conversation, delete_conversation,
                           list_conversations, update_conversation)
from .gtfs_loader import download_gtfs, parse_gtfs, GtfsError, GtfsFeed, stop_type_label, service_active_on
from .persistence import DemoStore
from .planner import itinerary_to_dict, plan_trip
from .notifications import NotificationEngine
from .sources import load_static_schedule
from .tj_api import TjRealtimeClient, RealtimeBus, TjApiError
from .transit import TransitSimulator, TransitValidationError, iso_utc, utc_now
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
    app.state.commute_feed: CommuteFeed | None = None
    app.state.commute_error: str | None = None
    app.state.commute_line_geometry: dict[str, list[dict[str, Any]]] = {}
    app.state.rail_geometry: dict[str, list[list[list[float]]]] = {}

    settings: Settings = app.state.settings
    try:
        zip_path = download_gtfs(url=settings.gtfs_url, cache_path=settings.gtfs_cache_path)
        app.state.gtfs_feed = parse_gtfs(zip_path)
        logger.info("GTFS feed loaded: %d stops, %d routes", len(app.state.gtfs_feed.stops), len(app.state.gtfs_feed.routes))
        app.state.walk_graph = _load_or_build_walk_graph(app.state.gtfs_feed)
    except Exception as exc:
        app.state.gtfs_error = str(exc)
        logger.warning("GTFS load failed, using seed data: %s", exc)

    if settings.commute_enabled:
        try:
            client = CommuteClient(base_url=settings.commute_api_base)
            app.state.commute_feed = client.load_feed()
            logger.info("Commute feed loaded: %d lines, %d stations", len(app.state.commute_feed.lines), len(app.state.commute_feed.stations))
        except Exception as exc:
            app.state.commute_error = str(exc)
            logger.warning("Commute feed not available: %s", exc)

    try:
        geometry_path = Path(settings.rail_geometry_path)
        if geometry_path.is_file():
            raw = json.loads(geometry_path.read_text(encoding="utf-8"))
            for line in raw.get("lines", []):
                key = f"{line.get('operator')}:{line.get('code')}"
                segments = line.get("segments") or []
                if key and segments:
                    app.state.rail_geometry[key] = segments
            logger.info("Rail geometry loaded: %d lines", len(app.state.rail_geometry))
    except Exception as exc:
        logger.warning("Rail geometry not available: %s", exc)

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
            now = datetime.now(timezone.utc)
            for seed_incident in app.state.transit.snapshot()["incidents"]:
                store.add(
                    "incident",
                    {
                        **seed_incident,
                        "cause": seed_incident.get("cause", "Tidak ada gangguan pada simulasi seed."),
                        "action": seed_incident.get("action", "Layanan berjalan sesuai skenario demo."),
                        "instruction": seed_incident.get("instruction", "Tetap lihat pembaruan visual di aplikasi."),
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

    @application.get("/api/facilities/stops", response_model=None)
    async def facility_stops() -> dict[str, Any]:
        try:
            stops = list_facility_stops()
        except Exception:
            return {"stops": [], "source": "unavailable"}
        return {"stops": stops, "source": "facility-seed"}

    @application.get("/api/facilities/stops/{stop_id}", response_model=None)
    async def facility_stop(stop_id: str) -> dict[str, Any]:
        try:
            stop = get_facility_stop(stop_id)
        except Exception:
            stop = None
        if stop is None:
            raise HTTPException(status_code=404, detail="facility stop not found")
        return {"stop": stop, "source": "facility-seed"}

    @application.get("/api/facilities/stops/{stop_id}/occupancy", response_model=None)
    async def facility_stop_occupancy(stop_id: str) -> dict[str, Any]:
        try:
            stop = get_facility_stop(stop_id)
        except Exception:
            stop = None
        if stop is None:
            raise HTTPException(status_code=404, detail="facility stop not found")
        return stop_occupancy(stop_id)

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

    @application.post("/api/tts", response_model=None)
    async def tts(payload: dict[str, Any]) -> Response:
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            raise HTTPException(status_code=422, detail="text must be a non-empty string")
        if len(text) > 5000:
            raise HTTPException(status_code=422, detail="text must be at most 5000 characters")
        if not resolved.elevenlabs_api_key or not resolved.elevenlabs_tts_voice_id:
            raise HTTPException(status_code=503, detail="ElevenLabs TTS not configured")
        model_id = payload.get("model_id") or "eleven_multilingual_v2"
        try:
            from elevenlabs import ElevenLabs
            client = ElevenLabs(api_key=resolved.elevenlabs_api_key)
            chunks = client.text_to_speech.convert(
                voice_id=resolved.elevenlabs_tts_voice_id,
                text=text,
                model_id=str(model_id),
                output_format="mp3_44100_128",
            )
            audio = b"".join(chunks)
        except Exception as error:
            raise HTTPException(status_code=502, detail=f"ElevenLabs TTS failed: {error}")
        return Response(content=audio, media_type="audio/mpeg")

    @application.post("/api/vision/ocr", response_model=None)
    async def vision_ocr(payload: dict[str, Any]) -> dict[str, Any]:
        """Google Cloud Vision OCR proxy for the Netra camera scan.

        Accepts a base64 JPEG/PNG frame and returns the recognized text. The
        Vision key stays backend-only (``GOOGLE_VISION_API_KEY``); without it the
        endpoint fails with 503. The response never fabricates text: an empty
        Vision result is a valid empty reading (HTTP 200 with ``text: ""``).
        """
        image_base64 = payload.get("image_base64")
        if not isinstance(image_base64, str) or not image_base64.strip():
            raise HTTPException(status_code=422, detail="image_base64 must be a non-empty string")
        if not resolved.google_vision_api_key:
            raise HTTPException(status_code=503, detail="Google Cloud Vision not configured")
        try:
            response = httpx.post(
                "https://vision.googleapis.com/v1/images:annotate",
                params={"key": resolved.google_vision_api_key},
                json={
                    "requests": [
                        {
                            "features": [{"type": "TEXT_DETECTION"}],
                            "image": {"content": image_base64},
                        }
                    ]
                },
                timeout=15.0,
            )
            response.raise_for_status()
        except Exception as error:
            raise HTTPException(status_code=502, detail=f"Google Cloud Vision failed: {error}")
        return {"text": _extract_ocr_text(response.json()), "source": "google-cloud-vision"}

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
                {"id": s.stop_id, "name": s.name, "lat": s.lat, "lng": s.lng,
                 "location_type": s.location_type, "parent_station": s.parent_station,
                 "platform_code": s.platform_code, "wheelchair_boarding": s.wheelchair_boarding}
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
                "wheelchair_boarding": s.wheelchair_boarding,
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

    @application.get("/api/gtfs/route/{route_id}/stops", response_model=None)
    async def gtfs_route_stops(route_id: str) -> dict[str, Any]:
        feed: GtfsFeed | None = getattr(application.state, "gtfs_feed", None)
        if feed is None:
            raise HTTPException(status_code=503, detail="GTFS feed not loaded")
        if route_id not in feed.routes:
            raise HTTPException(status_code=404, detail="route not found")
        stops = _route_station_stops(feed, route_id)
        return {"stops": stops, "source": "gtfs"}

    @application.get("/api/gtfs/route/{route_id}/shape", response_model=None)
    async def gtfs_route_shape(route_id: str) -> dict[str, Any]:
        feed: GtfsFeed | None = getattr(application.state, "gtfs_feed", None)
        if feed is None:
            raise HTTPException(status_code=503, detail="GTFS feed not loaded")
        shape_ids: list[str] = []
        seen_ids: set[str] = set()
        for trip in feed.trips.values():
            if trip.route_id == route_id and trip.shape_id and trip.shape_id not in seen_ids:
                seen_ids.add(trip.shape_id)
                shape_ids.append(trip.shape_id)
        if not shape_ids:
            raise HTTPException(status_code=404, detail="route not found")
        lines: list[list[list[float]]] = []
        seen_geoms: set[tuple[tuple[float, float], ...]] = set()
        for shape_id in shape_ids:
            points = feed.shapes.get(shape_id, [])
            if len(points) < 2:
                continue
            coords = [[pt.lng, pt.lat] for pt in points]
            geom_key = tuple((round(pt.lat, 5), round(pt.lng, 5)) for pt in points)
            if geom_key in seen_geoms:
                continue
            seen_geoms.add(geom_key)
            lines.append(coords)
        return {
            "coordinates": lines[0] if lines else [],
            "lines": lines,
            "source": "gtfs",
        }

    @application.get("/api/gtfs/stop/{stop_id}/info", response_model=None)
    async def gtfs_stop_info(stop_id: str) -> dict[str, Any]:
        feed: GtfsFeed | None = getattr(application.state, "gtfs_feed", None)
        if feed is None:
            raise HTTPException(status_code=503, detail="GTFS feed not loaded")
        stop = feed.stops.get(stop_id)
        if stop is None:
            raise HTTPException(status_code=404, detail="stop not found")

        route_codes = _stop_route_codes(feed, stop_id)
        routes_info = []
        for code in route_codes:
            route = _route_by_code(feed, code)
            routes_info.append({
                "route_code": code,
                "color": f"#{route.color}" if route and route.color else "#1677ff",
            })

        client: TjRealtimeClient | None = getattr(application.state, "realtime_client", None)
        arrivals: list[dict[str, Any]] = []
        if client is not None:
            try:
                buses = client.get_buses(lat=stop.lat, lng=stop.lng, radius_km=3.0)
                for bus in buses:
                    eta = _bus_eta_to_stop(bus, stop_id)
                    if eta is None:
                        continue
                    arrivals.append({
                        "bus_id": bus.bus_id,
                        "route_code": bus.route_code,
                        "eta_minutes": eta,
                    })
            except TjApiError:
                arrivals = []
        arrivals.sort(key=lambda a: a["eta_minutes"])

        return {
            "stop": {
                "id": stop.stop_id,
                "name": stop.name,
                "lat": stop.lat,
                "lng": stop.lng,
                "location_type": stop.location_type,
                "parent_station": stop.parent_station,
                "platform_code": stop.platform_code,
                "wheelchair_boarding": stop.wheelchair_boarding,
            },
            "routes": routes_info,
            "arrivals": arrivals,
            "source": "gtfs",
        }

    @application.get("/api/gtfs/stop/{stop_id}/schedule", response_model=None)
    async def gtfs_stop_schedule(stop_id: str) -> dict[str, Any]:
        feed: GtfsFeed | None = getattr(application.state, "gtfs_feed", None)
        if feed is None:
            raise HTTPException(status_code=503, detail="GTFS feed not loaded")
        stop = feed.stops.get(stop_id)
        if stop is None:
            raise HTTPException(status_code=404, detail="stop not found")

        today = date_cls.today()
        timetable = _stop_timetable(feed, stop_id, today)

        client: TjRealtimeClient | None = getattr(application.state, "realtime_client", None)
        live: list[dict[str, Any]] = []
        if client is not None:
            try:
                buses = client.get_buses(lat=stop.lat, lng=stop.lng, radius_km=3.0)
                for bus in buses:
                    eta = _bus_eta_to_stop(bus, stop_id)
                    if eta is None:
                        continue
                    live.append({
                        "bus_id": bus.bus_id,
                        "route_code": bus.route_code,
                        "eta_minutes": eta,
                        "headsign": _headsign_for_bus(feed, bus.trip_id, bus.route_code) if bus.trip_id else bus.route_code,
                    })
            except TjApiError:
                live = []
        live.sort(key=lambda a: a["eta_minutes"])

        return {
            "stop": {
                "id": stop.stop_id,
                "name": stop.name,
                "lat": stop.lat,
                "lng": stop.lng,
                "wheelchair_boarding": stop.wheelchair_boarding,
            },
            "timetable": timetable,
            "live": live,
            "source": "gtfs",
        }

    @application.get("/api/transit/lines", response_model=None)
    async def transit_lines() -> dict[str, Any]:
        feed: CommuteFeed | None = getattr(application.state, "commute_feed", None)
        if feed is None:
            return {"lines": [], "source": "unavailable"}
        lines = [
            {
                "operator": line.operator,
                "operator_name": line.operator_name,
                "code": line.code,
                "name": line.name,
                "color": f"#{line.color}" if line.color and not line.color.startswith("#") else (line.color or "#1677ff"),
                "mode": line.mode,
                "mode_label": mode_label(line.mode),
            }
            for line in feed.lines
        ]
        return {"lines": lines, "source": "commute"}

    @application.get("/api/transit/stations", response_model=None)
    async def transit_stations() -> dict[str, Any]:
        feed: CommuteFeed | None = getattr(application.state, "commute_feed", None)
        if feed is None:
            return {"stations": [], "source": "unavailable"}
        stations = [
            {
                "id": s.id,
                "operator": s.operator,
                "code": s.code,
                "name": s.name,
                "lat": s.lat,
                "lng": s.lng,
                "lines": list(s.lines),
            }
            for s in feed.stations.values()
            if s.lat is not None and s.lng is not None
        ]
        return {"stations": stations, "source": "commute"}

    @application.get("/api/transit/line/{operator}/{code}/stations", response_model=None)
    async def transit_line_stations(operator: str, code: str) -> dict[str, Any]:
        feed: CommuteFeed | None = getattr(application.state, "commute_feed", None)
        if feed is None:
            raise HTTPException(status_code=503, detail="Commute feed not loaded")
        key = f"{operator}:{code}"
        matching = [line for line in feed.lines if f"{line.operator}:{line.code}" == key]
        if not matching:
            raise HTTPException(status_code=404, detail="line not found")
        line = matching[0]
        ordered = _commute_line_stations(application, line)
        return {"line": line.code, "name": line.name, "color": line.color, "stations": ordered, "source": "commute"}

    @application.get("/api/transit/stop/{operator}/{code}/info", response_model=None)
    async def transit_stop_info(operator: str, code: str) -> dict[str, Any]:
        feed: CommuteFeed | None = getattr(application.state, "commute_feed", None)
        if feed is None:
            raise HTTPException(status_code=503, detail="Commute feed not loaded")
        station = feed.stations.get(f"{operator}-{code}")
        if station is None:
            raise HTTPException(status_code=404, detail="station not found")
        amenities = [
            {"type": a["type"], "label": amenity_label(a["type"]), "text": a.get("text", "")}
            for a in station.amenities
        ]
        return {
            "stop": {
                "id": station.id,
                "name": station.name,
                "operator": station.operator,
                "official_name": station.official_name,
                "lines": list(station.lines),
                "amenities": amenities,
            },
            "source": "commute",
        }

    @application.get("/api/transit/stop/{operator}/{code}/schedule", response_model=None)
    async def transit_stop_schedule(operator: str, code: str) -> dict[str, Any]:
        feed: CommuteFeed | None = getattr(application.state, "commute_feed", None)
        if feed is None:
            raise HTTPException(status_code=503, detail="Commute feed not loaded")
        station = feed.stations.get(f"{operator}-{code}")
        if station is None:
            raise HTTPException(status_code=404, detail="station not found")

        client = CommuteClient(base_url=resolved.commute_api_base)
        try:
            grouped = client.timetable_grouped(operator, code)
        except CommuteError:
            grouped = []

        timetable = _commute_grouped_to_timetable(grouped, feed)
        amenities = [
            {"type": a["type"], "label": amenity_label(a["type"]), "text": a.get("text", "")}
            for a in station.amenities
        ]
        return {
            "stop": {
                "id": station.id,
                "name": station.name,
                "operator": station.operator,
                "official_name": station.official_name,
                "lines": list(station.lines),
                "amenities": amenities,
            },
            "timetable": timetable,
            "source": "commute",
        }

    @application.get("/api/transit/lines/geometry", response_model=None)
    async def transit_lines_geometry() -> dict[str, Any]:
        feed: CommuteFeed | None = getattr(application.state, "commute_feed", None)
        if feed is None:
            return {"lines": [], "source": "unavailable"}
        rail_geometry: dict[str, list[list[list[float]]]] = getattr(application.state, "rail_geometry", {})
        cache: dict[str, list[dict[str, Any]]] = getattr(application.state, "commute_line_geometry", None)
        if cache is None:
            cache = {}
            application.state.commute_line_geometry = cache
        result = []
        for line in feed.lines:
            key = f"{line.operator}:{line.code}"
            color = f"#{line.color}" if line.color and not line.color.startswith("#") else (line.color or "#1677ff")
            segments: list[list[list[float]]] = []
            source = "commute"
            if key in rail_geometry:
                segments = rail_geometry[key]
                source = "ritj-2021"
            else:
                if key not in cache:
                    cache[key] = _commute_line_stations(application, line)
                stations = cache[key]
                coords = [[s["lng"], s["lat"]] for s in stations if s.get("lng") is not None and s.get("lat") is not None]
                if len(coords) >= 2:
                    segments = [coords]
            result.append({
                "operator": line.operator,
                "code": line.code,
                "name": line.name,
                "color": color,
                "mode_label": mode_label(line.mode),
                "segments": segments,
                "source": source,
            })
        return {"lines": result, "source": "commute"}

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
        arrive_by: str | None = None,
        include_eta: bool = False,
    ) -> dict[str, Any]:
        """Plan up to three transit itineraries from an origin to a destination.

        Each point is a GTFS stop id (``from_stop``/``to_stop``) or coordinates
        (``from_lat``+``from_lng``, ``to_lat``+``to_lng``).  ``date`` is
        ``YYYY-MM-DD`` (default: today in Asia/Jakarta) and ``time`` is ``HH:MM``
        (default: current local time rounded to the minute — planning at
        midnight would almost never find a running bus).  ``arrive_by``
        (``HH:MM``) instead plans the latest departure that still arrives by
        that deadline (``time`` is then ignored by the planner).  ``include_eta``
        annotates every BUS leg with ``delay_minutes``, ``live_eta_minutes`` and
        ``eta_source`` (``"simulated"`` when the realtime client is unavailable,
        ``"realtime"`` otherwise).  The response also carries an ``incidents``
        array: active (``delay``/``diverted``) incident records, matched to the
        itineraries' routes, with ``normal``/``resolved`` records never included.
        Degrades to ``{"itineraries": [], "source": "unavailable",
        "incidents": []}`` with HTTP 200 when the GTFS feed or walk graph is not
        loaded; invalid origin/destination or date/time params return HTTP 422
        with a plain ``{"detail": ...}`` body.
        """
        feed: GtfsFeed | None = getattr(application.state, "gtfs_feed", None)
        walk_graph: WalkGraph | None = getattr(application.state, "walk_graph", None)
        if feed is None or walk_graph is None:
            return {"itineraries": [], "source": "unavailable", "incidents": []}

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
                arrive_by=arrive_by,
            )
        except (ValueError, KeyError) as exc:
            raise HTTPException(status_code=422, detail=str(exc))

        itinerary_dicts = [itinerary_to_dict(it) for it in itineraries]
        if include_eta:
            _enrich_bus_legs_eta(
                itinerary_dicts,
                realtime_available=getattr(application.state, "realtime_client", None) is not None,
            )
        return {
            "itineraries": itinerary_dicts,
            "source": "gtfs",
            "incidents": _incidents_for_plan(application, itinerary_dicts),
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

    return application


def _extract_ocr_text(body: Any) -> str:
    """Best-effort text extraction from a Vision ``images:annotate`` response.

    Prefers ``textAnnotations[0].description``, then ``fullTextAnnotation.text``,
    else an empty string — an empty Vision result is a valid empty reading,
    never an error. Any unexpected shape degrades to the same empty string.
    """
    try:
        responses = body.get("responses") or []
        first = responses[0] if responses else {}
        annotations = first.get("textAnnotations") or []
        if annotations and annotations[0].get("description"):
            return str(annotations[0]["description"])
        full = first.get("fullTextAnnotation") or {}
        if full.get("text"):
            return str(full["text"])
    except (AttributeError, IndexError, KeyError, TypeError):
        pass
    return ""


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


def _time_bucket_for(hhmm: str | None) -> int:
    """Hour-of-day bucket (``hour // 2``) for stable per-day simulated delays."""
    try:
        hour = int(str(hhmm).split(":", 1)[0])
    except (TypeError, ValueError, IndexError):
        return 0
    return hour // 2


def _simulated_delay_minutes(route_id: str, stop_id: str, time_bucket: int) -> int:
    """Deterministic 1-15 minute simulated delay for a BUS leg.

    A pure ``zlib.crc32`` of ``route_id|stop_id|time_bucket`` — never
    ``hash()``, whose PYTHONHASHSEED randomization breaks stability across
    process restarts — so two identical requests always yield identical delays.
    The ``1 + ... % 15`` shape keeps the demo delay nonzero.
    """
    import zlib
    key = f"{route_id}|{stop_id}|{time_bucket}".encode("utf-8")
    return 1 + (zlib.crc32(key) % 15)


def _enrich_bus_legs_eta(itineraries: list[dict], realtime_available: bool) -> None:
    """Annotate every BUS leg with deterministic ETA fields, in place.

    Only BUS legs with a known ``route`` and ``from.stop_id`` are annotated:
    ``delay_minutes`` (simulated), ``live_eta_minutes`` (scheduled duration +
    delay) and ``eta_source``.  A realtime client only changes the label — the
    numeric delay stays deterministic so retries return identical payloads.
    """
    for itinerary in itineraries:
        for leg in itinerary.get("legs", []):
            if leg.get("mode") != "BUS":
                continue
            route = leg.get("route") or {}
            route_id = route.get("id")
            stop_id = (leg.get("from") or {}).get("stop_id")
            if not route_id or not stop_id:
                continue
            delay_minutes = _simulated_delay_minutes(
                route_id, stop_id, _time_bucket_for(leg.get("start_time"))
            )
            leg["delay_minutes"] = delay_minutes
            leg["live_eta_minutes"] = int(leg.get("duration_minutes", 0)) + delay_minutes
            leg["eta_source"] = "realtime" if realtime_available else "simulated"


def _incidents_for_plan(application: FastAPI, itineraries: list[dict]) -> list[dict]:
    """Active incidents for the plan response (``[]`` when no store)."""
    store: DemoStore | None = getattr(application.state, "store", None)
    if store is None:
        return []
    return _active_incidents(store, itineraries)


def _active_incidents(store: DemoStore, itineraries: list[dict]) -> list[dict]:
    """Active (``delay``/``diverted``) incident payloads for a plan.

    ``normal``/``resolved`` records are never included.  Every active incident
    is returned (banner behaviour): matched ones (route id or short name across
    the itineraries' BUS legs) carry ``affects_route: true``.  Deterministic
    order: ``updated_at`` desc, then record id asc.
    """
    route_keys: set[str] = set()
    for itinerary in itineraries:
        for leg in itinerary.get("legs", []):
            if leg.get("mode") != "BUS":
                continue
            route = leg.get("route") or {}
            if route.get("id"):
                route_keys.add(route["id"])
            if route.get("short_name"):
                route_keys.add(route["short_name"])

    active: list[dict] = []
    for record in store.list_records("incident"):
        payload = dict(record.get("payload") or {})
        if payload.get("status") not in {"delay", "diverted"}:
            continue
        payload["affects_route"] = payload.get("route_id") in route_keys
        if not payload.get("id"):
            payload["id"] = record.get("id") or payload.get("event_id") or ""
        active.append(payload)
    active.sort(key=lambda incident: str(incident.get("id", "")))
    active.sort(key=lambda incident: str(incident.get("updated_at", "")), reverse=True)
    return active


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


def _stop_route_codes(feed: "GtfsFeed", stop_id: str) -> list[str]:
    codes = list(feed.routes_by_stop.get(stop_id, []))
    codes.extend(feed.routes_by_station.get(stop_id, []))
    stop = feed.stops.get(stop_id)
    if stop is not None and stop.parent_station:
        codes.extend(feed.routes_by_station.get(stop.parent_station, []))
    seen: list[str] = []
    for code in codes:
        if code not in seen:
            seen.append(code)
    return seen


def _route_by_code(feed: "GtfsFeed", route_code: str):
    routes = feed.routes_by_short_name.get(_normalize_short(route_code), [])
    return routes[0] if routes else None


def _stop_platform_ids(feed: "GtfsFeed", stop_id: str) -> set[str]:
    stop = feed.stops.get(stop_id)
    if stop is None:
        return {stop_id}
    if stop.location_type == "1" or not stop.parent_station:
        station_id = stop.stop_id
    else:
        station_id = stop.parent_station
    platform_ids = {station_id}
    for sid, s in feed.stops.items():
        if s.parent_station == station_id:
            platform_ids.add(sid)
    return platform_ids


def _route_station_stops(feed: "GtfsFeed", route_id: str) -> list[dict[str, Any]]:
    stop_ids = feed.stop_ids_by_route.get(route_id, [])
    ordered: list[dict[str, Any]] = []
    seen: set[str] = set()
    for sid in stop_ids:
        s = feed.stops.get(sid)
        if s is None:
            continue
        station_id = s.stop_id if (s.location_type == "1" or not s.parent_station) else s.parent_station
        if not station_id or station_id in seen:
            continue
        station = feed.stops.get(station_id)
        seen.add(station_id)
        ordered.append({
            "id": station_id,
            "name": station.name if station else station_id,
            "lat": station.lat if station else s.lat,
            "lng": station.lng if station else s.lng,
        })
    return ordered


def _stop_timetable(feed: "GtfsFeed", stop_id: str, date: date_cls) -> list[dict[str, Any]]:
    platform_ids = _stop_platform_ids(feed, stop_id)
    grouped: dict[tuple[str, str, str], list[str]] = {}
    for trip_id, stop_times in feed.stop_times.items():
        trip = feed.trips.get(trip_id)
        if trip is None:
            continue
        if trip.service_id and not service_active_on(feed, trip.service_id, date):
            continue
        route = feed.routes.get(trip.route_id)
        if route is None:
            continue
        for st in stop_times:
            if st.stop_id not in platform_ids:
                continue
            arrival = st.arrival_time[:5]
            if not arrival:
                continue
            key = (route.short_name, trip.headsign, str(trip.direction_id))
            grouped.setdefault(key, []).append(arrival)

    result: list[dict[str, Any]] = []
    for (short_name, headsign, direction), times in grouped.items():
        route = _route_by_code(feed, short_name)
        result.append({
            "route_code": short_name,
            "color": f"#{route.color}" if route and route.color else "#1677ff",
            "headsign": headsign,
            "direction": direction,
            "times": sorted(times),
        })
    result.sort(key=lambda r: (r["route_code"], r["headsign"]))
    return result


def _bus_eta_to_stop(bus: "RealtimeBus", stop_id: str) -> int | None:
    for eta_stop in bus.stops:
        if eta_stop.stop_id == stop_id or eta_stop.parent_stop_id == stop_id:
            return eta_stop.eta_minutes
    return None


def _commute_line_stations(application: FastAPI, line: Any) -> list[dict[str, Any]]:
    """Ordered station list for a rail line (uses the live line-detail endpoint).

    Falls back to an empty list on any network error — the frontend degrades.
    """
    feed: CommuteFeed | None = getattr(application.state, "commute_feed", None)
    if feed is None:
        return []
    try:
        client = CommuteClient(base_url=getattr(application.state, "settings").commute_api_base)
        detail = client.line_detail(line.operator, line.code)
    except CommuteError:
        return []
    ordered: list[dict[str, Any]] = []
    for segment in detail.get("segments", []) if isinstance(detail.get("segments"), list) else []:
        if not isinstance(segment, dict):
            continue
        for station in segment.get("stations", []) if isinstance(segment.get("stations"), list) else []:
            if not isinstance(station, dict):
                continue
            sid = str(station.get("id") or "")
            name = str(station.get("name") or "")
            if not sid:
                continue
            ref = feed.stations.get(sid)
            ordered.append({
                "id": sid,
                "code": str(station.get("code") or ""),
                "name": name,
                "lat": ref.lat if ref else _to_float(station.get("latitude")),
                "lng": ref.lng if ref else _to_float(station.get("longitude")),
            })
    return ordered


def _commute_grouped_to_timetable(grouped: list[dict[str, Any]], feed: "CommuteFeed") -> list[dict[str, Any]]:
    """Map the grouped (compact) departure board onto the GTFS-like timetable shape.

    Each line/direction/destination becomes one group with sorted ``times``.
    """
    result: list[dict[str, Any]] = []
    for line_group in grouped:
        if not isinstance(line_group, dict):
            continue
        line_key = str(line_group.get("line") or "")
        op_code, _, code = line_key.partition(":")
        color = "#1677ff"
        for candidate in feed.lines:
            if candidate.operator == op_code and candidate.code == code:
                color = f"#{candidate.color}" if candidate.color and not candidate.color.startswith("#") else (candidate.color or "#1677ff")
                break
        for entry in line_group.get("timetable", []) if isinstance(line_group.get("timetable"), list) else []:
            if not isinstance(entry, dict):
                continue
            for destination in entry.get("destinations", []) if isinstance(entry.get("destinations"), list) else []:
                if not isinstance(destination, dict):
                    continue
                times: list[str] = []
                for schedule in destination.get("schedules", []) if isinstance(destination.get("schedules"), list) else []:
                    if isinstance(schedule, list) and len(schedule) >= 2:
                        minutes = int(schedule[1])
                        times.append(f"{minutes // 60:02d}:{minutes % 60:02d}")
                    elif isinstance(schedule, dict):
                        dep = str(schedule.get("estimatedDeparture") or "")[:5]
                        if dep:
                            times.append(dep)
                result.append({
                    "route_code": code,
                    "color": color,
                    "headsign": str(destination.get("boundFor") or ""),
                    "direction": str(entry.get("key") or ""),
                    "platform": entry.get("platformCode"),
                    "times": sorted(times),
                })
    result.sort(key=lambda r: (r["route_code"], r["headsign"]))
    return result


def _normalize_short(value: str) -> str:
    return " ".join(value.casefold().split()).strip()


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


app = create_app()
