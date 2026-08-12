from __future__ import annotations

import csv
import io
import logging
import os
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

logger = logging.getLogger(__name__)

DEFAULT_GTFS_URL = "https://gtfs.transjakarta.co.id/files/file_gtfs.zip"
REQUIRED_FILES = {"stops.txt", "routes.txt", "trips.txt", "stop_times.txt"}


class GtfsError(RuntimeError):
    pass


@dataclass(frozen=True)
class GtfsStop:
    stop_id: str
    name: str
    lat: float
    lng: float
    parent_station: str | None = None
    location_type: str = "0"
    platform_code: str = ""


@dataclass(frozen=True)
class GtfsRoute:
    route_id: str
    short_name: str
    long_name: str
    route_type: str
    color: str
    text_color: str


@dataclass(frozen=True)
class GtfsTrip:
    trip_id: str
    route_id: str
    shape_id: str | None
    direction_id: int
    headsign: str


@dataclass
class GtfsStopTime:
    trip_id: str
    stop_id: str
    stop_sequence: int
    arrival_time: str
    departure_time: str


@dataclass
class GtfsShapePoint:
    lat: float
    lng: float
    sequence: int


@dataclass
class GtfsFeed:
    stops: dict[str, GtfsStop] = field(default_factory=dict)
    routes: dict[str, GtfsRoute] = field(default_factory=dict)
    trips: dict[str, GtfsTrip] = field(default_factory=dict)
    shapes: dict[str, list[GtfsShapePoint]] = field(default_factory=dict)
    stop_times: dict[str, list[GtfsStopTime]] = field(default_factory=dict)
    routes_by_short_name: dict[str, list[GtfsRoute]] = field(default_factory=dict)
    stop_ids_by_route: dict[str, list[str]] = field(default_factory=dict)
    routes_by_stop: dict[str, list[str]] = field(default_factory=dict)
    routes_by_station: dict[str, list[str]] = field(default_factory=dict)


def _read_csv_from_zip(zf: zipfile.ZipFile, name: str) -> list[dict[str, str]]:
    try:
        raw = zf.read(name)
    except KeyError as exc:
        raise GtfsError(f"GTFS file missing: {name}") from exc
    text = raw.decode("utf-8-sig", errors="replace")
    return list(csv.DictReader(io.StringIO(text)))


def _validate_zip(path: Path) -> None:
    try:
        with zipfile.ZipFile(path) as zf:
            names = set(zf.namelist())
    except (zipfile.BadZipFile, OSError) as exc:
        raise GtfsError(f"Invalid GTFS zip: {path}") from exc
    missing = REQUIRED_FILES - names
    if missing:
        raise GtfsError(f"GTFS zip missing required files: {sorted(missing)}")


