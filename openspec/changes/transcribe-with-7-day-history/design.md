## Context

The foundation provides the React/Vite shell, FastAPI/WebSocket boundary, SQLite `DemoStore`, UTC timestamp validation, and centralized seven-day cleanup. This change adds conversation transcription without changing the foundation's deterministic transit contracts.

## Goals / Non-Goals

**Goals:**

- Keep microphone capture and Cloud STT behind the FastAPI backend.
- Preserve audio-blind output, visible session/error states, and accuracy over latency.
- Reuse the foundation persistence and pinned-cleanup mechanism for functional transcript text.
- Provide a deterministic mock transcript fallback for demo and offline testing.

**Non-Goals:**

- No PA/speaker transcription, ambient-audio archive, speaker identification, diarization, or on-device inference.
- No production authentication or multi-user tenancy.
- No Cloud STT credential in browser code, source control, or committed example values.

## Decisions

### Additive WebSocket transcription messages

Keep `/api/ws` and the `transit-demo.v1` connection contract intact. Add a separate message type namespace for transcription session start/stop and transcript results so existing transit consumers remain compatible. A REST fallback may be used for seeded transcripts, but the frontend never receives provider secrets.

### Provider adapter with explicit mock fallback

Define a provider-neutral transcription boundary. The configured Cloud STT adapter is selected by environment configuration; a deterministic mock adapter supplies a visibly labeled result when configuration, network, or provider response is unavailable. The mock path is a demo fallback, not production transcription.

### Functional-text-only persistence

Persist only accepted functional transcript text and metadata through `DemoStore`. Do not write raw audio or ambient-noise events. Use the existing UTC timestamp validation, seven-day cleanup, and pinned marker rather than creating a second retention system.

### Android-first permission and QA

Microphone permission, readable transcript layout, network failure state, and history behavior must be checked on Android. iOS/Safari is not the haptic target, but this change does not add haptic behavior itself.

## Risks / Trade-offs

- [Risk] Cloud STT latency or outage blocks live results → Mitigate with visible degraded state and deterministic mock transcript fallback.
- [Risk] Raw audio could be retained accidentally → Keep audio handling in the request path and persist only validated transcript text.
- [Risk] Provider response formats vary → Normalize through the provider adapter before exposing the stable transcript message contract.
- [Risk] A free Cloud Run instance may restart during a session → Keep session state recoverable and history in the shared persistence boundary; never imply uninterrupted production streaming.

## Migration Plan

1. Add transcript contracts, mock provider, and unit tests without changing transit messages.
2. Add Cloud STT adapter and environment-only credential loading.
3. Add frontend microphone/session/history screens with visible fallback states.
4. Verify retention/pinned behavior, then Android microphone and readability flow.
