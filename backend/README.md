# Transense backend

FastAPI + WebSocket demo backend using only a local SQLite persistence boundary. Transit data is deterministic seed/simulation data; no TransJakarta or other external API is called at runtime.

## Run locally

From the repository root:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
$env:TRANSENSE_ENVIRONMENT = "local"
$env:TRANSENSE_ALLOWED_ORIGINS = "http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174"
python -m uvicorn backend.main:app --reload
```

The API is then available at `http://localhost:8000`. `TRANSENSE_ENVIRONMENT` and `TRANSENSE_ALLOWED_ORIGINS` are required non-secret settings. `TRANSENSE_DATABASE_PATH` is optional and defaults to `backend/transense.sqlite3`.

Run tests with `python -m pytest backend/tests -q`.

For local frontend integration, run the frontend separately with `VITE_API_BASE_URL=http://localhost:8000 npm run dev` from `frontend/`, then open its Vite URL. A successful browser connection receives the `connection.ack` seed, shows the nearest-route status card in Beranda, and enables the explicitly labeled simulation controls. Use `Simulasikan ETA -1 menit` to send the documented update for `vehicle-kp-01`, or `Reset ke seed` to return to the four-minute seed state. These controls are deterministic demo actions, not real-time transit data.

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
