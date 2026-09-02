from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from backend.config import Settings
from backend.main import create_app


def app_for(tmp_path: Path, origins: tuple[str, ...] = ("http://localhost:5173",)):
    return create_app(Settings("test", origins, tmp_path / "demo.sqlite3"))


def test_tts_returns_422_when_text_missing(tmp_path):
    app = app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/tts", json={})
    assert response.status_code == 422
    assert "text" in response.json()["detail"]
    blank = client.post("/api/tts", json={"text": "   "})
    assert blank.status_code == 422


def test_tts_returns_422_when_text_too_long(tmp_path):
    app = app_for(tmp_path)
    with TestClient(app) as client:
        response = client.post("/api/tts", json={"text": "a" * 5001})
    assert response.status_code == 422
    assert "5000" in response.json()["detail"]


def test_tts_returns_audio_mpeg_with_mocked_gcp(tmp_path):
    fake_mp3 = b"\xff\xfb\x90\x44\x00\x00"  # minimal MP3 frame header
    mock_response = MagicMock()
    mock_response.audio_content = fake_mp3

    mock_client = MagicMock()
    mock_client.synthesize_speech.return_value = mock_response

    mock_tts_module = MagicMock()
    mock_tts_module.TextToSpeechClient.return_value = mock_client
    mock_tts_module.SynthesisInput = MagicMock
    mock_tts_module.VoiceSelectionParams = MagicMock
    mock_tts_module.AudioConfig = MagicMock
    mock_tts_module.AudioEncoding = MagicMock(MP3=1)

    mock_google = MagicMock()
    mock_google_cloud = MagicMock()
    mock_google_cloud.texttospeech = mock_tts_module
    mock_google.cloud = mock_google_cloud

    with patch.dict("sys.modules", {
        "google": mock_google,
        "google.cloud": mock_google_cloud,
        "google.cloud.texttospeech": mock_tts_module,
    }):
        app = app_for(tmp_path)
        with TestClient(app) as client:
            response = client.post("/api/tts", json={"text": "Halo dunia"})

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.content == fake_mp3


def test_tts_returns_502_when_gcp_fails(tmp_path):
    mock_client = MagicMock()
    mock_client.synthesize_speech.side_effect = RuntimeError("GCP TTS error")

    mock_tts_module = MagicMock()
    mock_tts_module.TextToSpeechClient.return_value = mock_client
    mock_tts_module.SynthesisInput = MagicMock
    mock_tts_module.VoiceSelectionParams = MagicMock
    mock_tts_module.AudioConfig = MagicMock
    mock_tts_module.AudioEncoding = MagicMock(MP3=1)

    mock_google = MagicMock()
    mock_google_cloud = MagicMock()
    mock_google_cloud.texttospeech = mock_tts_module
    mock_google.cloud = mock_google_cloud

    with patch.dict("sys.modules", {
        "google": mock_google,
        "google.cloud": mock_google_cloud,
        "google.cloud.texttospeech": mock_tts_module,
    }):
        app = app_for(tmp_path)
        with TestClient(app) as client:
            response = client.post("/api/tts", json={"text": "Halo"})

    assert response.status_code == 502
    assert "GCP TTS failed" in response.json()["detail"]


def test_tts_returns_502_when_empty_audio(tmp_path):
    mock_response = MagicMock()
    mock_response.audio_content = b""

    mock_client = MagicMock()
    mock_client.synthesize_speech.return_value = mock_response

    mock_tts_module = MagicMock()
    mock_tts_module.TextToSpeechClient.return_value = mock_client
    mock_tts_module.SynthesisInput = MagicMock
    mock_tts_module.VoiceSelectionParams = MagicMock
    mock_tts_module.AudioConfig = MagicMock
    mock_tts_module.AudioEncoding = MagicMock(MP3=1)

    mock_google = MagicMock()
    mock_google_cloud = MagicMock()
    mock_google_cloud.texttospeech = mock_tts_module
    mock_google.cloud = mock_google_cloud

    with patch.dict("sys.modules", {
        "google": mock_google,
        "google.cloud": mock_google_cloud,
        "google.cloud.texttospeech": mock_tts_module,
    }):
        app = app_for(tmp_path)
        with TestClient(app) as client:
            response = client.post("/api/tts", json={"text": "Halo"})

    assert response.status_code == 502
    assert "empty audio" in response.json()["detail"]

