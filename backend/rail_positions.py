"""Schedule-based MRT train position interpolation.

MRT Jakarta runs ~99% on time, so each train's position is interpolated from
the static timetable (departures from the line terminus) over the rail
geometry — a deterministic reference while waiting, labelled ``scheduled``.
Coordinates in the rail geometry are ``[lng, lat]`` (GeoJSON order).
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any

WIB_OFFSET_S = 7 * 3600
_WIB = timezone(timedelta(seconds=WIB_OFFSET_S))
_EARTH_RADIUS_KM = 6371.0088

# ~30 km/h average service speed (matches MRT_SPEED_KMH in mrt_planner.py).
MRT_SPEED_MPS = 30000 / 3600


def _haversine_m(lat_a: float, lng_a: float, lat_b: float, lng_b: float) -> float:
    """Great-circle distance in metres between two WGS84 coordinates."""
    phi_a, phi_b = math.radians(lat_a), math.radians(lat_b)
    d_phi = math.radians(lat_b - lat_a)
    d_lambda = math.radians(lng_b - lng_a)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi_a) * math.cos(phi_b) * math.sin(d_lambda / 2) ** 2
    return 2.0 * _EARTH_RADIUS_KM * 1000 * math.asin(math.sqrt(a))


def _parse_hhmm(value: str) -> int | None:
    """``HH:MM`` -> seconds since midnight; ``None`` on garbage."""
    try:
        hours, minutes = (int(part) for part in value.split(":"))
    except (ValueError, AttributeError):
        return None
    return hours * 3600 + minutes * 60


def _polyline(geometry_segments: list) -> list[tuple[float, float, float]]:
    """Flatten segments into ``(lat, lng, cumulative_m)`` points."""
    points: list[tuple[float, float]] = []
    for segment in geometry_segments:
        for coord in segment:
            if not isinstance(coord, (list, tuple)) or len(coord) < 2:
                continue
            points.append((float(coord[1]), float(coord[0])))  # [lng, lat] -> (lat, lng)
    if not points:
        return []
    line = [(points[0][0], points[0][1], 0.0)]
    for i in range(1, len(points)):
        distance = _haversine_m(line[-1][0], line[-1][1], points[i][0], points[i][1])
        line.append((points[i][0], points[i][1], line[-1][2] + distance))
    return line


def _point_at_distance(line: list[tuple[float, float, float]], target_m: float) -> tuple[float, float] | None:
    """Interpolated ``(lat, lng)`` at ``target_m`` along the polyline."""
    if not line:
        return None
    if target_m <= 0:
        return (line[0][0], line[0][1])
    if target_m >= line[-1][2]:
        return (line[-1][0], line[-1][1])
    for i in range(1, len(line)):
        prev, current = line[i - 1], line[i]
        segment_m = current[2] - prev[2]
        if segment_m <= 0:
            continue
        if current[2] >= target_m:
            ratio = (target_m - prev[2]) / segment_m
            return (
                prev[0] + (current[0] - prev[0]) * ratio,
                prev[1] + (current[1] - prev[1]) * ratio,
            )
    return (line[-1][0], line[-1][1])


def _station_offsets(
    line: list[tuple[float, float, float]], stations: list[dict[str, Any]]
) -> list[tuple[dict[str, Any], float]]:
    """Station -> distance (m) of the nearest polyline point (station order kept)."""
    offsets: list[tuple[dict[str, Any], float]] = []
    for station in stations:
        lat, lng = station.get("lat"), station.get("lng")
        if lat is None or lng is None:
            continue
        best_m, best_offset = float("inf"), 0.0
        for point_lat, point_lng, point_m in line:
            distance = _haversine_m(float(lat), float(lng), point_lat, point_lng)
            if distance < best_m:
                best_m, best_offset = distance, point_m
        offsets.append((station, best_offset))
    return offsets


def mrt_positions(
    ordered_stations: list[dict[str, Any]],
    geometry_segments: list,
    departures: list[str],
    now_utc: datetime,
) -> list[dict[str, Any]]:
    """Interpolate every departed train's position from the timetable.

    One train per terminus departure.  Trains that have not left the terminus
    yet (departure time > now) and trains that have completed the full line
    (elapsed ride > total track time) are omitted.
    """
    line = _polyline(geometry_segments)
    if not line or not ordered_stations or not departures:
        return []
    total_m = line[-1][2]
    total_ride_s = total_m / MRT_SPEED_MPS

    wib_now = now_utc.astimezone(_WIB)
    now_s = wib_now.hour * 3600 + wib_now.minute * 60 + wib_now.second

    station_offsets = _station_offsets(line, ordered_stations)
    direction_label = ordered_stations[-1]["name"]

    trains: list[dict[str, Any]] = []
    for index, departure in enumerate(sorted({str(dep).strip() for dep in departures})):
        departure_s = _parse_hhmm(departure)
        if departure_s is None:
            continue
        elapsed_s = now_s - departure_s
        if elapsed_s < 0 or elapsed_s > total_ride_s:
            continue
        target_m = elapsed_s * MRT_SPEED_MPS
        position = _point_at_distance(line, target_m)
        if position is None:
            continue
        next_station = next(
            (station["name"] for station, offset in station_offsets if offset > target_m),
            None,
        )
        trains.append(
            {
                "id": f"mrt-{departure.replace(':', '')}-{index}",
                "direction": direction_label,
                "lat": round(position[0], 6),
                "lng": round(position[1], 6),
                "next_station": next_station
                or (station_offsets[-1][0]["name"] if station_offsets else None),
                "progress_pct": round(target_m / total_m * 100, 1),
            }
        )
    trains.sort(key=lambda train: train["progress_pct"])
    return trains
