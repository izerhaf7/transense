from pathlib import Path

from fastapi.testclient import TestClient

from backend.config import Settings
from backend.facilities import FACILITY_STOPS
from backend.main import create_app


def app_for(tmp_path: Path, origins: tuple[str, ...] = ("http://localhost:5173",)):
    return create_app(Settings("test", origins, tmp_path / "demo.sqlite3"))


def test_websocket_ramp_request_acknowledged_for_known_stop(tmp_path):
    stop_id = FACILITY_STOPS[0]["id"]
    with TestClient(app_for(tmp_path)) as client:
        with client.websocket_connect("/api/ws", headers={"origin": "http://localhost:5173"}) as websocket:
            websocket.receive_json()
            websocket.send_json({"type": "ramp.request", "stop_id": stop_id, "journey_id": "journey-demo-01"})
            ack = websocket.receive_json()
    assert ack["type"] == "ramp.request.ack"
    assert ack["stop_id"] == stop_id
    assert ack["status"] == "received"
    assert ack["occurred_at"].endswith("Z")
    assert "simulated" not in ack


def test_websocket_ramp_request_rejects_unknown_stop(tmp_path):
    with TestClient(app_for(tmp_path)) as client:
        with client.websocket_connect("/api/ws", headers={"origin": "http://localhost:5173"}) as websocket:
            websocket.receive_json()
            websocket.send_json({"type": "ramp.request", "stop_id": "does-not-exist"})
            error = websocket.receive_json()
    assert error["type"] == "error"
    assert error["code"] == "invalid_stop_reference"
    assert "does-not-exist" in error["message"]
    assert "simulated" not in error
