# antar-aku-journey Specification

## Purpose
Menyediakan alur perjalanan Antar Aku yang memadukan input tujuan, pencocokan halte dummy, rute halte-ke-halte sederhana, state perjalanan, integrasi notifikasi, dan simulasi keluar-rute untuk demo terkontrol.
## Requirements
### Requirement: Destination input and nearest-stop matching
The system SHALL accept a destination input and SHALL match the origin and destination to the nearest TransJakarta stops using the deterministic seeded context without real geolocation.

#### Scenario: User enters a destination
- **WHEN** a user enters a destination text in the Antar Aku flow
- **THEN** the system matches the destination to the nearest seeded stop and presents the matched origin and destination stops

#### Scenario: No seeded stop matches the input
- **WHEN** the destination input does not match any seeded stop
- **THEN** the system shows a visible no-match state instead of fabricating a stop

### Requirement: Simple stop-to-stop route
The system SHALL present a simple readable route from the matched origin stop to the matched destination stop using the shared route contract.

#### Scenario: Route is presented
- **WHEN** a journey has matched origin and destination stops connected by the shared route data
- **THEN** the user sees a simple readable route between the origin and destination stops

#### Scenario: Route data is insufficient
- **WHEN** the shared route data cannot produce a route between the matched stops
- **THEN** the system shows a visible route-unavailable state rather than a fabricated route

### Requirement: Journey state tracking
The system SHALL track the Antar Aku journey through explicit states and SHALL keep the current journey state visible and recoverable across screen changes within the session.

#### Scenario: User starts a journey
- **WHEN** a user confirms a matched route
- **THEN** the system enters an active journey state and shows the planned route with origin and destination stops

#### Scenario: User switches screens during a journey
- **WHEN** a user navigates to another screen while a journey is active
- **THEN** the active journey state remains available so the user can return to it in the same session

#### Scenario: User ends the journey
- **WHEN** the user ends or completes the journey
- **THEN** the system clears the active journey state and returns to the entry state

### Requirement: Journey notification integration
The system SHALL integrate approaching vehicle, approaching destination stop, and official incident notifications into the active Antar Aku journey.

#### Scenario: Vehicle notification occurs during a journey
- **WHEN** an approaching vehicle or destination stop notification is presented for a vehicle on the active journey
- **THEN** the user sees the notification within the journey context with the documented vibration pattern

#### Scenario: Incident affects the journey route
- **WHEN** an official incident notification is presented for the journey route
- **THEN** the user sees the structured incident notification within the journey context with the documented incident vibration pattern

### Requirement: Controlled off-route simulation
The system SHALL provide a controlled trigger that simulates the user leaving the planned route for the demo recording and SHALL present the resulting off-route warning without real geolocation.

#### Scenario: Operator triggers off-route simulation
- **WHEN** the documented debug trigger for off-route is activated during an active journey
- **THEN** the system presents a visible off-route warning in the journey context

#### Scenario: Off-route warning is resolved
- **WHEN** the off-route simulation is cleared or the journey returns to the route
- **THEN** the journey shows the resolved state without claiming a real position fix

