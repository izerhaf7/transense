## Purpose

Menyediakan pencarian rute transit tercepat dari titik asal ke titik tujuan pada jaringan TransJakarta, dengan itinerary berbentuk leg jalan kaki dan naik bus yang dapat digambar di peta dan ditampilkan audio-blind.

## ADDED Requirements

### Requirement: Origin-destination route search
The system SHALL accept an origin and a destination (as stop ids or coordinates) and SHALL return one or more itineraries from origin to destination over the TransJakarta GTFS network, ordered by total travel time.

#### Scenario: Origin and destination on the network
- **WHEN** the user requests a plan from a valid origin to a valid destination
- **THEN** the system returns at least one itinerary when a route exists, with legs and total duration

#### Scenario: No route exists
- **WHEN** the requested origin and destination cannot be connected by the available network
- **THEN** the system returns an explicit no-route result without an HTTP error

#### Scenario: Transit data unavailable
- **WHEN** the GTFS feed or walk graph is not loaded
- **THEN** the system returns `source: "unavailable"` instead of an error, and the frontend degrades gracefully

### Requirement: Itinerary legs
Each returned itinerary SHALL consist of ordered legs, each either a walk leg or a transit leg, with times, durations, distances, and for transit legs the route and headsign.

#### Scenario: Walk access and egress legs
- **WHEN** the origin or destination is not itself a stop
- **THEN** the itinerary includes walk legs from the origin to the boarding stop and from the alighting stop to the destination, using the OSM-derived walk graph

#### Scenario: Transit leg metadata
- **WHEN** an itinerary contains a transit leg
- **THEN** the leg includes boarding/alighting stop, departure/arrival time, route id and short name, headsign, and duration

### Requirement: Transfer support
The system SHALL support transfers between transit trips, either via parsed `transfers.txt` or via the walk graph between nearby stops.

#### Scenario: Single-trip route
- **WHEN** a direct trip connects origin and destination
- **THEN** the itinerary contains a single transit leg (plus walk access/egress)

#### Scenario: Multi-trip route with transfer
- **WHEN** no single trip connects origin and destination but a connection exists
- **THEN** the itinerary contains multiple transit legs separated by transfer legs or walk legs

### Requirement: Service-day filtering
The system SHALL consider only trips that run on the requested date, using parsed calendar and calendar_dates data.

#### Scenario: Trip not running on requested day
- **WHEN** a trip's service is not active on the requested date
- **THEN** the trip is not offered as a transit leg in any itinerary

### Requirement: Route alternatives
The system SHALL return up to three distinct itineraries when multiple reasonable routes exist, so the user can choose.

#### Scenario: Multiple routes available
- **WHEN** more than one reasonable itinerary exists between origin and destination
- **THEN** the system returns up to three alternatives ordered by total duration
