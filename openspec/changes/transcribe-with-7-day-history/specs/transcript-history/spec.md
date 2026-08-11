## Purpose

Menyediakan histori transkrip percakapan fungsional yang dapat dibaca ulang selama tujuh hari dengan pengecualian simpan yang eksplisit.

## ADDED Requirements

### Requirement: Functional transcript persistence
The system SHALL persist a functional transcript record with a stable identifier, valid creation timestamp, session context, and readable text.

#### Scenario: User reopens transcript history
- **WHEN** the user opens a later application session before the retention rule removes a functional transcript
- **THEN** the transcript remains readable in history

#### Scenario: Invalid transcript metadata is submitted
- **WHEN** a transcript record lacks a valid timestamp or stable identifier
- **THEN** the system rejects the record rather than persisting ambiguous history

### Requirement: Seven-day transcript retention
The system SHALL apply the shared seven-day cleanup policy to non-pinned transcript records.

#### Scenario: Transcript exceeds retention
- **WHEN** cleanup runs and an unpinned transcript is older than seven days
- **THEN** the transcript is absent from history queries

#### Scenario: Transcript is within retention
- **WHEN** cleanup runs and a transcript is no older than seven days
- **THEN** the transcript remains available in history

### Requirement: Explicit transcript save
The system SHALL allow the user to mark a functional transcript as saved and SHALL preserve that record during ordinary cleanup until the marker is removed.

#### Scenario: User pins a transcript
- **WHEN** the user marks a transcript as saved
- **THEN** cleanup preserves the transcript beyond seven days

#### Scenario: User unpins an old transcript
- **WHEN** the user removes the save marker from a transcript already older than seven days
- **THEN** the next cleanup makes the transcript eligible for deletion
