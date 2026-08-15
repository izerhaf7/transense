from pathlib import Path

from fastapi.testclient import TestClient

from backend.config import Settings
from backend.main import create_app


def app_for(tmp_path: Path, origins: tuple[str, ...] = ("http://localhost:5173",)):
    return create_app(Settings("test", origins, tmp_path / "demo.sqlite3"))


def tts_app_for(tmp_path: Path):
    """Settings with ElevenLabs credentials present so TTS requests reach the provider."""
    return create_app(
        Settings(
            "test",
            ("http://localhost:5173",),
            tmp_path / "demo.sqlite3",
            elevenlabs_api_key="test-key",
            elevenlabs_tts_voice_id="test-voice",
        )
    )


def test_tts_returns_503_when_not_configured(tmp_path):
    app = app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/tts", json={"text": "Halo"})
    assert response.status_code == 503
    assert response.json() == {"detail": "ElevenLabs TTS not configured"}


def test_tts_returns_422_when_text_missing(tmp_path):
    app = app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/tts", json={})
    assert response.status_code == 422
    assert "text" in response.json()["detail"]
    blank = client.post("/api/tts", json={"text": "   "})
    assert blank.status_code == 422


def test_tts_returns_audio_mpeg_with_mocked_elevenlabs(tmp_path, monkeypatch):
    recorded: dict[str, object] = {}

    class FakeTtsClient:
        def convert(self, voice_id, text, model_id, output_format):
            recorded["voice_id"] = voice_id
            recorded["text"] = text
            recorded["model_id"] = model_id
            return iter([b"ID3\x03\x00", b"\xff\xfb audio bytes"])

    class FakeElevenLabs:
        def __init__(self, api_key):
            self.text_to_speech = FakeTtsClient()

    monkeypatch.setattr("elevenlabs.ElevenLabs", FakeElevenLabs)

    app = tts_app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/tts", json={"text": "Halo dunia", "model_id": "eleven_multilingual_v2"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.content == b"ID3\x03\x00\xff\xfb audio bytes"
    assert recorded["voice_id"] == "test-voice"
    assert recorded["text"] == "Halo dunia"
    assert recorded["model_id"] == "eleven_multilingual_v2"


def test_tts_returns_502_when_elevenlabs_fails(tmp_path, monkeypatch):
    class FailingTtsClient:
        def convert(self, voice_id, text, model_id, output_format):
            raise RuntimeError("boom")

    class FailingElevenLabs:
        def __init__(self, api_key):
            self.text_to_speech = FailingTtsClient()

    monkeypatch.setattr("elevenlabs.ElevenLabs", FailingElevenLabs)

    app = tts_app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/tts", json={"text": "Halo"})
    assert response.status_code == 502
    assert "ElevenLabs TTS failed" in response.json()["detail"]