def download_gtfs(
    url: str = DEFAULT_GTFS_URL,
    cache_path: Path | str = "backend/gtfs_cache.zip",
    refresh_hours: float = 24.0,
) -> Path:
    cache_path = Path(cache_path)
    if cache_path.exists():
        age_hours = (time.time() - cache_path.stat().st_mtime) / 3600
        if age_hours < refresh_hours:
            _validate_zip(cache_path)
            return cache_path

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = cache_path.with_suffix(".download")
    try:
        logger.info("Downloading GTFS from %s", url)
        with urlopen(url, timeout=120) as response:
            with tmp_path.open("wb") as fh:
                while True:
                    chunk = response.read(1_048_576)
                    if not chunk:
                        break
                    fh.write(chunk)
        _validate_zip(tmp_path)
        os.replace(tmp_path, cache_path)
        logger.info("GTFS cached to %s", cache_path)
        return cache_path
    except URLError as exc:
        tmp_path.unlink(missing_ok=True)
        if cache_path.exists():
            logger.warning("GTFS download failed, using cached copy: %s", exc)
            return cache_path
        raise GtfsError(f"Failed to download GTFS: {exc}") from exc
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def parse_gtfs(zip_path: Path) -> GtfsFeed:
    feed = GtfsFeed()
    with zipfile.ZipFile(zip_path) as zf:
        stop_rows = _read_csv_from_zip(zf, "stops.txt")
        route_rows = _read_csv_from_zip(zf, "routes.txt")
        trip_rows = _read_csv_from_zip(zf, "trips.txt")
        st_rows = _read_csv_from_zip(zf, "stop_times.txt")
        shape_rows = _read_csv_from_zip(zf, "shapes.txt") if "shapes.txt" in zf.namelist() else []

    for row in stop_rows:
        try:
            stop_id = row["stop_id"].strip()
            feed.stops[stop_id] = GtfsStop(
                stop_id=stop_id,
                name=(row.get("stop_name") or row.get("stop_id", "")).strip(),
                lat=float(row["stop_lat"]),
                lng=float(row["stop_lon"]),
                parent_station=(row.get("parent_station") or "").strip() or None,
                location_type=(row.get("location_type") or "0").strip(),
                platform_code=(row.get("platform_code") or "").strip(),
            )
        except (KeyError, ValueError):
            continue

    for row in route_rows:
        route_id = (row.get("route_id") or "").strip()
        if not route_id:
            continue
        short = (row.get("route_short_name") or route_id).strip()
        route = GtfsRoute(
            route_id=route_id,
            short_name=short,
            long_name=(row.get("route_long_name") or "").strip(),
            route_type=(row.get("route_type") or "3").strip(),
            color=(row.get("route_color") or "").strip(),
            text_color=(row.get("route_text_color") or "").strip(),
        )
        feed.routes[route_id] = route
        normalized = _normalize(short)
        if normalized not in feed.routes_by_short_name:
            feed.routes_by_short_name[normalized] = []
        feed.routes_by_short_name[normalized].append(route)

    for row in trip_rows:
        trip_id = (row.get("trip_id") or "").strip()
        route_id = (row.get("route_id") or "").strip()
        if not trip_id or route_id not in feed.routes:
            continue
        try:
            direction_id = int(row.get("direction_id") or 0)
        except ValueError:
            direction_id = 0
        feed.trips[trip_id] = GtfsTrip(
            trip_id=trip_id,
            route_id=route_id,
            shape_id=(row.get("shape_id") or "").strip() or None,
            direction_id=direction_id,
            headsign=(row.get("trip_headsign") or "").strip(),
        )

    for row in st_rows:
        trip_id = (row.get("trip_id") or "").strip()
        stop_id = (row.get("stop_id") or "").strip()
        if not trip_id or stop_id not in feed.stops:
            continue
        try:
            seq = int(float(row.get("stop_sequence") or 0))
        except ValueError:
            seq = 0
        if trip_id not in feed.stop_times:
            feed.stop_times[trip_id] = []
        feed.stop_times[trip_id].append(
            GtfsStopTime(
                trip_id=trip_id,
                stop_id=stop_id,
                stop_sequence=seq,
                arrival_time=row.get("arrival_time", "").strip(),
                departure_time=row.get("departure_time", "").strip(),
            )
        )

    for trip_id in feed.stop_times:
        feed.stop_times[trip_id].sort(key=lambda st: st.stop_sequence)

    for row in shape_rows:
        shape_id = (row.get("shape_id") or "").strip()
        if not shape_id:
            continue
        try:
            seq = int(float(row.get("shape_pt_sequence") or 0))
            lat = float(row["shape_pt_lat"])
            lng = float(row["shape_pt_lon"])
        except (KeyError, ValueError):
            continue
        if shape_id not in feed.shapes:
            feed.shapes[shape_id] = []
        feed.shapes[shape_id].append(GtfsShapePoint(lat=lat, lng=lng, sequence=seq))

    for points in feed.shapes.values():
        points.sort(key=lambda pt: pt.sequence)

    for trip in feed.trips.values():
        stop_ids = [st.stop_id for st in feed.stop_times.get(trip.trip_id, [])]
        if stop_ids:
            feed.stop_ids_by_route.setdefault(trip.route_id, []).extend(stop_ids)

    for route_id in feed.stop_ids_by_route:
        feed.stop_ids_by_route[route_id] = _deduplicate_ordered(feed.stop_ids_by_route[route_id])

    for route_id, stop_ids in feed.stop_ids_by_route.items():
        route = feed.routes.get(route_id)
        short_name = route.short_name if route else route_id
        for stop_id in stop_ids:
            feed.routes_by_stop.setdefault(stop_id, [])
            if short_name not in feed.routes_by_stop[stop_id]:
                feed.routes_by_stop[stop_id].append(short_name)

    for stop_id, stop in feed.stops.items():
        if stop.parent_station:
            feed.routes_by_station.setdefault(stop.parent_station, [])
            for short_name in feed.routes_by_stop.get(stop_id, []):
                if short_name not in feed.routes_by_station[stop.parent_station]:
                    feed.routes_by_station[stop.parent_station].append(short_name)

    logger.info(
        "GTFS parsed: %d stops, %d routes, %d trips, %d shapes",
        len(feed.stops),
        len(feed.routes),
        len(feed.trips),
        len(feed.shapes),
    )
    return feed


def _normalize(value: str) -> str:
    return " ".join(value.casefold().split()).strip()


def stop_type_label(stop: "GtfsStop") -> str:
    if stop.location_type == "1" or stop.parent_station:
        return "BRT Station"
    return "Bus Stop"


def _deduplicate_ordered(ids: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for id_str in ids:
        if id_str not in seen:
            seen.add(id_str)
            result.append(id_str)
    return result
