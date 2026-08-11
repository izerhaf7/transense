## Purpose

Menyediakan tampilan jadwal, posisi armada, dan ETA TransJakarta yang deterministik untuk demo, dengan kontrak data yang dapat diganti sumber stasiun/lin/jadwal tanpa mengubah perilaku konsumen.

## ADDED Requirements

### Requirement: Deterministic schedule and fleet display
The system SHALL display the seeded schedule, vehicle positions, and ETA values from the shared transit contract as the source of truth for the demo journey features.

#### Scenario: User opens the schedule screen
- **WHEN** a user opens the Jadwal TransJakarta screen with the backend connected
- **THEN** the screen shows the seeded routes, trips, vehicle positions, and ETA values from the shared transit state

#### Scenario: Seeded ETA state is deterministic
- **WHEN** the demo starts or resets to its seed state
- **THEN** the schedule and fleet screen shows the documented seed ETA values for the seeded vehicles

### Requirement: Real-time schedule updates over WebSocket
The system SHALL deliver vehicle and ETA update events to the schedule and fleet screen through the existing WebSocket connection so the displayed schedule advances during the demo.

#### Scenario: Vehicle update reaches the schedule screen
- **WHEN** a documented simulated update for a seeded vehicle is published over the WebSocket
- **THEN** the schedule and fleet screen reflects the updated ETA and position for that vehicle

#### Scenario: Reset restores the schedule screen
- **WHEN** the demo resets the simulated transit state
- **THEN** the schedule and fleet screen returns to the seeded ETA values and shows the restored state

### Requirement: Replaceable station, line, and timetable source
The system SHALL allow an optional public REST/OpenAPI source for TransJakarta stations, lines, and timetables to replace the seeded station data, and SHALL fall back to seed data when that source is unavailable or not configured.

#### Scenario: Optional source provides TJ station data
- **WHEN** the optional Commute API source is configured and reachable
- **THEN** the system uses the station, line, and timetable data from that source for the schedule display with documented attribution

#### Scenario: Optional source is unavailable
- **WHEN** the optional Commute API source is unreachable, misconfigured, or not configured
- **THEN** the system falls back to the seeded station, line, and timetable data without breaking the schedule display

#### Scenario: Attribution is visible
- **WHEN** the schedule display uses data from the optional public source
- **THEN** the display shows the source attribution required by the data license

### Requirement: Explicit simulation boundary for fleet data
The system SHALL clearly mark schedule and tracking data as demo simulation and SHALL NOT imply that live vehicle positions or official incident feeds come from a real TransJakarta integration.

#### Scenario: User views fleet data
- **WHEN** a user views the schedule and fleet screen
- **THEN** the screen visibly labels the vehicle positions and ETA values as simulated demo data

#### Scenario: No real-time feed is claimed
- **WHEN** the schedule and fleet screen is displayed
- **THEN** the screen does not represent vehicle positions or incident information as live official TransJakarta data
