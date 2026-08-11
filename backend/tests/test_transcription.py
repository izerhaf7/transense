from datetime import datetime, timedelta, timezone

import pytest

from backend.persistence import DemoStore
from backend.transcription import (
    CloudSTTConfig,
    ProviderConfigurationError,
    TranscriptionError,
    TranscriptionResult,
    create_provider,
    normalize_provider_result,
    persist_transcript,
    transcript_history,
)


def test_provider_result_normalization_rejects_empty_text():
    assert normalize_provider_result({"text": "  halo  "}, "cloud").text == "halo"
    with pytest.raises(TranscriptionError):
        normalize_provider_result({"text": ""}, "cloud")


def test_mock_provider_is_deterministic_without_cloud_config(monkeypatch):
    monkeypatch.delenv("TRANSENSE_STT_PROVIDER", raising=False)
    provider = create_provider()
    first = provider.transcribe()
    second = provider.transcribe()
    assert first == second
    assert first.mode == "mock"
    assert first.provider == "mock"


def test_cloud_configuration_is_env_only_and_reports_missing(monkeypatch):
    monkeypatch.setenv("TRANSENSE_STT_PROVIDER", "cloud")
    monkeypatch.delenv("TRANSENSE_CLOUD_STT_ENDPOINT", raising=False)
    monkeypatch.delenv("TRANSENSE_CLOUD_STT_API_KEY", raising=False)
    with pytest.raises(ProviderConfigurationError, match="TRANSENSE_CLOUD_STT_ENDPOINT"):
        CloudSTTConfig.from_env()
    assert create_provider().mode == "mock"


def test_transcript_metadata_and_functional_payload_are_validated(tmp_path):
    store = DemoStore(tmp_path / "demo.sqlite3")
    result = TranscriptionResult("functional text", "mock", "mock")
    with pytest.raises(TranscriptionError):
        persist_transcript(store, result, "session", datetime(2026, 8, 11), "id")
    with pytest.raises(TranscriptionError):
        persist_transcript(store, result, "", datetime.now(timezone.utc), "id")
    persist_transcript(store, result, "session", datetime.now(timezone.utc), "transcript-1")
    record = store.list_records("transcript")[0]
    assert record["payload"] == {"text": "functional text", "session_id": "session", "provider": "mock", "mode": "mock", "functional": True}
    store.close()


def test_transcript_history_cleanup_order_and_pinned_exemption(tmp_path):
    store = DemoStore(tmp_path / "demo.sqlite3")
    now = datetime(2026, 8, 11, 12, tzinfo=timezone.utc)
    store.add("transcript", {"text": "old"}, now - timedelta(days=8), record_id="old")
    store.add("transcript", {"text": "saved"}, now - timedelta(days=8), pinned=True, record_id="saved")
    store.add("transcript", {"text": "new"}, now - timedelta(hours=1), record_id="new")
    records = transcript_history(store, now)
    assert [record["id"] for record in records] == ["new", "saved"]
    store.close()
    reopened = DemoStore(tmp_path / "demo.sqlite3")
    assert [record["id"] for record in transcript_history(reopened, now)] == ["new", "saved"]
    reopened.set_pinned("saved", False)
    assert transcript_history(reopened, now) == [records[0]]
    reopened.close()
