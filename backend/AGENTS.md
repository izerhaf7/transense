# Backend AGENTS.md (FastAPI backend only)

Backend-specific facts only. Product scope, deployment, and OpenSpec workflow live in the root `AGENTS.md`.

## Architecture

- Single-file app factory: `create_app(Settings | None)` in `main.py`; module-level `app = create_app()` at import time. Tests build their own app via `create_app(...)`.
- All REST routes and the `/api/ws` handler are inline closures inside `create_app()`. No routers, no APIRouter, no Pydantic response models: every route declares `response_model=None` and returns plain `dict` bodies.
- State hangs off `app.state`: `settings`, `transit`, `notifications`, `schedule`, `store`, `gtfs_feed`, `realtime_client`, `realtime_buses`, plus `gtfs_error`/`realtime_error`/`persistence_error`.
- `lifespan` loads GTFS (falls back to seed on any error), authenticates the TJ client if realtime is enabled, opens `DemoStore`, runs one seed incident insert if empty, then cleans up on shutdown.

## Env / Settings

- Hand-rolled `Settings.from_env()` in `config.py`. No pydantic-settings, no dotenv package: it parses `.env`/`.env.local` from cwd and repo root/parents itself (existing env wins over file values).
- Required (fails `/api/health` as 503): `TRANSENSE_ENVIRONMENT`, `TRANSENSE_ALLOWED_ORIGINS` (comma-separated).
- Optional: `TRANSENSE_DATABASE_PATH` (default `backend/transense.sqlite3`), `TRANSENSE_REALTIME_ENABLED`, `TRANSENSE_COMMUTE_API_URL`, `TRANSENSE_STT_PROVIDER` (default `mock`), `TRANSENSE_CLOUD_STT_ENDPOINT`/`TRANSENSE_CLOUD_STT_API_KEY`, `ELEVENLABS_API_KEY`, `TRANSENSE_GTFS_URL`, `TRANSENSE_GTFS_CACHE_PATH`, `TRANSENSE_REALTIME_API_BASE`/`_POLL_INTERVAL`/`_RADIUS_KM`/`_CENTER_LAT`/`_CENTER_LNG`.
- Settings is a frozen dataclass; pass a constructed `Settings(...)` into `create_app` to bypass env entirely (how tests isolate).

## Module responsibilities

| Module | Owns |
|---|---|
| `main.py` | app factory, all routes, WS handler, haversine/nearest-stop helpers |
| `config.py` | `Settings` dataclass + env file loading, `missing_required()` |
| `transit.py` | deterministic `TransitSimulator` seed/update/reset, `state_version`, dataset/update validation |
| `notifications.py` | `NotificationEngine`: journey subscribe, threshold notifications, incident stages, off-route; `VIBRATION_PATTERNS` |
| `persistence.py` | `DemoStore` SQLite (see Persistence), timestamp validation |
| `conversation.py` | conversation CRUD over `DemoStore`, message validation (`sender` user/other, `source` typed/stt) |
| `transcription.py` | provider protocol, `MockTranscriptionProvider`, cloud STT config from env, persist/history helpers |
| `gtfs_loader.py` | GTFS zip download+cache, `parse_gtfs` -> `GtfsFeed`, route/stop index maps, `stop_type_label` |
| `tj_api.py` | `TjRealtimeClient` (guest login, token refresh on 401, `get_buses`) -> `RealtimeBus` |
| `sources.py` | `load_static_schedule`: seed fallback or `CommuteDataPlatformAdapter` static schedule |

`transit` + `notifications` form the deterministic demo core; `gtfs_loader` + `tj_api` + `sources` are opt-in real data (see root AGENTS.md for boundary rules).

## WebSocket `/api/ws`

- Origin header must exactly match one of `TRANSENSE_ALLOWED_ORIGINS` or connection closes with 1008 **before** `accept()`.
- First frame is always `{"type":"connection.ack","protocol":"transit-demo.v1","state":<seed snapshot>}`.
- Inbound (additive, sent as `{"type": ...}`): `transit.update` (vehicle_id), `transit.reset`, `journey.subscribe`/`journey.start`, `incident.update` (route_id, stage 0-2), `journey.off_route` (trigger/resolve), `transcription.session.start` (must be `source:"conversation_microphone"`), `transcription.session.stop`, `transcription.save`.
- Outbound: ack, transit events, `journey.subscribed`, `notification.vehicle_approaching`/`destination_approaching`/`incident`, `journey.off_route`, `transcription.session.started`, `transcription.result`, `transcription.session.error`.
- Error envelope: `{"type":"error","code":...,"message":...}`. Transit/typo/attribute errors map to `invalid_transit_reference`; `TranscriptionError` maps to `transcription.session.error` with `code:"invalid_request"`. No partial state is published on error.
- Incidents received on WS are persisted to the store with `event_id` as record id. `transcription.session.stop` with any `audio`/`audio_history` is rejected (persistence boundary).

## REST endpoints

- `/api/health` (503 + `unhealthy` when config missing or SQLite down), `/api/schedule`, `/api/incidents` + `PATCH /api/incidents/{id}/pin`, `/api/transcripts` + `PATCH /api/transcripts/{id}/pin`, `/api/scribe-token` (503/502 if ElevenLabs missing/failing), `/api/conversations` CRUD (POST/PATCH/DELETE).
- `/api/gtfs/status`, `/api/gtfs/stops`, `/api/gtfs/stops/search`, `/api/gtfs/routes`, `/api/gtfs/route/{route_id}/shape` (503 when feed not loaded).
- `/api/buses`, `/api/arrivals`, `/api/journey/track`: return `source:"unavailable"` (never HTTP errors) when the TJ client or GTFS is missing. `/api/journey/track` statuses: `unavailable`/`not_found`/`not_on_route`/`arrived`/`approaching`/`en_route`.
- Pin endpoints and conversation payloads are validated; invalid bodies raise 422, missing records 404.

## Tests

- Plain pytest. No `conftest.py`, no `pytest.ini`, no fixtures beyond stdlib `tmp_path` + `monkeypatch`. Run from repo root: `python -m pytest backend/tests -q`.
- Pattern: `create_app(Settings("test", origins, tmp_path / "demo.sqlite3"))` for API/WS tests; module tests construct `TransitSimulator`/`DemoStore`/`NotificationEngine` directly.
- Determinism is asserted: seed ETAs, `event-0001` id, exact vibration patterns, `source == "seed"`, stable transcript text. Never mock transport for these.

## Persistence

- Single table `demo_records (id, record_type, payload JSON, created_at, pinned)`. `record_type` values: `incident`, `transcript`, `conversation`.
- `created_at` stored as UTC ISO-8601 with `Z`; naive datetimes raise `TimestampValidationError` (`parse_timestamp`/`timestamp` in persistence.py).
- `cleanup(now)` deletes records older than 7 days where `pinned = 0`; boundary is exact (test asserts day-7 survives). `transcript_history` and incident list both call cleanup before listing.
- `/api/incidents` and `/api/transcripts` return `{"records": [], "retention_days": 7}` (with store) or empty records when store is None.

## Secrets & runtime artifacts

- Never commit: cloud STT keys, ElevenLabs key, tokens, any `.env*`. `ELEVENLABS_API_KEY` is only ever read server-side for `scribe-token`.
- `backend/Dockerfile` is committed; build context must be `backend/` (paths are relative to it).
- `backend/transense.sqlite3` and `backend/gtfs_cache.zip` are gitignored runtime artifacts: DB is ephemeral on Cloud Run, GTFS zip is a 24h cache with `.download` temp fallback.
