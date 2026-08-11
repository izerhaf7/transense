from datetime import datetime

import pytest

from backend.notifications import (
    DESTINATION_APPROACH_THRESHOLD_MINUTES,
    NotificationEngine,
    VEHICLE_APPROACH_THRESHOLD_MINUTES,
    VIBRATION_PATTERNS,
)
from backend.transit import TransitSimulator, TransitValidationError


def test_threshold_notifications_use_documented_distinct_patterns():
    simulator = TransitSimulator.create()
    engine = NotificationEngine()
    engine.subscribe(simulator.snapshot(), {"vehicle_id": "vehicle-kp-01", "route_id": "route-1", "origin_stop_id": "stop-kp", "destination_stop_id": "stop-bun"})
    events = []
    for _ in range(4 - DESTINATION_APPROACH_THRESHOLD_MINUTES):
        events.extend(engine.on_transit_update(simulator.update("vehicle-kp-01")))
    assert {event["type"] for event in events} == {"notification.vehicle_approaching", "notification.destination_approaching"}
    assert events[0]["vibration_pattern"] == VIBRATION_PATTERNS["vehicle_approaching"]
    assert events[1]["vibration_pattern"] == VIBRATION_PATTERNS["destination_approaching"]
    assert VEHICLE_APPROACH_THRESHOLD_MINUTES > DESTINATION_APPROACH_THRESHOLD_MINUTES
    assert len({tuple(pattern) for pattern in VIBRATION_PATTERNS.values()}) == 3
    for event in events:
        parsed = datetime.fromisoformat(event["occurred_at"].replace("Z", "+00:00"))
        assert parsed.tzinfo is not None
        assert event["event_id"]


def test_unknown_journey_references_do_not_subscribe():
    engine = NotificationEngine()
    with pytest.raises(TransitValidationError):
        engine.subscribe(TransitSimulator.create().snapshot(), {"vehicle_id": "missing", "route_id": "route-1", "origin_stop_id": "stop-kp", "destination_stop_id": "stop-bun"})


def test_incident_updates_are_structured_and_progressive():
    engine = NotificationEngine()
    state = TransitSimulator.create().snapshot()
    first = engine.incident_event(state, {"route_id": "route-1", "stage": 0})
    second = engine.incident_event(state, {"route_id": "route-1", "stage": 1})
    assert {"status", "cause", "action", "instruction", "updated_at", "created_at"} <= first.keys()
    assert first["event_id"] != second["event_id"]
    assert first["status"] != second["status"]
