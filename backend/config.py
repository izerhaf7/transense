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
    commute_api_url: str | None = None
    stt_provider: str = "mock"
    elevenlabs_api_key: str | None = None
    gtfs_url: str = "https://gtfs.transjakarta.co.id/files/file_gtfs.zip"
    gtfs_cache_path: str = "backend/gtfs_cache.zip"
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
            commute_api_url=os.getenv("TRANSENSE_COMMUTE_API_URL") or None,
            stt_provider=os.getenv("TRANSENSE_STT_PROVIDER", "mock"),
            elevenlabs_api_key=os.getenv("ELEVENLABS_API_KEY") or None,
            gtfs_url=os.getenv("TRANSENSE_GTFS_URL", "https://gtfs.transjakarta.co.id/files/file_gtfs.zip"),
            gtfs_cache_path=os.getenv("TRANSENSE_GTFS_CACHE_PATH", "backend/gtfs_cache.zip"),
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
