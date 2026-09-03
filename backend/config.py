from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_env_file(filepath: Path) -> None:
    if not filepath.is_file():
        return
    for line in filepath.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if key and key not in os.environ:
            os.environ[key] = value


@dataclass(frozen=True)
class Settings:
    environment: str | None
    allowed_origins: tuple[str, ...]
    database_path: Path
    database_url: str | None = None
    commute_api_url: str | None = None
    stt_provider: str = "mock"
    elevenlabs_api_key: str | None = None
    elevenlabs_tts_voice_id: str = ""
    google_vision_api_key: str = ""
    gemini_api_key: str = ""
    vision_nav_model: str = "gemini-2.5-flash-lite"
    gcp_tts_voice_name: str = "id-ID-Standard-A"
    gcp_tts_model: str = "gemini-2.5-flash-tts"
    gtfs_url: str = "https://ppid.transjakarta.co.id/informasi/berkala/gtfs"
    gtfs_cache_path: str = "backend/gtfs_cache.zip"
    gtfs_bundle_path: str | None = None
    commute_api_base: str = "https://api.commute.shiorilabs.id"
    commute_enabled: bool = True
    rail_geometry_path: str = "backend/data/rail_geometry.json"
    realtime_enabled: bool = False
    realtime_api_base: str = "https://tijeapi.transjakarta.co.id"
    realtime_poll_interval: int = 15
    realtime_radius_km: float = 5.0
    realtime_center_lat: float = -6.1944
    realtime_center_lng: float = 106.8227

    @classmethod
    def from_env(cls) -> "Settings":
        _load_env_file(Path.cwd() / ".env")
        _load_env_file(Path(__file__).resolve().parent.parent / ".env")
        _load_env_file(Path.cwd() / ".env.local")
        _load_env_file(Path(__file__).resolve().parent / ".env.local")
        raw_origins = os.getenv("TRANSENSE_ALLOWED_ORIGINS", "")
        origins = tuple(origin.strip() for origin in raw_origins.split(",") if origin.strip())
        return cls(
            environment=os.getenv("TRANSENSE_ENVIRONMENT"),
            allowed_origins=origins,
            database_path=Path(os.getenv("TRANSENSE_DATABASE_PATH", "backend/transense.sqlite3")),
            database_url=os.getenv("DATABASE_URL") or None,
            commute_api_url=os.getenv("TRANSENSE_COMMUTE_API_URL") or None,
            stt_provider=os.getenv("TRANSENSE_STT_PROVIDER", "mock"),
            elevenlabs_api_key=os.getenv("ELEVENLABS_API_KEY") or None,
            elevenlabs_tts_voice_id=os.getenv("ELEVENLABS_TTS_VOICE_ID") or "",
            google_vision_api_key=os.getenv("GOOGLE_VISION_API_KEY") or "",
            gemini_api_key=os.getenv("GEMINI_API_KEY") or "",
            vision_nav_model=os.getenv("TRANSENSE_VISION_MODEL") or "gemini-2.5-flash-lite",
            gcp_tts_voice_name=os.getenv("GCP_TTS_VOICE_NAME") or "id-ID-Standard-A",
            gcp_tts_model=os.getenv("GCP_TTS_MODEL") or "gemini-2.5-flash-tts",
            gtfs_url=os.getenv("TRANSENSE_GTFS_URL", "https://ppid.transjakarta.co.id/informasi/berkala/gtfs"),
            gtfs_cache_path=os.getenv("TRANSENSE_GTFS_CACHE_PATH", "backend/gtfs_cache.zip"),
            gtfs_bundle_path=os.getenv("TRANSENSE_GTFS_BUNDLE_PATH") or None,
            commute_api_base=os.getenv("TRANSENSE_COMMUTE_API_BASE", "https://api.commute.shiorilabs.id"),
            commute_enabled=os.getenv("TRANSENSE_COMMUTE_ENABLED", "1").strip().lower() in ("1", "true", "yes"),
            rail_geometry_path=os.getenv("TRANSENSE_RAIL_GEOMETRY_PATH", "backend/data/rail_geometry.json"),
            realtime_enabled=os.getenv("TRANSENSE_REALTIME_ENABLED", "").strip().lower() in ("1", "true", "yes"),
            realtime_api_base=os.getenv("TRANSENSE_REALTIME_API_BASE", "https://tijeapi.transjakarta.co.id"),
            realtime_poll_interval=int(os.getenv("TRANSENSE_REALTIME_POLL_INTERVAL", "15")),
            realtime_radius_km=float(os.getenv("TRANSENSE_REALTIME_RADIUS_KM", "5.0")),
            realtime_center_lat=float(os.getenv("TRANSENSE_REALTIME_CENTER_LAT", "-6.1944")),
            realtime_center_lng=float(os.getenv("TRANSENSE_REALTIME_CENTER_LNG", "106.8227")),
        )

    def missing_required(self) -> list[str]:
        missing: list[str] = []
        if not self.environment:
            missing.append("TRANSENSE_ENVIRONMENT")
        if not self.allowed_origins:
            missing.append("TRANSENSE_ALLOWED_ORIGINS")
        return missing
