from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .transit import TransitValidationError, iso_utc, utc_now


VEHICLE_APPROACH_THRESHOLD_MINUTES = 2
DESTINATION_APPROACH_THRESHOLD_MINUTES = 1
VIBRATION_PATTERNS = {
    "vehicle_approaching": [200, 100, 200],
    "destination_approaching": [300, 100, 300, 100, 300],
    "incident": [500, 200, 500, 200, 1000],
}


@dataclass
class JourneySubscription:
    vehicle_id: str
    route_id: str
    origin_stop_id: str
    destination_stop_id: str
    emitted: set[str] = field(default_factory=set)


class NotificationEngine:
    """Deterministic notification derivation over the seeded transit state."""

    def __init__(self) -> None:
        self.journey: JourneySubscription | None = None
        self.incident_versions: dict[str, int] = {}

    def subscribe(self, state: dict[str, list[dict[str, Any]]], payload: dict[str, Any]) -> dict[str, Any]:
        vehicle_id = payload.get("vehicle_id")
        route_id = payload.get("route_id")
        origin_stop_id = payload.get("origin_stop_id")
        destination_stop_id = payload.get("destination_stop_id")
        vehicles = {item["id"]: item for item in state["vehicles"]}
        routes = {item["id"]: item for item in state["routes"]}
        if vehicle_id not in vehicles:
            raise TransitValidationError(f"unknown vehicle reference: {vehicle_id or ''}")
        vehicle = vehicles[vehicle_id]
        trip = next((item for item in state["trips"] if item["id"] == vehicle["trip_id"]), None)
        if trip is None or trip["route_id"] != route_id or route_id not in routes:
            raise TransitValidationError(f"unknown route reference: {route_id or ''}")
        stop_ids = set(routes[route_id].get("stop_ids", []))
        if origin_stop_id not in stop_ids or destination_stop_id not in stop_ids:
            raise TransitValidationError("journey references an unknown route stop")
        if origin_stop_id == destination_stop_id:
            raise TransitValidationError("journey requires distinct origin and destination stops")
        self.journey = JourneySubscription(vehicle_id, route_id, origin_stop_id, destination_stop_id)
        return {
            "type": "journey.subscribed",
            "journey_id": f"journey-{vehicle_id}-{route_id}",
            "vehicle_id": vehicle_id,
            "route_id": route_id,
            "origin_stop_id": origin_stop_id,
            "destination_stop_id": destination_stop_id,
            "occurred_at": iso_utc(utc_now()),
        }

    def on_transit_update(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        journey = self.journey
        if journey is None or journey.vehicle_id != event["vehicle_id"]:
            return []
        notifications: list[dict[str, Any]] = []
        eta = event["eta_minutes"]
        if eta <= VEHICLE_APPROACH_THRESHOLD_MINUTES and "vehicle_approaching" not in journey.emitted:
            journey.emitted.add("vehicle_approaching")
            notifications.append(self._travel_event("vehicle_approaching", journey, event, journey.origin_stop_id, eta))
        if eta <= DESTINATION_APPROACH_THRESHOLD_MINUTES and "destination_approaching" not in journey.emitted:
            journey.emitted.add("destination_approaching")
            notifications.append(self._travel_event("destination_approaching", journey, event, journey.destination_stop_id, eta))
        return notifications

    def incident_event(self, state: dict[str, list[dict[str, Any]]], payload: dict[str, Any]) -> dict[str, Any]:
        route_id = payload.get("route_id")
        if route_id not in {item["id"] for item in state["routes"]}:
            raise TransitValidationError(f"unknown route reference: {route_id or ''}")
        incident_id = payload.get("incident_id", "incident-demo-01")
        stage = payload.get("stage", self.incident_versions.get(incident_id, 0))
        if not isinstance(stage, int) or stage not in INCIDENT_STAGES:
            raise TransitValidationError("incident stage must be 0, 1, or 2")
        self.incident_versions[incident_id] = stage + 1
        details = INCIDENT_STAGES[stage]
        occurred_at = iso_utc(utc_now())
        return {
            "type": "notification.incident",
            "event_id": f"incident-{incident_id}-update-{stage + 1}",
            "incident_id": incident_id,
            "route_id": route_id,
            "status": details["status"],
            "cause": details["cause"],
            "action": details["action"],
            "instruction": details["instruction"],
            "updated_at": occurred_at,
            "created_at": occurred_at,
            "occurred_at": occurred_at,
            "vibration_pattern": VIBRATION_PATTERNS["incident"],
            "simulated": True,
        }

    def reset(self) -> None:
        self.journey = None
        self.incident_versions.clear()

    def off_route(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self.journey is None:
            raise TransitValidationError("off-route simulation requires an active journey")
        action = payload.get("action", "trigger")
        if action not in {"trigger", "resolve"}:
            raise TransitValidationError("off-route action must be trigger or resolve")
        state = "warning" if action == "trigger" else "resolved"
        return {
            "type": "journey.off_route",
            "event_id": f"off-route-{state}-{self.journey.route_id}",
            "journey_id": f"journey-{self.journey.vehicle_id}-{self.journey.route_id}",
            "route_id": self.journey.route_id,
            "status": state,
            "message": "Simulasi keluar rute" if state == "warning" else "Simulasi keluar rute selesai",
            "occurred_at": iso_utc(utc_now()),
            "simulated": True,
        }

    @staticmethod
    def _travel_event(kind: str, journey: JourneySubscription, update: dict[str, Any], stop_id: str, eta: int) -> dict[str, Any]:
        occurred_at = update["occurred_at"]
        return {
            "type": f"notification.{kind}",
            "event_id": f"{kind}-{journey.vehicle_id}-{update['state_version']}",
            "vehicle_id": journey.vehicle_id,
            "route_id": journey.route_id,
            "stop_id": stop_id,
            "eta_minutes": eta,
            "occurred_at": occurred_at,
            "vibration_pattern": VIBRATION_PATTERNS[kind],
            "simulated": True,
        }


INCIDENT_STAGES: dict[int, dict[str, str]] = {
    0: {"status": "delay", "cause": "Pengecekan armada", "action": "Petugas melakukan pengecekan", "instruction": "Ikuti arahan petugas di halte"},
    1: {"status": "diverted", "cause": "Gangguan jalur sementara", "action": "Layanan berjalan melalui jalur alternatif", "instruction": "Tunggu pembaruan berikutnya"},
    2: {"status": "resolved", "cause": "Pengecekan selesai", "action": "Layanan kembali normal", "instruction": "Lanjutkan perjalanan sesuai rute"},
}
