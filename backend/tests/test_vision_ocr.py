from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

from backend.config import Settings
from backend.main import create_app


def app_for(tmp_path: Path, origins: tuple[str, ...] = ("http://localhost:5173",)):
    return create_app(Settings("test", origins, tmp_path / "demo.sqlite3"))


def vision_app_for(tmp_path: Path):
    """Settings with the Google Cloud Vision key present so OCR reaches the API."""
    return create_app(
        Settings(
            "test",
            ("http://localhost:5173",),
            tmp_path / "demo.sqlite3",
            google_vision_api_key="test-vision-key",
        )
    )


def test_vision_ocr_returns_503_when_not_configured(tmp_path):
    app = app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/vision/ocr", json={"image_base64": "aGVsbG8="})
    assert response.status_code == 503
    assert response.json() == {"detail": "Google Cloud Vision not configured"}


def test_vision_ocr_returns_422_when_image_missing(tmp_path):
    app = vision_app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/vision/ocr", json={})
    assert response.status_code == 422
    blank = client.post("/api/vision/ocr", json={"image_base64": "   "})
    assert blank.status_code == 422


def test_vision_ocr_returns_422_when_image_too_large(tmp_path):
    app = vision_app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/vision/ocr", json={"image_base64": "a" * 5_000_001})
    assert response.status_code == 422
    assert "5,000,000" in response.json()["detail"]


def test_vision_ocr_returns_text_with_mocked_vision_api(tmp_path, monkeypatch):
    recorded: dict[str, object] = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"responses": [{"textAnnotations": [{"description": "1"}]}]}

    def fake_post(url, *, params, json, timeout):
        recorded["url"] = url
        recorded["params"] = params
        recorded["json"] = json
        return FakeResponse()

    monkeypatch.setattr("backend.api.routers.ai.httpx.post", fake_post)

    app = vision_app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/vision/ocr", json={"image_base64": "aGVsbG8="})
    assert response.status_code == 200
    assert response.json() == {"text": "1", "source": "google-cloud-vision"}
    assert recorded["url"] == "https://vision.googleapis.com/v1/images:annotate"
    assert recorded["params"] == {"key": "test-vision-key"}
    assert recorded["json"] == {
        "requests": [
            {
                "features": [{"type": "TEXT_DETECTION"}],
                "image": {"content": "aGVsbG8="},
            }
        ]
    }


def test_vision_ocr_falls_back_to_full_text_annotation(tmp_path, monkeypatch):
    def fake_post(url, *, params, json, timeout):
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {"responses": [{"fullTextAnnotation": {"text": "Koridor 10"}}]},
        )

    monkeypatch.setattr("backend.api.routers.ai.httpx.post", fake_post)

    app = vision_app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/vision/ocr", json={"image_base64": "aGVsbG8="})
    assert response.status_code == 200
    assert response.json() == {"text": "Koridor 10", "source": "google-cloud-vision"}


def test_vision_ocr_returns_empty_text_for_empty_vision_result(tmp_path, monkeypatch):
    """An empty Vision result is a valid empty reading (HTTP 200), never an error."""
    def fake_post(url, *, params, json, timeout):
        return SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"responses": [{}]})

    monkeypatch.setattr("backend.api.routers.ai.httpx.post", fake_post)

    app = vision_app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/vision/ocr", json={"image_base64": "aGVsbG8="})
    assert response.status_code == 200
    assert response.json() == {"text": "", "source": "google-cloud-vision"}


def test_vision_ocr_returns_502_when_vision_api_fails(tmp_path, monkeypatch):
    def failing_post(url, *, params, json, timeout):
        raise RuntimeError("vision api unreachable")

    monkeypatch.setattr("backend.api.routers.ai.httpx.post", failing_post)

    app = vision_app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/vision/ocr", json={"image_base64": "aGVsbG8="})
    assert response.status_code == 502
    assert "Google Cloud Vision failed" in response.json()["detail"]
