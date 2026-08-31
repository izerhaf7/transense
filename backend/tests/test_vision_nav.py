from pathlib import Path
from types import SimpleNamespace

import httpx
from fastapi.testclient import TestClient

from backend.api.routers.ai import _build_nav_prompt
from backend.config import Settings
from backend.main import create_app


def app_for(tmp_path: Path, origins: tuple[str, ...] = ("http://localhost:5173",)):
    return create_app(Settings("test", origins, tmp_path / "demo.sqlite3"))


def gemini_app_for(tmp_path: Path):
    """Settings with the Gemini key present so nav reaches the API."""
    return create_app(
        Settings(
            "test",
            ("http://localhost:5173",),
            tmp_path / "demo.sqlite3",
            gemini_api_key="test-gemini-key",
        )
    )


def _valid_body() -> dict[str, str]:
    return {
        "image_base64": "aGVsbG8=",
        "station_context": "Stasiun Bundaran HI",
        "destination": "peron MRT",
    }


def _gemini_payload(instruction: dict) -> dict:
    import json as _json

    return {
        "candidates": [
            {"content": {"parts": [{"text": _json.dumps(instruction)}]}}
        ]
    }


def test_vision_nav_returns_503_when_not_configured(tmp_path):
    app = app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/vision/nav", json=_valid_body())
    assert response.status_code == 503
    assert response.json() == {"detail": "Gemini vision not configured"}


def test_vision_nav_returns_422_when_image_missing_or_empty(tmp_path):
    app = gemini_app_for(tmp_path)
    with TestClient(app) as client:
        missing = client.post("/api/vision/nav", json={"station_context": "s", "destination": "d"})
        blank = client.post(
            "/api/vision/nav",
            json={"image_base64": "   ", "station_context": "s", "destination": "d"},
        )
    assert missing.status_code == 422
    assert blank.status_code == 422


def test_vision_nav_returns_422_when_image_too_large(tmp_path):
    app = gemini_app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post(
            "/api/vision/nav",
            json={"image_base64": "a" * 5_000_001, "station_context": "s", "destination": "d"},
        )
    assert response.status_code == 422
    assert "5,000,000" in response.json()["detail"]


def test_vision_nav_returns_instruction_with_mocked_gemini(tmp_path, monkeypatch):
    recorded: dict[str, object] = {}
    instruction = {
        "arah": "kiri",
        "instruksi": "Ke kiri, ada eskalator.",
        "landmark": "eskalator",
        "percaya_diri": 0.9,
    }

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return _gemini_payload(instruction)

    def fake_post(url, *, params, json, timeout):
        recorded["url"] = url
        recorded["params"] = params
        recorded["json"] = json
        recorded["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("backend.api.routers.ai.httpx.post", fake_post)

    app = gemini_app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/vision/nav", json=_valid_body())
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "gemini"
    assert body["model"] == "gemini-2.5-flash-lite"
    assert body["instruction"] == instruction
    assert "gemini_api_key" not in body
    assert recorded["url"] == (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        "gemini-2.5-flash-lite:generateContent"
    )
    assert recorded["params"] == {"key": "test-gemini-key"}
    assert recorded["timeout"] == 12.0
    sent = recorded["json"]
    parts = sent["contents"][0]["parts"]
    assert parts[0] == {"inline_data": {"mime_type": "image/jpeg", "data": "aGVsbG8="}}
    assert "Stasiun Bundaran HI" in parts[1]["text"]
    assert "peron MRT" in parts[1]["text"]
    assert sent["generationConfig"] == {
        "maxOutputTokens": 150,
        "temperature": 0.1,
        "responseMimeType": "application/json",
    }


def test_vision_nav_returns_unavailable_on_timeout(tmp_path, monkeypatch):
    def timeout_post(url, *, params, json, timeout):
        raise httpx.TimeoutException("gemini timed out")

    monkeypatch.setattr("backend.api.routers.ai.httpx.post", timeout_post)

    app = gemini_app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/vision/nav", json=_valid_body())
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "unavailable"
    assert body["fallback_text"]


def test_vision_nav_returns_unavailable_on_http_error(tmp_path, monkeypatch):
    def error_post(url, *, params, json, timeout):
        request = httpx.Request("POST", url)
        response = httpx.Response(500, request=request)
        raise httpx.HTTPStatusError("server error", request=request, response=response)

    monkeypatch.setattr("backend.api.routers.ai.httpx.post", error_post)

    app = gemini_app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/vision/nav", json=_valid_body())
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "unavailable"
    assert body["fallback_text"]


def test_vision_nav_returns_unavailable_on_empty_or_malformed_response(tmp_path, monkeypatch):
    def empty_post(url, *, params, json, timeout):
        return SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"candidates": []})

    monkeypatch.setattr("backend.api.routers.ai.httpx.post", empty_post)

    app = gemini_app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/vision/nav", json=_valid_body())
    assert response.status_code == 200
    assert response.json()["source"] == "unavailable"

    def malformed_post(url, *, params, json, timeout):
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {"candidates": [{"content": {"parts": [{"text": "not json"}]}}]},
        )

    monkeypatch.setattr("backend.api.routers.ai.httpx.post", malformed_post)

    app = gemini_app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/vision/nav", json=_valid_body())
    assert response.status_code == 200
    assert response.json()["source"] == "unavailable"


def test_build_nav_prompt_contains_station_and_destination():
    prompt = _build_nav_prompt("Stasiun Bundaran HI", "peron MRT")
    assert isinstance(prompt, str)
    assert "Stasiun Bundaran HI" in prompt
    assert "peron MRT" in prompt
