## Context

The repo already parses TransJakarta GTFS (stops, routes, trips, stop_times, shapes) with index maps, exposes `/api/gtfs/*`, `/api/buses`, `/api/arrivals`, `/api/journey/track`, and has a Mapbox renderer that can draw route shapes. What is missing is any origin→destination routing: no transfers/calendar parsing, no walk graph, no RAPTOR engine, no plan endpoint, and the Antar Aku screen is a tracker, not a planner.

## Goals / Non-Goals

**Goals:**
- Implement a deterministic, testable RAPTOR earliest-departure search over the TransJakarta GTFS network (single operator).
- Add OSM-derived walk graph (precompute, offline) for access/egress and transfer walk legs.
- Expose `GET /api/journey/plan` returning up to three itineraries with legs, with graceful `source:"unavailable"` degradation.
- Rework Antar Aku into planner-first UI that draws each leg polyline on Mapbox and then enters tracking for the chosen route.

**Non-Goals:**
- No multi-operator routing (KCI/MRT/LRT).
- No realtime delay overlay on plan results; schedule-based times only.
- No turn-by-turn pedestrian navigation; walk legs use precomputed OSM distances/times.
- No wheelchair/accessibility-specific routing.
- No persistence of plan history.

## Decisions

### RAPTOR over the existing GtfsFeed (pure Python)
Use round-based RAPTOR earliest-departure directly over `stop_times` + transfer/walk edges, instead of embedding OTP/r5/Valhalla. Rationale: TransJakarta is one operator with few corridors and many trips per corridor (RAPTOR's ideal regime); zero preprocessing means schedule or future realtime changes only require re-running; ~200-400 lines, deterministic, pytest-friendly. Alternative considered: OTP/r5/Valhalla — rejected (JVM/native + graph build + OSM street routing, overkill for demo).

### OSM-derived walk graph, precomputed offline
Build a walk graph once (radius-limited around TransJakarta stops) using `osmnx` (or GraphHopper offline) to get real street distances/times between nearby stops and for snapping user coordinates to stops. Cache as an edge list persisted alongside the GTFS cache. No on-demand street routing. If OSM data or dependency is unavailable at runtime, fall back to a deterministic haversine-based walk estimate so the demo still works, labeled `source:"estimate"` per-iteration if needed. Alternative considered: full GraphHopper/OSRM on-demand service — rejected (heavy deployment, deadline risk).

### Calendar-aware trip filtering
Parse `calendar.txt` and `calendar_dates.txt` so only trips running on the requested date are considered. Rationale: without it RAPTOR would offer trips that do not run today. Default request date = today (Asia/Jakarta) when not provided.

### `GET /api/journey/plan` with seed fallback
Endpoint accepts `from_lat/from_lng/to_lat/to_lng` (or `from_stop/to_stop`), optional `time`/`date`; returns `{itineraries:[...], source}` where source is `gtfs` or `unavailable`. When GTFS or walk graph is missing, return `source:"unavailable"` (no error), matching the repo's existing degradation pattern. Deterministic seed fallback mirrors the transit simulator style only if we later add a seeded mini-network; for now unavailable is sufficient.

### Frontend planner-first Antar Aku
AntarAkuPage gets origin + destination inputs backed by `/api/gtfs/stops/search`, a plan action calling `/api/journey/plan`, a leg-list renderer (audio-blind: big text, per-leg route/headsign/time), a Mapbox view that draws each leg's shape via `/api/gtfs/route/{id}/shape`, and after choosing an itinerary, transitions to the existing tracking mode (poll `/api/journey/track`) for the selected route/vehicle.

## Risks / Trade-offs

- [Risk] OSM/osmnx dependency may be heavy or fail to install on some environments → Mitigate: precompute script separate from app runtime; runtime uses cached walk graph; haversine fallback labeled estimate.
- [Risk] TJ GTFS trip_ids may not match realtime trip_ids used by journey/track → Track phase reuses existing endpoint as-is; plan phase uses static schedule; verify mapping later.
- [Risk] Walk graph build over Jakarta is large → Restrict radius (~1 km) and only around TransJakarta stops; cap edges per stop.
- [Risk] RAPTOR without calendar gives wrong-day results → calendar parsing is a prerequisite task ordered before planner.
- [Risk] Phone-only demo payloads → Keep itineraries small: leg id/name/times/duration/distance/route/headsign; no turn-by-turn geometry.

## Migration Plan

1. Extend `gtfs_loader.py`: parse `transfers.txt` + `calendar.txt`/`calendar_dates.txt` (backward-compatible additive fields).
2. Add walk graph build (precompute script) + loader that returns walk edges with fallback.
3. Add `backend/planner.py`: RAPTOR earliest-departure returning itinerary legs.
4. Add `GET /api/journey/plan` endpoint with source degradation.
5. Rework frontend Antar Aku: planner inputs → plan call → leg list + Mapbox polyline → tracking phase.
6. Add backend pytest for planner + endpoint; extend frontend contract guard; validate OpenSpec strict.
