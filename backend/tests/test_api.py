from pathlib import Path

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.config import Settings
from backend.main import create_app
from backend.persistence import DemoStore


def app_for(tmp_path: Path, origins: tuple[str, ...] = ("http://localhost:5173",)):
    return create_app(Settings("test", origins, tmp_path / "demo.sqlite3"))


def test_health_reports_persistence_and_missing_config(tmp_path):
    app = create_app(Settings(None, (), tmp_path / "demo.sqlite3"))
    with TestClient(app) as client:
        response = client.get("/api/health")
    assert response.status_code == 503
    assert response.json()["status"] == "unhealthy"
    assert response.json()["configuration"]["missing"] == ["TRANSENSE_ENVIRONMENT", "TRANSENSE_ALLOWED_ORIGINS"]


def test_websocket_update_and_reset(tmp_path):
    with TestClient(app_for(tmp_path)) as client:
        with client.websocket_connect("/api/ws", headers={"origin": "http://localhost:5173"}) as websocket:
            ack = websocket.receive_json()
            assert ack["type"] == "connection.ack"
            assert ack["protocol"] == "transit-demo.v1"
            assert ack["state"]["routes"] == [
                {"id": "route-1", "name": "Koridor 1", "stop_ids": ["stop-kp", "stop-bun"]},
                {"id": "1", "name": "Koridor 1", "stop_ids": ["stop-kp", "stop-bun"]},
            ]
            assert ack["state"]["vehicles"][0]["id"] == "vehicle-kp-01"
            assert ack["state"]["vehicles"][0]["eta_minutes"] == 4
            websocket.send_json({"type": "transit.update", "vehicle_id": "vehicle-kp-01"})
            update = websocket.receive_json()
            assert update["type"] == "transit.update"
            assert update["eta_minutes"] == 3
            websocket.send_json({"type": "transit.reset"})
            reset = websocket.receive_json()
            assert reset["type"] == "transit.reset"
            assert reset["state"]["vehicles"][0]["eta_minutes"] == 4
            assert reset["state"]["etas"][0]["minutes"] == 4


def test_websocket_rejects_disallowed_origin(tmp_path):
    with TestClient(app_for(tmp_path)) as client:
        try:
            with client.websocket_connect("/api/ws", headers={"origin": "https://evil.example"}):
                raise AssertionError("disallowed origin was accepted")
        except WebSocketDisconnect as error:
            assert error.code == 1008


def test_websocket_returns_error_for_malformed_json(tmp_path):
    with TestClient(app_for(tmp_path)) as client:
        with client.websocket_connect("/api/ws", headers={"origin": "http://localhost:5173"}) as websocket:
            websocket.receive_json()
            websocket.send_text("not-json")
            error = websocket.receive_json()
            assert error == {"type": "error", "code": "invalid_json", "message": "message must be valid JSON"}


def test_incident_history_and_pin_endpoints(tmp_path):
    app = app_for(tmp_path)
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws", headers={"origin": "http://localhost:5173"}) as websocket:
            websocket.receive_json()
            websocket.send_json({"type": "incident.update", "route_id": "route-1"})
            incident = websocket.receive_json()
        records = client.get("/api/incidents").json()["records"]
        assert any(record["id"] == incident["event_id"] for record in records)
        pinned = client.patch(f"/api/incidents/{incident['event_id']}/pin", json={"pinned": True})
        assert pinned.json() == {"id": incident["event_id"], "pinned": True}
        stored = next(record for record in client.get("/api/incidents").json()["records"] if record["id"] == incident["event_id"])
        assert stored["pinned"] is True


def test_incidents_endpoint_includes_seeded_delay_incident(tmp_path):
    app = app_for(tmp_path)
    with TestClient(app) as client:
        records = client.get("/api/incidents").json()["records"]
    delay = next(record for record in records if record["payload"]["id"] == "incident-demo-delay-01")
    assert delay["payload"]["route_id"] == "1"
    assert delay["payload"]["status"] == "delay"
    assert delay["payload"]["cause"] and delay["payload"]["action"] and delay["payload"]["instruction"]
    normal = next(record for record in records if record["payload"]["id"] == "incident-demo-01")
    assert normal["payload"]["route_id"] == "route-1"
    assert normal["payload"]["status"] == "normal"


