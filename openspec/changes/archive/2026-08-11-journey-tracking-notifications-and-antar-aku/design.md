## Context

See `proposal.md` for the motivation and user-facing scope. The repository has an implemented foundation: a React + Vite PWA shell (`frontend/`) and a FastAPI + WebSocket backend (`backend/`) with a deterministic `transit-demo.v1` protocol over `/api/ws`, a shared transit contract seeded as `stop-kp`/`stop-bun`/`route-1`/`trip-1`/`vehicle-kp-01`, SQLite persistence with centralized 7-day cleanup and a pinned exemption flag, and a documented Vercel + Google Cloud Run deployment. The foundation explicitly leaves schedule tracking, notifications, and Antar Aku as placeholders.

This change turns those placeholders into the functional demo spine: a schedule/fleet view, a notification engine with audio-blind rendering and distinct Android vibration patterns, a 7-day incident feed, and the Antar Aku journey flow with a controlled off-route trigger. All transit, incident, and off-route data remains deterministic simulation; an optional public station/line/timetable API may replace seed data only for those static entities, never for live vehicle positions or official incidents.

## Goals / Non-Goals

**Goals:**

- Deliver a schedule and fleet screen driven by the existing `/api/ws` simulated feed so the demo has one visible transit narrative.
- Build a notification engine that renders every notification audio-blind (large high-contrast text, edge flash) and vibrates with a distinct pattern per notification type on Android.
- Persist official incident notifications for seven days through the existing SQLite cleanup lifecycle, with a visible save/pin escape hatch.
- Wire Antar Aku as the journey layer that consumes the same fleet state, receives the same notifications, and exposes a manual off-route trigger for recorded demos.
- Keep an optional, replaceable station/line/timetable source (Commute Data Platform, public REST/OpenAPI, ODbL) with deterministic seed fallback, so the demo does not depend on network availability.
- Keep every mock/simulation boundary explicit in the UI.

**Non-Goals:**

- No real geolocation for user position, destination matching, or off-route deviation detection; all position matching stays on seeded context.
- No official TransJakarta live vehicle feed or official incident production integration; live/incident events stay deterministic simulation.
- No full interactive map if a simple static route presentation suffices for the demo.
- No computer vision/OCR, indoor walking navigation, wrong-direction vibration, wheelchair/mobility profiles, Buddy Up!, or wearable/IoT bands.
- No production authentication; the demo profile stays local.

## Decisions

### Extend the existing WebSocket protocol with notification events instead of a separate channel

Keep `/api/ws` as the single real-time channel. The `transit-demo.v1` protocol gains additive notification messages (`notification.vehicle_approaching`, `notification.destination_approaching`, `notification.incident`, `journey.off_route`), each with a stable `event_id` and UTC `occurred_at` timestamp. The existing `connection.ack`, `transit.update`, `transit.reset`, and `error` messages remain unchanged so the foundation contract stays backward compatible.

**Why not a separate notification socket:** a second socket doubles reconnection, origin-check, and CORS surface for no demo benefit. **Alternative considered:** REST polling for notifications. Rejected because the demo already has a live WebSocket and the notification engine is inherently event-driven.

### Deterministic notification engine driven by fleet thresholds

The backend derives travel-status notifications from the simulated fleet state. When an active journey subscribes to a seeded vehicle, the engine evaluates approach thresholds: approaching vehicle at a documented ETA threshold at the origin stop, and destination approaching at a documented ETA threshold at the destination stop. Official incidents come from the deterministic incident feed with structured content (status, cause, action, instruction, update timestamp) and emit progressive notifications as the simulated situation changes.

**Why backend-driven:** one simulator keeps notification timing deterministic and testable in unit tests, and both the schedule screen and Antar Aku consume the same events. **Alternative considered:** frontend-only notification derivation. Rejected because it splits the demo logic across two runtimes and makes Android verification harder to reproduce.

### Audio-blind renderer: large text, high contrast, edge flash

Every notification renders as a full-screen readable banner with oversized text and semantic status colors (`color-status-safe` for travel status, `color-status-danger` for incidents), plus a high-contrast screen-edge flash overlay. The flash is pure visual output (CSS animation), never audio-dependent, and stops on dismiss or expiry. The existing semantic token system is the only color source.

**Why an overlay banner:** a modal would block the linear navigation flow Tuli users preferred; a non-modal high-contrast banner preserves context while still demanding attention. **Alternative considered:** OS-level push notifications. Rejected because push is unreliable in a PWA demo and cannot guarantee the documented vibration pattern per type on all Android builds.

### Distinct vibration patterns validated on the demo Android device

Define three documented patterns as demo defaults, each an array of `[vibrate, pause, ...]` milliseconds passed to `navigator.vibrate()`:

| Notification type | Default pattern (ms) | Rationale |
|---|---|---|
| Approaching vehicle | `[200, 100, 200]` | Short double pulse, feels like routine arrival |
| Destination stop approaching | `[300, 100, 300, 100, 300]` | Three longer pulses, more emphatic than arrival |
| Official incident | `[500, 200, 500, 200, 1000]` | Long alarming burst with a trailing gap, clearly distinct from routine |

