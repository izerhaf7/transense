## Purpose

Menyediakan runtime frontend-backend yang dapat diakses melalui deployment demo, mendukung health verification, WebSocket updates, dan konfigurasi dummy yang aman.

## ADDED Requirements

### Requirement: Runtime health visibility
The backend SHALL expose a health check that reports whether the demo runtime is able to serve requests and access its configured persistence layer.

#### Scenario: Runtime is healthy
- **WHEN** the health check is requested while the backend and persistence layer are available
- **THEN** it returns a successful status and an explicit healthy state

#### Scenario: Persistence is unavailable
- **WHEN** the health check is requested while the persistence layer cannot be accessed
- **THEN** it returns a failure status and identifies the runtime as unhealthy

### Requirement: Real-time client connection
The backend SHALL provide a WebSocket connection through which an authorized demo client can receive simulated transit updates and a clear connection or error state.

#### Scenario: Client connects successfully
- **WHEN** a demo client opens the WebSocket endpoint
- **THEN** the backend acknowledges the connection and can deliver subsequent simulated update events

#### Scenario: Client connection fails
- **WHEN** the client cannot establish or maintain the WebSocket connection
- **THEN** the client shows a visible non-audio-only connection state and the shell remains navigable

### Requirement: Documented cross-origin demo access
The deployed demo SHALL provide the PWA and its backend communication through a documented access path that works from an Android browser without requiring a separate local service, even when the PWA and backend are served from different origins.

#### Scenario: User opens the deployed demo
- **WHEN** a user opens the demo PWA URL on an Android browser
- **THEN** the shell loads and the documented backend path is reachable from that browser without a separate local service

#### Scenario: Backend communication is correctly authorized across origins
- **WHEN** the PWA calls the backend REST or WebSocket endpoint from its own origin
- **THEN** the backend accepts the connection and the client receives the expected state or updates

#### Scenario: Demo configuration is missing
- **WHEN** the deployment lacks a required non-secret runtime configuration value
- **THEN** the runtime fails visibly through health verification rather than silently serving a misleading healthy state
