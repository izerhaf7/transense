## Purpose

Menyediakan notification engine untuk status perjalanan dan insiden resmi yang tersimulasi, renderer visual audio-blind dengan pola getar khas di Android, serta histori insiden selama 7 hari.

## ADDED Requirements

### Requirement: Travel status notification events
The system SHALL generate notification events for approaching vehicle and approaching destination stop from the simulated fleet state during an active journey.

#### Scenario: Vehicle approaches the origin stop
- **WHEN** a simulated vehicle on an active journey reaches the documented approach threshold at the origin stop
- **THEN** the system presents an approaching vehicle notification to the user

#### Scenario: Destination stop approaches
- **WHEN** a simulated vehicle on an active journey reaches the documented approach threshold at the destination stop
- **THEN** the system presents an approaching destination stop notification to the user

### Requirement: Official incident notification events
The system SHALL generate structured official delay and incident notifications whose content includes status, cause, action, instruction, and update timestamp, and SHALL send progressive updates as the simulated situation changes.

#### Scenario: Official incident is published
- **WHEN** the simulated incident feed publishes a delay or incident for a route
- **THEN** the system presents a structured notification containing the incident status, cause, action, instruction, and update timestamp

#### Scenario: Incident situation progresses
- **WHEN** the simulated incident feed updates an existing incident
- **THEN** the system presents a new notification for the updated situation rather than mutating the previously presented notification

### Requirement: Audio-blind visual rendering
The system SHALL render every notification with large readable text, high contrast, and a visible screen-edge flash so notification content is not conveyed by audio alone.

#### Scenario: User receives a notification
- **WHEN** any notification is presented to the user
- **THEN** the user sees large high-contrast text and a visible edge flash indicating the notification without needing to hear a sound

#### Scenario: Notification is acknowledged or expires
- **WHEN** the user dismisses a notification or its display window ends
- **THEN** the edge flash stops and the screen returns to the active screen state

### Requirement: Distinct vibration patterns per notification type
The system SHALL trigger a distinct vibration pattern on Android for each notification category: approaching vehicle, approaching destination stop, and official incident, and SHALL NOT rely on vibration as the only notification channel.

#### Scenario: Approaching vehicle notification vibrates
- **WHEN** an approaching vehicle notification is presented on an Android device
- **THEN** the device vibrates with the documented approaching vehicle pattern

#### Scenario: Destination stop notification vibrates
- **WHEN** an approaching destination stop notification is presented on an Android device
- **THEN** the device vibrates with the documented destination stop pattern, distinct from the approaching vehicle pattern

#### Scenario: Official incident notification vibrates
- **WHEN** an official incident notification is presented on an Android device
- **THEN** the device vibrates with the documented official incident pattern, distinct from both travel status patterns

### Requirement: Seven-day incident history
The system SHALL persist official incident notifications as readable history for seven days and SHALL remove non-exempt incident records older than seven days through the shared cleanup lifecycle.

#### Scenario: User reads incident history within retention
- **WHEN** a user opens the Keterlambatan feed after an incident notification was created
- **THEN** the incident remains readable in the history feed with its structured content

#### Scenario: Incident history passes seven days
- **WHEN** the shared cleanup runs and a non-exempt incident record is older than seven days
- **THEN** the incident is no longer returned by the history feed

#### Scenario: User saves an incident record
- **WHEN** the user marks an incident record as saved
- **THEN** the seven-day cleanup preserves that record until the save marker is removed

### Requirement: Explicit official-feed simulation boundary
The system SHALL label official incident notifications and history as simulated demo data and SHALL NOT represent them as live data from an official TransJakarta production feed.

#### Scenario: User views incident history
- **WHEN** a user opens the Keterlambatan feed
- **THEN** the feed visibly labels incident entries as simulated demo data

#### Scenario: No production incident integration is implied
- **WHEN** any incident notification or history entry is displayed
- **THEN** the display does not claim a live connection to an official TransJakarta incident source
