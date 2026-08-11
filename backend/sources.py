from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import quote
from urllib.request import Request, urlopen


class SourceMappingError(ValueError):
    pass


@dataclass(frozen=True)
class StaticSchedule:
    data: dict[str, list[dict[str, Any]]]
    source: str
    attribution: str | None


class CommuteDataPlatformAdapter:
    """Optional static source; it cannot provide fleet positions or incidents."""

    def __init__(self, base_url: str, timeout: float = 2.0, opener: Callable[..., Any] = urlopen):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.opener = opener

    def load(self) -> StaticSchedule:
        stations = self._fetch_json("/stations/TJ").get("data", [])
        operators = self._fetch_json("/operators").get("data", [])
        tj_operator = next((operator for operator in operators if operator.get("code") == "TJ"), None)
        if not isinstance(tj_operator, dict):
            raise SourceMappingError("Commute source did not return the TJ operator")

        normalized_station_map = {
            station.get("id"): {"id": station.get("id"), "name": station.get("name")}
            for station in stations
            if isinstance(station, dict) and isinstance(station.get("id"), str)
        }
        routes: list[dict[str, Any]] = []
        timetables: list[dict[str, Any]] = []
        for line in tj_operator.get("lines", []):
            if not isinstance(line, dict) or not isinstance(line.get("lineCode"), str):
                continue
            line_code = line["lineCode"]
            try:
                detail = self._fetch_json(f"/lines/TJ/{quote(line_code, safe='')}").get("data", {})
            except (OSError, TimeoutError, ValueError, json.JSONDecodeError):
                continue
            if not isinstance(detail, dict):
                continue
            line_stations = [
                station
                for segment in detail.get("segments", [])
                if isinstance(segment, dict)
                for station in segment.get("stations", [])
                if isinstance(station, dict)
            ]
            stop_ids = [station.get("id") for station in line_stations if isinstance(station.get("id"), str)]
            if not stop_ids:
                continue
            for station in line_stations:
                station_id = station.get("id")
                station_name = station.get("name")
                if isinstance(station_id, str) and isinstance(station_name, str):
                    normalized_station_map.setdefault(station_id, {"id": station_id, "name": station_name})
            routes.append({"id": f"TJ:{line_code}", "name": line.get("name", line_code), "stop_ids": list(dict.fromkeys(stop_ids))})
            first_station = line_stations[0]
            station_code = first_station.get("code")
            if isinstance(station_code, str):
                try:
                    timetable = self._fetch_json(f"/stations/TJ/{quote(station_code, safe='')}/timetable/{quote(line_code, safe='')}")
                    timetable_data = timetable.get("data", [])
                    if isinstance(timetable_data, list) and timetable_data:
                        timetables.append({"route_id": f"TJ:{line_code}", "station_id": first_station["id"], "data": timetable_data})
                except (OSError, TimeoutError, ValueError, json.JSONDecodeError):
                    continue

        return self.map_payload({"stops": list(normalized_station_map.values()), "routes": routes, "timetables": timetables})

    def _fetch_json(self, path: str) -> dict[str, Any]:
        request = Request(
            f"{self.base_url}{path}",
            headers={"Accept": "application/json", "User-Agent": "Transense/0.1 demo source adapter"},
        )
        with self.opener(request, timeout=self.timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not isinstance(payload, dict):
            raise SourceMappingError("Commute source response must be an object")
        return payload

    def map_payload(self, payload: Any) -> StaticSchedule:
        if not isinstance(payload, dict):
            raise SourceMappingError("Commute source response must be an object")
        required = ("stops", "routes", "timetables")
        if any(not isinstance(payload.get(key), list) or not payload[key] for key in required):
            raise SourceMappingError("Commute source must provide non-empty stops, routes, and timetables")
        stops = [{"id": item.get("id"), "name": item.get("name")} for item in payload["stops"]]
        routes = [{"id": item.get("id"), "name": item.get("name"), "stop_ids": item.get("stop_ids")} for item in payload["routes"]]
        if any(not isinstance(item["id"], str) or not item["id"] or not isinstance(item["name"], str) for item in stops):
            raise SourceMappingError("Commute source mapping contains invalid station")
        if any(not isinstance(item["id"], str) or not item["id"] or not isinstance(item["name"], str) or not isinstance(item["stop_ids"], list) for item in routes):
            raise SourceMappingError("Commute source mapping contains invalid station or line")
        stop_ids = {item["id"] for item in stops}
        if any(not item["stop_ids"] or not set(item["stop_ids"]) <= stop_ids for item in routes):
            raise SourceMappingError("Commute source route references an unknown stop")
        return StaticSchedule({"stops": stops, "routes": routes, "timetables": payload["timetables"]}, self.base_url, "Commute Data Platform, ODbL-1.0")


def load_static_schedule(seed: dict[str, list[dict[str, Any]]], source_url: str | None) -> StaticSchedule:
    if not source_url:
        return StaticSchedule({"stops": seed["stops"], "routes": seed["routes"], "timetables": []}, "seed", None)
    try:
        return CommuteDataPlatformAdapter(source_url).load()
    except (OSError, TimeoutError, ValueError, json.JSONDecodeError):
        return StaticSchedule({"stops": seed["stops"], "routes": seed["routes"], "timetables": []}, "seed", None)
