## 1. Contracts & Provider Boundary

- [x] 1.1 Define additive transcription session/result/error messages compatible with `/api/ws` and document the JSON contract
- [x] 1.2 Implement provider-neutral transcription adapter and deterministic labeled mock provider
- [x] 1.3 Implement environment-only Cloud STT configuration validation without exposing credentials to frontend code
- [x] 1.4 Unit test provider normalization, mock fallback, and missing-configuration errors

## 2. Backend Capture & Persistence

- [x] 2.1 Implement backend session start/stop handling for conversation microphone input
- [x] 2.2 Reject unsupported PA/ambient/audio-history paths and persist only functional transcript text
- [x] 2.3 Reuse `DemoStore` for stable transcript IDs, UTC timestamps, pinned flag, and seven-day cleanup
- [x] 2.4 Add transcript history query and save/unpin operations
- [x] 2.5 Unit test timestamp rejection, seven-day boundary, pinned exemption, and history ordering

## 3. Frontend Transcribe Flow

- [x] 3.1 Add Transcribe screen and visible microphone permission/session states
- [x] 3.2 Render large readable transcript results with explicit live/mock/degraded labels
- [x] 3.3 Add start/stop controls and visible connection/provider error states
- [x] 3.4 Add transcript history list with readable timestamps and save/unpin controls
- [x] 3.5 Add fallback mock transcript flow that works without Cloud STT credentials

## 4. Verification & Android QA

- [x] 4.1 Run backend and frontend type/test/build checks for transcription
- [x] 4.2 Verify no raw audio or ambient-noise record is persisted
- [x] 4.3 Verify Android microphone permission, conversation transcript readability, and degraded fallback
- [x] 4.4 Verify transcript history survives reopen, cleans after seven days, and preserves pinned records
- [x] 4.5 Validate `openspec validate "transcribe-with-7-day-history" --strict`
