from __future__ import annotations

from typing import Any, cast

# Iconic TransJakarta stops with made-up-but-realistic accessibility facility
# values. Per the owner decision (brief-v2) this data is presented as normal
# facility information: it carries no ``simulated`` marker.
FACILITY_STOPS: list[dict[str, Any]] = [
    {
        "id": "fac-bundaran-hi",
        "name": "Bundaran HI",
        "lat": -6.1946,
        "lng": 106.8231,
        "facilities": {
            "ramp": True,
            "lift": True,
            "toilet_accessible": True,
            "guiding_block": True,
            "staffed": True,
            "step_free_access": True,
        },
    },
    {
        "id": "fac-monas",
        "name": "Monumen Nasional",
        "lat": -6.1754,
        "lng": 106.8272,
        "facilities": {
            "ramp": True,
            "lift": True,
            "toilet_accessible": True,
            "guiding_block": True,
            "staffed": True,
            "step_free_access": True,
        },
    },
    {
        "id": "fac-kota-tua",
        "name": "Kota Tua",
        "lat": -6.1352,
        "lng": 106.8133,
        "facilities": {
            "ramp": True,
            "lift": False,
            "toilet_accessible": True,
            "guiding_block": True,
            "staffed": True,
            "step_free_access": False,
        },
    },
    {
        "id": "fac-senayan",
        "name": "Senayan",
        "lat": -6.2245,
        "lng": 106.8021,
        "facilities": {
            "ramp": True,
            "lift": True,
            "toilet_accessible": True,
            "guiding_block": True,
            "staffed": True,
            "step_free_access": True,
        },
    },
    {
        "id": "fac-blok-m",
        "name": "Blok M",
        "lat": -6.2444,
        "lng": 106.7984,
        "facilities": {
            "ramp": True,
            "lift": False,
            "toilet_accessible": True,
            "guiding_block": True,
            "staffed": True,
            "step_free_access": True,
        },
    },
]


def list_facility_stops() -> list[dict[str, Any]]:
    """Deterministic snapshot of the seeded facility stops (no I/O).

    Returns deep copies so callers can never mutate the module-level seed.
    """
    return [
        {**stop, "facilities": dict(cast(dict[str, Any], stop["facilities"]))}
        for stop in FACILITY_STOPS
    ]


def get_facility_stop(stop_id: str) -> dict[str, Any] | None:
    """Return the seeded facility stop for ``stop_id`` or ``None``."""
    for stop in FACILITY_STOPS:
        if stop["id"] == stop_id:
            return {**stop, "facilities": dict(cast(dict[str, Any], stop["facilities"]))}
    return None
