from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
from typing import Any, cast

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.routers import ai, conversations, facilities, gtfs, health, incidents, journey, realtime, schedule, transcripts, transit, ws
from .api.utils import load_or_build_walk_graph
from .commute import CommuteClient, CommuteFeed
from .config import Settings
from .gtfs_loader import download_gtfs, parse_gtfs
from .notifications import NotificationEngine
from .persistence import DemoStore
from .sources import load_static_schedule
from .tj_api import RealtimeBus, TjRealtimeClient
from .transit import TransitSimulator
from .walk_graph import WalkGraph

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
        app.state.walk_graph = load_or_build_walk_graph(app.state.gtfs_feed)
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

    application.include_router(health.router)
    application.include_router(schedule.router)
    application.include_router(facilities.router)
    application.include_router(incidents.router)
    application.include_router(transcripts.router)
    application.include_router(ai.router)
    application.include_router(conversations.router)
    application.include_router(gtfs.router)
    application.include_router(transit.router)
    application.include_router(realtime.router)
    application.include_router(journey.router)
    application.include_router(ws.router)

    return application


app = create_app()
