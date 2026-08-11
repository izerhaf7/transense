## Purpose

Menyediakan kontrak data transit dummy yang konsisten untuk status Beranda, tracking, notifikasi, dan Antar Aku tanpa bergantung pada API TransJakarta riil.

## ADDED Requirements

### Requirement: Shared transit entities
The system SHALL represent dummy transit data with stable identifiers and relationships for stops, routes, trips, vehicle positions, ETAs, and incident updates.

#### Scenario: Consumer requests seeded transit data
- **WHEN** a feature requests the seeded transit dataset
- **THEN** the response contains related stop, route, trip, vehicle, ETA, and incident records that can be joined by stable identifiers

#### Scenario: Transit data is incomplete
- **WHEN** a dummy record references an unknown stop, route, trip, or vehicle identifier
- **THEN** the system rejects that seed/update as invalid and does not publish the incomplete record to consumers

### Requirement: Dummy data is explicitly replaceable
The system SHALL expose dummy transit data through a boundary that does not require consumers to know whether the source is simulated or an eventual official TransJakarta integration.

#### Scenario: Demo uses simulated source
- **WHEN** the application runs in the demo configuration
- **THEN** consumers receive seeded or simulated transit data through the shared boundary

#### Scenario: Future source is substituted
- **WHEN** a future implementation replaces the simulated source with an official operator source
- **THEN** consumers can keep their existing entity and event expectations without requiring a user-facing redesign

### Requirement: Transit update events
The system SHALL publish a deterministic simulated update event for transit consumers during a demo session.

#### Scenario: Demo advances a vehicle update
- **WHEN** the demo simulation advances a vehicle or ETA state
- **THEN** subscribed consumers receive an update containing the affected stable identifier, updated value, and event timestamp

#### Scenario: Demo resets its seed state
- **WHEN** an operator resets the demo simulation
- **THEN** the transit dataset returns to its documented seed state and consumers receive a reset indication or refreshed state