These defaults are committed as documented values so unit tests can assert pattern distinctness and the frontend can be verified on Android. Final calibration stays an open question until validated on the physical demo device; the renderer must fall back to visual-only output when `navigator.vibrate` is unavailable (for example iOS/Safari), because vibration is never the only channel.

**Why three distinct patterns:** the brief requires users to distinguish urgent incident information from routine travel status without looking at the screen. **Alternative considered:** one generic vibration for all notifications. Rejected because it violates the distinct-pattern requirement validated in interviews.

### Incident history reuses the foundation persistence boundary

Official incident notifications are persisted through `DemoStore` as `record_type: "incident"` with the structured payload and `created_at` timestamp, so the existing centralized 7-day cleanup and pinned-flag semantics apply unchanged. The Keterlambatan tab reads incident history from the same store and renders it readably, with an explicit save action per record.

**Why reuse `DemoStore`:** the foundation already centralizes cleanup, timestamp validation, and pinned exemptions; a second storage path would fork the 7-day rule. **Alternative considered:** frontend localStorage history. Rejected because it would bypass the tested persistence boundary and diverge from the shared retention contract.

### Antar Aku is a frontend journey state machine over seeded context

Antar Aku runs as a client-side state machine (`entry -> matching -> route -> active -> ended`) built on the shared transit state. Destination matching uses deterministic seeded stop context, never browser geolocation. Route presentation is a simple readable stop-to-stop list from the shared route contract; a full interactive map is deferred unless the simple presentation fails the demo. The off-route warning is a controlled debug trigger (visible demo control) that sets an off-route state and renders the documented warning, then clears back to the active state.

**Why client-side:** the journey is presentation logic over events the backend already emits; keeping it client-side avoids adding server session state to a stateless demo backend. **Why no geolocation:** the brief marks off-route as mock for the demo, and real position tracking is a later upgrade with its own privacy surface. **Alternative considered:** backend journey sessions. Rejected for demo simplicity and Cloud Run statelessness.

### Optional replaceable station/line/timetable source with seed fallback

A documented configuration flag points the schedule screen at the public Commute Data Platform REST/OpenAPI source (`https://api.commute.shiorilabs.id`, ODbL-1.0) as an optional provider of TransJakarta stations, lines, and timetables, mapped into the existing shared contract and attributed in the UI. If the flag is absent, the source is unreachable, or mapping fails, the system transparently falls back to the seeded station data. This source is strictly limited to static entities: it is never used for live vehicle positions, ETAs, or incidents, which remain deterministic simulation.

**Why optional and replaceable:** the brief forbids depending on an unsecured TransJakarta API while requiring a replaceable data contract. The public source demonstrates a real integration path without making the demo network-dependent. **Alternative considered:** hard-coding a dependency on the public API. Rejected because the demo must be recordable offline and on flaky conference networks.

## Risks / Trade-offs

- [Risk] `navigator.vibrate()` behavior differs across Android browsers and firmware → Mitigate by unit-testing pattern definitions, verifying on the actual demo device before recording, and always keeping the visual output as the primary channel.
- [Risk] The optional public source may be slow, rate-limited, or change schema → Mitigate with a short timeout, strict mapping validation, transparent seed fallback, and visible attribution only when the source is actually used.
- [Risk] Cloud Run scale-to-zero and ephemeral SQLite can erase incident history between recordings → Mitigate by keeping deterministic seed incidents in the simulation and treating persisted history as demo-scoped, with the local replay path available.
- [Risk] Notification volume during a busy demo could overwhelm the linear UI → Mitigate by rendering notifications non-modally and letting approach thresholds be documented demo constants that recording can tune.
- [Risk] Off-route as a manual trigger may look fake if unlabeled → Mitigate with explicit "simulasi" labeling and a controlled debug control consistent with the existing `Simulasikan ETA -1 menit` pattern.

## Migration Plan

1. Extend the WebSocket protocol with additive notification event messages and unit-test their contracts against the existing `/api/ws`.
2. Implement the backend notification engine (travel status thresholds + incident feed) and persist incidents through `DemoStore`.
3. Implement the schedule/fleet screen consuming the existing simulated feed.
4. Implement the audio-blind notification renderer (large text, edge flash, vibration patterns) and verify vibration on Android.
5. Wire the Keterlambatan tab to the 7-day incident history with save/pin.
6. Implement the Antar Aku journey flow and the controlled off-route trigger.
7. Add the optional Commute Data Platform source with seed fallback and attribution.
8. Validate on a real Android device (onboarding -> Beranda -> Keterlambatan -> Antar Aku -> Profil, vibration for all three types), run backend tests, and keep the local replay path working.

## Open Questions

- Exact vibration durations and pauses remain subject to validation on the physical Android device; the committed defaults are documented stand-ins.
- Whether the optional public Commute Data Platform source is shown during the submission recording or stays an environment-enabled demo option; this does not change the specs.
