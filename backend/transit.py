from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4


class TransitValidationError(ValueError):
    """Raised when a transit seed or update would publish invalid references."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class TransitSimulator:
    _seed: dict[str, list[dict[str, Any]]]
    _state: dict[str, list[dict[str, Any]]]
    state_version: int = 0

    @classmethod
    def create(cls) -> "TransitSimulator":
        seed = {
            "stops": [{"id": "stop-kp", "name": "Halte Karet"}, {"id": "stop-bun", "name": "Halte Bundaran HI"}],
            "routes": [{"id": "route-1", "name": "Koridor 1", "stop_ids": ["stop-kp", "stop-bun"]}],
            "trips": [{"id": "trip-1", "route_id": "route-1", "vehicle_id": "vehicle-kp-01"}],
            "vehicles": [{"id": "vehicle-kp-01", "trip_id": "trip-1", "position": "stop-kp", "eta_minutes": 4}],
            "etas": [{"id": "eta-vehicle-kp-01", "vehicle_id": "vehicle-kp-01", "stop_id": "stop-bun", "minutes": 4}],
            "incidents": [{"id": "incident-demo-01", "route_id": "route-1", "status": "normal", "message": "Layanan berjalan normal"}],
        }
        validate_dataset(seed)
        return cls(seed, deepcopy(seed))

    def snapshot(self) -> dict[str, Any]:
        return deepcopy(self._state)

    def update(self, vehicle_id: str) -> dict[str, Any]:
        validate_update(self._state, vehicle_id)
        vehicle = next(vehicle for vehicle in self._state["vehicles"] if vehicle["id"] == vehicle_id)
        eta = next(eta for eta in self._state["etas"] if eta["vehicle_id"] == vehicle_id)
        vehicle["eta_minutes"] = max(0, vehicle["eta_minutes"] - 1)
        eta["minutes"] = vehicle["eta_minutes"]
        self.state_version += 1
        return {
            "type": "transit.update",
            "event_id": f"event-{self.state_version:04d}",
            "vehicle_id": vehicle_id,
            "eta_minutes": vehicle["eta_minutes"],
            "position": vehicle["position"],
            "occurred_at": iso_utc(utc_now()),
            "state_version": self.state_version,
        }

    def reset(self) -> dict[str, Any]:
        self._state = deepcopy(self._seed)
        self.state_version += 1
        return {"type": "transit.reset", "state": self.snapshot(), "occurred_at": iso_utc(utc_now()), "state_version": self.state_version}


def _ids(records: list[dict[str, Any]], entity: str) -> set[str]:
    result = {record.get("id") for record in records}
    if not all(isinstance(record_id, str) and record_id for record_id in result) or len(result) != len(records):
        raise TransitValidationError(f"{entity} records require unique stable ids")
    return {record_id for record_id in result if isinstance(record_id, str)}


def validate_dataset(dataset: dict[str, list[dict[str, Any]]]) -> None:
    required = ("stops", "routes", "trips", "vehicles", "etas", "incidents")
    if any(key not in dataset for key in required):
        raise TransitValidationError("seed dataset is incomplete")
    stop_ids = _ids(dataset["stops"], "stop")
    route_ids = _ids(dataset["routes"], "route")
    trip_ids = _ids(dataset["trips"], "trip")
    vehicle_ids = _ids(dataset["vehicles"], "vehicle")
    _ids(dataset["etas"], "ETA")
    _ids(dataset["incidents"], "incident")
    for route in dataset["routes"]:
        if not set(route.get("stop_ids", [])) <= stop_ids:
            raise TransitValidationError("route references an unknown stop")
    for trip in dataset["trips"]:
        if trip.get("route_id") not in route_ids or trip.get("vehicle_id") not in vehicle_ids:
            raise TransitValidationError("trip references an unknown route or vehicle")
    for vehicle in dataset["vehicles"]:
        if vehicle.get("trip_id") not in trip_ids or vehicle.get("position") not in stop_ids:
            raise TransitValidationError("vehicle references an unknown trip or stop")
    for eta in dataset["etas"]:
        if eta.get("vehicle_id") not in vehicle_ids or eta.get("stop_id") not in stop_ids:
            raise TransitValidationError("ETA references an unknown vehicle or stop")
    for incident in dataset["incidents"]:
        if incident.get("route_id") not in route_ids:
            raise TransitValidationError("incident references an unknown route")


def validate_update(dataset: dict[str, list[dict[str, Any]]], vehicle_id: str) -> None:
    if vehicle_id not in {vehicle["id"] for vehicle in dataset["vehicles"]}:
        raise TransitValidationError(f"unknown vehicle reference: {vehicle_id}")
