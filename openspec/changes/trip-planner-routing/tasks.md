## 1. GTFS Data Extensions (backend)

- [x] 1.1 Parse `transfers.txt` (from_stop_id, to_stop_id, transfer_type, min_transfer_time) into `GtfsFeed.transfers`; backward-compatible
- [x] 1.2 Parse `calendar.txt` + `calendar_dates.txt` (service_id → active weekdays + exception dates) into `GtfsFeed.calendar`/`calendar_dates`
- [x] 1.3 Unit test: transfers and calendar parsing, service-day active check, backward compatibility with existing feed load

## 2. Walk Graph (backend, OSM precompute)

- [x] 2.1 Add walk-graph build script (osmnx/GraphHopper offline) producing cached edge list: nearby stop pairs with street distance/time; radius-limited (~1 km)
- [x] 2.2 Add walk-graph loader + haversine fallback (labeled estimate) when OSM cache/dependency unavailable at runtime
- [x] 2.3 Unit test: walk graph load, snapping user coordinates to stops, fallback behavior

## 3. RAPTOR Planner (backend)

- [x] 3.1 Implement `backend/planner.py`: RAPTOR earliest-departure over stop_times + transfer/walk edges, calendar-filtered by requested date
- [x] 3.2 Build itinerary legs model: walk legs + transit legs (from/to stop, times, duration, distance, route id/name, headsign)
- [x] 3.3 Return up to three alternatives ordered by total duration
- [x] 3.4 Unit test: single-trip route, multi-trip with transfer, no-route, walk access/egress, service-day filtering

## 4. Plan Endpoint (backend)

- [x] 4.1 Add `GET /api/journey/plan` accepting coordinates or stop ids, optional date/time; return `{itineraries, source}`
- [x] 4.2 Degradation: return `source:"unavailable"` (no HTTP error) when GTFS or walk graph missing
- [x] 4.3 API test: happy path, no-route, unavailable, validation of bad params

## 5. Frontend Planner UI (Antar Aku)

- [x] 5.1 Rework AntarAkuPage: origin + destination inputs backed by `/api/gtfs/stops/search`; plan action
- [x] 5.2 Render leg list (audio-blind: large text, per-leg route/headsign/time/walk) + choose itinerary
- [x] 5.3 Draw each leg polyline via `/api/gtfs/route/{id}/shape` on MapboxMap; show walk legs distinctly
- [x] 5.4 After choosing itinerary, transition to tracking mode (existing `/api/journey/track` polling)
- [x] 5.5 Degraded/no-route state visible without audio-only cues

## 6. Verification

- [x] 6.1 Backend pytest suite green (new planner + endpoint tests + existing)
- [x] 6.2 Frontend typecheck/build + extend contract guard for plan contract strings
- [x] 6.3 `openspec validate "trip-planner-routing" --strict` passes
- [ ] 6.4 Manual browser check: plan A→B renders legs + map, alternatives switchable, tracking follows chosen route
