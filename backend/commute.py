"""Commute Data Platform client for rail operators (KCI, MRT, LRT).

The Commute Data Platform (https://api.commute.shiorilabs.id, ODbL-1.0) exposes
stations, lines, timetables, and cross-operator transfers for Jabodetabek rail
operators.  TransJakarta is deliberately excluded here — the primary GTFS feed
already covers it.

This module is a small read-only adapter: it maps the public JSON API onto the
same conceptual shape the backend uses for GTFS, so the frontend can render rail
stations, lines, and per-station departure boards without knowing the source.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import quote
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

# Rail operators we integrate.  TransJakarta is intentionally absent.
RAIL_OPERATORS = ("KCI", "MRTJ", "LRTJ", "LRTJBDB")

_MODE_LABEL = {
    "RAIL": "KRL",
    "SUBWAY": "MRT",
    "TRAM": "LRT",
    "BUS": "Bus",
}


class CommuteError(RuntimeError):
    pass


@dataclass(frozen=True)
class CommuteLine:
    operator: str
    operator_name: str
    code: str
    name: str
    color: str
    mode: str


@dataclass(frozen=True)
class CommuteStation:
    id: str
    operator: str
    code: str
    name: str
    lat: float | None
    lng: float | None
    lines: tuple[str, ...]


@dataclass
class CommuteFeed:
    """Snapshot of rail operators: lines + stations, lazily cached."""

    lines: list[CommuteLine] = field(default_factory=list)
    stations: dict[str, CommuteStation] = field(default_factory=dict)
    stations_by_operator: dict[str, list[CommuteStation]] = field(default_factory=dict)


def mode_label(mode: str) -> str:
    return _MODE_LABEL.get(mode, mode)


class CommuteClient:
    def __init__(
        self,
        base_url: str = "https://api.commute.shiorilabs.id",
        timeout: float = 6.0,
        opener: Callable[..., Any] = urlopen,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.opener = opener

    def _fetch(self, path: str) -> Any:
        request = Request(
            f"{self.base_url}{path}",
            headers={"Accept": "application/json", "User-Agent": "Transense/0.1"},
        )
        with self.opener(request, timeout=self.timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not isinstance(payload, dict) or "data" not in payload:
            raise CommuteError(f"Unexpected response from {path}")
        return payload["data"]

    def operators(self) -> list[dict[str, Any]]:
        data = self._fetch("/operators")
        if not isinstance(data, list):
            raise CommuteError("Unexpected /operators shape")
        return [op for op in data if isinstance(op, dict) and op.get("code") in RAIL_OPERATORS]

    def stations(self, operator: str) -> list[dict[str, Any]]:
        data = self._fetch(f"/stations/{quote(operator)}")
        if not isinstance(data, list):
            raise CommuteError(f"Unexpected /stations/{operator} shape")
        return [s for s in data if isinstance(s, dict)]

    def line_detail(self, operator: str, code: str) -> dict[str, Any]:
        data = self._fetch(f"/lines/{quote(operator)}/{quote(code)}")
        if not isinstance(data, dict):
            raise CommuteError(f"Unexpected /lines/{operator}/{code} shape")
        return data

    def timetable_grouped(self, operator: str, code: str) -> list[dict[str, Any]]:
        data = self._fetch(
            f"/stations/{quote(operator)}/{quote(code)}/timetable/grouped?compact=1"
        )
        if not isinstance(data, list):
            raise CommuteError(f"Unexpected timetable/grouped shape for {operator}/{code}")
        return data

    def load_feed(self) -> CommuteFeed:
        feed = CommuteFeed()
        for op in self.operators():
            op_code = str(op.get("code") or "")
            op_name = str(op.get("name") or op_code)
            for line in op.get("lines", []) if isinstance(op.get("lines"), list) else []:
                if not isinstance(line, dict):
                    continue
                code = str(line.get("lineCode") or "")
                if not code:
                    continue
                feed.lines.append(
                    CommuteLine(
                        operator=op_code,
                        operator_name=op_name,
                        code=code,
                        name=str(line.get("name") or code),
                        color=str(line.get("colorCode") or ""),
                        mode=str(line.get("mode") or ""),
                    )
                )

        for op_code in RAIL_OPERATORS:
            stations: list[CommuteStation] = []
            for s in self.stations(op_code):
                sid = str(s.get("id") or "")
                code = str(s.get("code") or "")
                if not sid:
                    continue
                station = CommuteStation(
                    id=sid,
                    operator=op_code,
                    code=code,
                    name=str(s.get("name") or code),
                    lat=_to_float(s.get("latitude")),
                    lng=_to_float(s.get("longitude")),
                    lines=tuple(str(x) for x in s.get("lines", []) if isinstance(x, str)),
                )
                feed.stations[sid] = station
                stations.append(station)
            feed.stations_by_operator[op_code] = stations

        return feed


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
