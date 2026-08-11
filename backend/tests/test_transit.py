import pytest

from backend.transit import TransitSimulator, TransitValidationError, validate_dataset


def test_seed_has_joinable_stable_entities_and_update_is_deterministic():
    simulator = TransitSimulator.create()
    first = simulator.update("vehicle-kp-01")
    assert first["eta_minutes"] == 3
    assert first["event_id"] == "event-0001"


def test_unknown_seed_reference_is_rejected_without_publish():
    simulator = TransitSimulator.create()
    invalid = simulator.snapshot()
    invalid["etas"][0]["vehicle_id"] = "missing-vehicle"
    with pytest.raises(TransitValidationError):
        validate_dataset(invalid)
    assert simulator.snapshot()["etas"][0]["vehicle_id"] == "vehicle-kp-01"


def test_unknown_update_reference_is_rejected():
    with pytest.raises(TransitValidationError):
        TransitSimulator.create().update("missing-vehicle")


def test_eta_and_incident_ids_must_be_unique_and_non_empty():
    dataset = TransitSimulator.create().snapshot()
    dataset["etas"][0]["id"] = ""
    with pytest.raises(TransitValidationError, match="ETA records require unique stable ids"):
        validate_dataset(dataset)

    dataset = TransitSimulator.create().snapshot()
    dataset["incidents"].append({**dataset["incidents"][0]})
    with pytest.raises(TransitValidationError, match="incident records require unique stable ids"):
        validate_dataset(dataset)
