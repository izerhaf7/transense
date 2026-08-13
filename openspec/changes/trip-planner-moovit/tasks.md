## 1. Arrive-by (backend)

- [x] 1.1 Add `arrive_by` param to `plan_trip` + `_run_reverse_raptor` latest-departure search (mirror forward RAPTOR)
- [x] 1.2 Wire forward/reverse branch in `plan_trip`; document mutex with `departure_time`
- [x] 1.3 Unit tests: happy path, latest departure expected value, no-route, before-first-trip

## 2. Seed delay incident (backend)

- [x] 2.1 Add delay incident `route_id:"1"` status `delay` with cause/action/instruction to seed
- [x] 2.2 Verify `/api/incidents` returns it; existing `normal` incident unchanged

## 3. Endpoint wire (backend)

- [x] 3.1 `GET /api/journey/plan` accepts `arrive_by` + `include_eta`
- [x] 3.2 Deterministic simulated ETA per BUS leg (delay_minutes, live_eta_minutes, eta_source simulated/realtime)
- [x] 3.3 Incident filter {delay,diverted} + match leg route.id/short_name; top-level `incidents` in response
- [x] 3.4 API tests: arrive_by, eta determinism, incident filter, normal excluded; curl e2e

## 4. Saved places + history (frontend)

- [x] 4.1 localStorage keys + try/catch helpers (saved-stops.v1, search-history.v1)
- [x] 4.2 Saved places UI: save/list/tap-fill/remove/dedupe/cap 10
- [x] 4.3 Search history UI: recent-first/dedupe/cap 10/tap-refill

## 5. Plan results display (frontend)

- [x] 5.1 Incident banner above results (delay/diverted; cause/action/instruction)
- [x] 5.2 Per-BUS-leg delay badge (simulasi label) when delay_minutes > 0
- [x] 5.3 Arrive-by toggle + time input; display latest departure

## 6. Verification

- [x] 6.1 Backend pytest green (new + existing)
- [x] 6.2 Frontend typecheck/build + extend planner-check.mjs contract strings
- [x] 6.3 `openspec validate --all --strict --no-interactive` passes
- [x] 6.4 Demo smoke: arrive_by + include_eta curl returns deterministic delay fields; incident banner + saved places visible in browser (pending manual)

