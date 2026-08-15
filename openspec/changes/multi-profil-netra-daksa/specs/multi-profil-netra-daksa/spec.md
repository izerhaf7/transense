## Purpose

Perluasan Transense dari profil Tuli-only ke 3 profil tunggal (Tuli/Netra/Daksa) dengan lapisan rendering per-profil, TTS untuk Netra, deteksi armada via kamera, dan info fasilitas/okupansi untuk Daksa — kerangka demo (userflow).

## ADDED Requirements

### Requirement: Profile model and selection
The system SHALL store an active profile type (`tuli` | `netra` | `daksa`) with the user profile and SHALL select it during onboarding, migrating existing v1 profiles to v2 with a `tuli` default.

#### Scenario: Profile migration from v1
- **WHEN** an existing v1 profile (`displayName`) is read
- **THEN** the system migrates it to v2 silently with `profile: "tuli"`, preserving `displayName`

#### Scenario: Unknown profile type
- **WHEN** a stored `profile` value is not one of the three known types
- **THEN** the system falls back to `"tuli"` without crashing

### Requirement: Per-profile notification rendering
The system SHALL render each notification event differently per active profile: visual+haptic for `tuli`, audio (TTS)+haptic+visible text twin for `netra`, visual+haptic with larger text for `daksa`.

#### Scenario: Netra notification announces aloud
- **WHEN** a notification is emitted for a `netra` profile
- **THEN** the TTS layer speaks the notification and a visible text twin is rendered

### Requirement: Text-to-speech layer
The system SHALL expose a TTS endpoint (backend, server-side key) and a frontend TTS provider that degrades to visible text when audio fails.

#### Scenario: TTS key missing
- **WHEN** the ElevenLabs key or TTS voice id is not configured
- **THEN** `/api/tts` returns 503 and the frontend falls back to visible text

### Requirement: Netra camera detection
The system SHALL detect an approaching bus via the phone camera using MediaPipe Object Detector (COCO "bus") in a Web Worker, and SHALL provide a simulated-detection mode for deterministic demos.

#### Scenario: Bus detected
- **WHEN** a bus is detected with sufficient confidence
- **THEN** the approach heuristic triggers a TTS announcement and vibration

#### Scenario: Camera denied or API blocked
- **WHEN** camera permission is denied or the Vision API key is missing
- **THEN** the app degrades to a visible camera feed (or simulated mode) with a readable Indonesian error, never crashing

### Requirement: OCR corridor number via backend proxy
The system SHALL extract the bus corridor number via Google Cloud Vision OCR called through a backend proxy (browser CORS not supported), invoked periodically (2–3 s), not per-frame.

#### Scenario: OCR unavailable
- **WHEN** the Vision API key is missing or OCR fails
- **THEN** `/api/vision/ocr` degrades to `source: "unavailable"` and the app continues in camera-only mode

### Requirement: Daksa facility data and occupancy
The system SHALL expose seeded facility data for 3–5 iconic stops and a time-varying wheelchair occupancy estimate, plus a ramp-request action to a simulated staff channel.

#### Scenario: Ramp request
- **WHEN** a `daksa` user taps "Minta petugas siapkan ramp"
- **THEN** a ramp-request event is sent to the staff channel and a confirmation is shown

### Requirement: Side by Side per profile
The system SHALL render the same facility data model two ways: a visual 360°/annotated view for `daksa`, and a verbal (TTS) list with a visible text twin for `netra`.

#### Scenario: Netra verbal Side by Side
- **WHEN** a `netra` user opens Side by Side
- **THEN** each stop's facilities are spoken via TTS and shown as large text
