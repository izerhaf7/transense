from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol

from .persistence import DemoStore, TimestampValidationError, parse_timestamp


class TranscriptionError(ValueError):
    """Raised when a transcription request cannot be safely handled."""


class ProviderConfigurationError(TranscriptionError):
    """Raised when the configured cloud provider lacks required env config."""


class TranscriptionProvider(Protocol):
    name: str
    mode: str

    def transcribe(self, audio: bytes | None = None) -> "TranscriptionResult":
        ...


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    provider: str
    mode: str


def normalize_provider_result(value: Any, provider: str, mode: str = "live") -> TranscriptionResult:
    if isinstance(value, str):
        text = value.strip()
    elif isinstance(value, dict):
        text_value = value.get("text")
        text = text_value.strip() if isinstance(text_value, str) else ""
    else:
        text = ""
    if not text:
        raise TranscriptionError("provider returned no functional transcript text")
    return TranscriptionResult(text=text, provider=provider, mode=mode)


class MockTranscriptionProvider:
    name = "mock"
    mode = "mock"

    def transcribe(self, audio: bytes | None = None) -> TranscriptionResult:
        return normalize_provider_result("Halo, ini transkrip demo percakapan.", self.name, self.mode)


@dataclass(frozen=True)
class CloudSTTConfig:
    endpoint: str
    api_key: str

    @classmethod
    def from_env(cls) -> "CloudSTTConfig":
        endpoint = os.getenv("TRANSENSE_CLOUD_STT_ENDPOINT", "").strip()
        api_key = os.getenv("TRANSENSE_CLOUD_STT_API_KEY", "").strip()
        missing = []
        if not endpoint:
            missing.append("TRANSENSE_CLOUD_STT_ENDPOINT")
        if not api_key:
            missing.append("TRANSENSE_CLOUD_STT_API_KEY")
        if missing:
            raise ProviderConfigurationError(f"missing Cloud STT configuration: {', '.join(missing)}")
        return cls(endpoint=endpoint, api_key=api_key)


class CloudTranscriptionProvider:
    name = "cloud-stt"
    mode = "live"

    def __init__(self, config: CloudSTTConfig):
        self.config = config

    def transcribe(self, audio: bytes | None = None) -> TranscriptionResult:
        raise TranscriptionError("Cloud STT adapter is configured but no provider SDK is installed")


def create_provider() -> TranscriptionProvider:
    provider_name = os.getenv("TRANSENSE_STT_PROVIDER", "mock").strip().lower()
    if provider_name == "mock":
        return MockTranscriptionProvider()
    if provider_name in {"cloud", "cloud-stt"}:
        try:
            return CloudTranscriptionProvider(CloudSTTConfig.from_env())
        except ProviderConfigurationError:
            return MockTranscriptionProvider()
    raise ProviderConfigurationError(f"unsupported transcription provider: {provider_name}")


def persist_transcript(store: DemoStore, result: TranscriptionResult, session_id: str, created_at: datetime, record_id: str) -> str:
    if not record_id.strip():
        raise TranscriptionError("transcript id must be non-empty")
    if not session_id.strip():
        raise TranscriptionError("session_id must be non-empty")
    if not result.text.strip():
        raise TranscriptionError("transcript text must be non-empty")
    try:
        created = parse_timestamp(created_at.isoformat())
    except (TimestampValidationError, AttributeError) as error:
        raise TranscriptionError(str(error)) from error
    payload = {"text": result.text.strip(), "session_id": session_id, "provider": result.provider, "mode": result.mode, "functional": True}
    return store.add("transcript", payload, created, record_id=record_id)


def transcript_history(store: DemoStore, now: datetime) -> list[dict[str, Any]]:
    store.cleanup(now.astimezone(timezone.utc))
    return list(reversed(store.list_records("transcript")))
