## Purpose

Pengalaman perencanaan rute ala Moovit untuk pengguna Tuli TransJakarta: merencanakan berdasarkan waktu tiba, melihat keterlambatan dan gangguan pada rute, serta menyimpan halte favorit dan riwayat pencarian — audio-blind dan deterministik.

## ADDED Requirements

### Requirement: Arrive-by search
The system SHALL accept an arrival deadline and return the latest feasible departure itinerary that arrives by the deadline.

#### Scenario: Arrival deadline satisfied
- **WHEN** the user requests a plan with `arrive_by`
- **THEN** the system returns itineraries whose last leg arrives no later than the deadline

#### Scenario: Deadline before first trip
- **WHEN** the requested arrival deadline is earlier than the earliest possible trip arrival
- **THEN** the system returns an empty itinerary list without an HTTP error

### Requirement: Per-leg delay display
The system SHALL expose a deterministic delay estimate per BUS leg in plan results, labeled as simulated when realtime is unavailable.

#### Scenario: Deterministic simulated delay
- **WHEN** `include_eta` is set and no realtime client is available
- **THEN** every BUS leg carries `delay_minutes`, `live_eta_minutes`, and `eta_source: "simulated"`, with identical values across identical requests

#### Scenario: Backward compatibility
- **WHEN** `include_eta` is not set
- **THEN** legs carry no ETA fields

### Requirement: Active incident display on route
The system SHALL show active incidents (status `delay`/`diverted`) that affect the planned route, matched by route id or short name, excluding `normal`/`resolved` records.

#### Scenario: Incident filtered and matched
- **WHEN** a `delay`/`diverted` incident exists whose route id or short name matches a BUS leg
- **THEN** the incident appears in the response `incidents` array flagged as affecting the route

#### Scenario: Normal and resolved records excluded
- **WHEN** an incident record has status `normal` or `resolved`
- **THEN** it never appears in the response `incidents` array

#### Scenario: Unmatched active incident still shown
- **WHEN** an active incident's route matches no itinerary leg
- **THEN** the incident still appears in the banner (with `affects_route: false`)

### Requirement: Saved places and search history
The frontend SHALL persist saved stops and recent plan searches in localStorage, with dedupe, caps, and tap-to-fill.

#### Scenario: Saved stop round-trip
- **WHEN** the user saves an origin or destination stop
- **THEN** the stop is persisted, deduped by stop id, capped at 10, and survives a reload

#### Scenario: Search history recency
- **WHEN** the user runs a plan
- **THEN** the origin/destination pair is recorded recent-first, consecutive duplicates merged, capped at 10, and tap-to-refill restores both inputs