def test_websocket_journey_notifications_and_incident_persistence(tmp_path):
    application = app_for(tmp_path)
    with TestClient(application) as client:
        with client.websocket_connect("/api/ws", headers={"origin": "http://localhost:5173"}) as websocket:
            websocket.receive_json()
            websocket.send_json({"type": "journey.subscribe", "vehicle_id": "vehicle-kp-01", "route_id": "route-1", "origin_stop_id": "stop-kp", "destination_stop_id": "stop-bun"})
            assert websocket.receive_json()["type"] == "journey.subscribed"
            websocket.send_json({"type": "transit.update", "vehicle_id": "vehicle-kp-01"})
            assert websocket.receive_json()["type"] == "transit.update"
            websocket.send_json({"type": "transit.update", "vehicle_id": "vehicle-kp-01"})
            assert websocket.receive_json()["type"] == "transit.update"
            assert websocket.receive_json()["type"] == "notification.vehicle_approaching"
            websocket.send_json({"type": "incident.update", "route_id": "route-1", "stage": 0})
            incident = websocket.receive_json()
            assert incident["type"] == "notification.incident"
            assert {"status", "cause", "action", "instruction", "updated_at", "created_at"} <= incident.keys()
            websocket.send_json({"type": "journey.off_route", "action": "trigger"})
            assert websocket.receive_json()["status"] == "warning"
        store = DemoStore(tmp_path / "demo.sqlite3")
        records = store.list_records()
        store.close()
        incident_records = [record for record in records if record["record_type"] == "incident"]
        assert incident_records
        assert any(record["payload"]["status"] == "delay" for record in incident_records)


def test_websocket_rejects_unknown_journey_reference_without_partial_event(tmp_path):
    with TestClient(app_for(tmp_path)) as client:
        with client.websocket_connect("/api/ws", headers={"origin": "http://localhost:5173"}) as websocket:
            websocket.receive_json()
            websocket.send_json({"type": "journey.subscribe", "vehicle_id": "missing", "route_id": "route-1", "origin_stop_id": "stop-kp", "destination_stop_id": "stop-bun"})
            assert websocket.receive_json()["code"] == "invalid_transit_reference"


def test_schedule_endpoint_reports_seed_boundary(tmp_path):
    with TestClient(app_for(tmp_path)) as client:
        response = client.get("/api/schedule")
    assert response.status_code == 200
    assert response.json()["source"] == "seed"
    assert response.json()["simulated"] is True


def test_transcription_session_mock_persists_functional_result_and_history(tmp_path):
    with TestClient(app_for(tmp_path)) as client:
        with client.websocket_connect("/api/ws", headers={"origin": "http://localhost:5173"}) as websocket:
            websocket.receive_json()
            websocket.send_json({"type": "transcription.session.start", "session_id": "session-1", "source": "conversation_microphone"})
            started = websocket.receive_json()
            assert started["type"] == "transcription.session.started"
            assert started["mode"] == "mock"
            websocket.send_json({"type": "transcription.session.stop", "session_id": "session-1"})
            result = websocket.receive_json()
            assert result["type"] == "transcription.result"
            assert result["functional"] is True
            assert "audio" not in result
        history = client.get("/api/transcripts").json()["records"]
        assert history[0]["payload"]["text"] == result["text"]
        assert client.patch(f"/api/transcripts/{result['id']}/pin", json={"pinned": True}).json() == {"id": result["id"], "pinned": True}
        assert client.patch(f"/api/transcripts/{result['id']}/pin", json={"pinned": False}).status_code == 200


def test_transcription_rejects_pa_and_audio_history_inputs(tmp_path):
    with TestClient(app_for(tmp_path)) as client:
        with client.websocket_connect("/api/ws", headers={"origin": "http://localhost:5173"}) as websocket:
            websocket.receive_json()
            websocket.send_json({"type": "transcription.session.start", "session_id": "pa", "source": "pa_announcement"})
            assert websocket.receive_json()["code"] == "invalid_request"
            websocket.send_json({"type": "transcription.session.start", "session_id": "ambient", "source": "conversation_microphone", "audio_history": "noise"})
            assert websocket.receive_json()["code"] == "invalid_request"
            websocket.send_json({"type": "transcription.session.start", "session_id": "conversation", "source": "conversation_microphone"})
            assert websocket.receive_json()["type"] == "transcription.session.started"
            websocket.send_json({"type": "transcription.session.stop", "session_id": "conversation", "audio": "raw"})
            assert websocket.receive_json()["code"] == "invalid_request"
            websocket.send_json({"type": "transcription.session.stop", "session_id": "conversation"})
            result = websocket.receive_json()
            assert result["type"] == "transcription.result"
        records = client.get("/api/transcripts").json()["records"]
        assert all("audio" not in record["payload"] for record in records)
