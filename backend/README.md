# Transense backend

FastAPI + WebSocket demo backend using a local SQLite persistence boundary for transcripts/incidents. Transit data comes from the official TransJakarta GTFS feed (stops, routes, shapes, schedules) plus the internal realtime bus API when enabled. A deterministic seed remains available as a fallback when external sources are unavailable.

## One-shot setup (recommended for teammates)

From the repository root:

```powershell
python scripts/setup.py
```

This installs backend deps, creates `backend/.env.local` from `.env.example` (if missing), pre-downloads the GTFS feed, and installs frontend deps. Then run:

```powershell
python -m uvicorn backend.main:app --reload   # terminal 1
cd frontend && npm run dev                    # terminal 2
```

## Manual run locally

From the repository root:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
Copy-Item backend\.env.example backend\.env.local   # then edit if needed
python -m uvicorn backend.main:app --reload
```

The API is then available at `http://localhost:8000`. `TRANSENSE_ENVIRONMENT` and `TRANSENSE_ALLOWED_ORIGINS` are required non-secret settings; they are read from `backend/.env.local` (auto-loaded) or the process environment. `TRANSENSE_DATABASE_PATH` is optional and defaults to `backend/transense.sqlite3`.

## Transit data sources

- **GTFS (static)**: downloaded from `TRANSENSE_GTFS_URL` (default the official TransJakarta feed) and cached at `backend/gtfs_cache.zip` for 24h. Serves `GET /api/gtfs/status`, `/api/gtfs/stops`, `/api/gtfs/routes`, and `/api/gtfs/route/{id}/shape`.
- **Realtime buses**: when `TRANSENSE_REALTIME_ENABLED=1`, the backend authenticates a guest session against the TransJakarta internal API (`tijeapi.transjakarta.co.id`) and returns live bus positions with route codes and next-stop estimates via `GET /api/buses`.

Run tests with `python -m pytest backend/tests -q`.

## JSON contracts

- `GET /api/health` returns `{ "status": "healthy|unhealthy", "environment": string, "persistence": { "available": boolean, "detail": string }, "transit": { "source": "seed", "state_version": integer } }`. Missing required configuration or unavailable SQLite returns HTTP 503 and `status: unhealthy`.
- A WebSocket connection to `/api/ws` first receives `{ "type": "connection.ack", "protocol": "transit-demo.v1", "state": <dataset> }`.
- Send `{ "type": "transit.update", "vehicle_id": "vehicle-kp-01" }` to advance the deterministic vehicle/ETA state. The response is `{ "type": "transit.update", "event_id": string, "vehicle_id": string, "eta_minutes": integer, "position": string, "occurred_at": UTC timestamp, "state_version": integer }`.
- Send `{ "type": "transit.reset" }` to restore seed state. The response is `{ "type": "transit.reset", "state": <dataset>, "occurred_at": UTC timestamp, "state_version": integer }`.
- Invalid JSON, unknown message types, or unknown transit references return `{ "type": "error", "code": string, "message": string }` without publishing a partial update.

Additive journey messages on the same `/api/ws` connection:

- Send `journey.subscribe` with `vehicle_id`, `route_id`, `origin_stop_id`, and `destination_stop_id` to activate deterministic threshold notifications. `journey.start` is accepted as an equivalent alias.
- A subscribed vehicle emits `notification.vehicle_approaching` at ETA 2 minutes or less and `notification.destination_approaching` at ETA 1 minute or less. Their shared vibration contracts are `[200,100,200]` and `[300,100,300,100,300]`.
- Send `incident.update` with `route_id` and optional `stage` (`0`, `1`, or `2`) for progressive simulated incident events. Each event contains `status`, `cause`, `action`, `instruction`, `updated_at`, `created_at`, a stable `event_id`, and incident pattern `[500,200,500,200,1000]`. Incidents are persisted as `record_type: "incident"` through the shared seven-day cleanup and pinned lifecycle.
- Send `journey.off_route` with `action: "trigger"` or `"resolve"` for the controlled simulated warning. It requires an active subscription and never uses geolocation.
- `GET /api/schedule` returns static stops, routes, and timetables. `TRANSENSE_COMMUTE_API_URL` optionally enables the short-timeout Commute Data Platform adapter; invalid/unreachable/unconfigured sources fall back to seed data. The source is never used for live vehicles, ETA, or incidents. External data responses include `Commute Data Platform, ODbL-1.0` attribution.

The WebSocket `Origin` header must exactly match one of `TRANSENSE_ALLOWED_ORIGINS`; disallowed origins are closed with policy code 1008 before `accept`. REST CORS uses the same allowlist.

Transcription is additive on `/api/ws` and is limited to person-to-person microphone input. Send `{"type":"transcription.session.start","session_id":"session-1","source":"conversation_microphone"}` and then `{"type":"transcription.session.stop","session_id":"session-1"}`. Responses are `transcription.session.started`, `transcription.result`, or `transcription.session.error`; results contain functional text, UTC `created_at`, session ID, provider, and `mode` (`mock` or `live`). `TRANSENSE_STT_PROVIDER=mock` is the deterministic fallback. Cloud mode reads only `TRANSENSE_CLOUD_STT_ENDPOINT` and `TRANSENSE_CLOUD_STT_API_KEY` in the backend environment and never sends credentials to the browser. `GET /api/transcripts` returns newest-first seven-day history, and `PATCH /api/transcripts/{id}/pin` accepts `{"pinned":true|false}`. Raw audio, ambient noise, PA announcements, diarization, speaker IDs, and audio history are not persisted.
