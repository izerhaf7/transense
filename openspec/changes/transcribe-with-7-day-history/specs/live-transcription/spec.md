## Purpose

Menyediakan transkripsi percakapan langsung antara pengguna Tuli dan lawan bicara melalui mikrofon ponsel, dengan fallback demo yang jujur ketika layanan cloud tidak tersedia.

## ADDED Requirements

### Requirement: Conversation microphone session
The system SHALL allow a user to start and stop a microphone session intended for person-to-person conversation, not public-address announcements.

#### Scenario: Microphone permission is granted
- **WHEN** the user starts a transcription session and grants microphone permission
- **THEN** the application shows a visible active-session state and sends conversation audio through the backend transcription boundary

#### Scenario: Microphone permission is denied
- **WHEN** the user starts a transcription session and denies microphone permission
- **THEN** the application shows a visible explanation and remains navigable without pretending that transcription is active

### Requirement: Cloud transcription boundary
The backend SHALL send eligible conversation audio to the configured Cloud STT provider and return readable transcript results without exposing provider credentials to the frontend.

#### Scenario: Transcript result is received
- **WHEN** the configured provider returns a usable conversation result
- **THEN** the frontend displays the result as large readable text with a visible timestamp or session context

#### Scenario: Provider configuration is unavailable
- **WHEN** required non-secret configuration or the Cloud STT credential is unavailable
- **THEN** health/session state is visibly degraded and the application uses the explicit seeded/mock transcript fallback rather than claiming a live result

### Requirement: Conversation-only scope
The system SHALL exclude public-address announcements, ambient noise, speaker identification, diarization, and audio history from the transcription feature.

#### Scenario: Ambient audio is detected
- **WHEN** captured audio contains no functional conversation result
- **THEN** the system does not persist the ambient audio or represent it as a saved transcript record
