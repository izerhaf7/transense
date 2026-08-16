# Transense demo deployment

The foundation uses two origins so the FastAPI WebSocket is not tied to a
short-lived serverless connection:

- **Frontend:** Vercel, project root `frontend/`, build command `npm run build`,
  output directory `dist`.
- **Backend:** Google Cloud Run, deployed from `backend/` using its Dockerfile.
  Cloud Run provides the long-lived HTTP/WebSocket service required by the
  demo.

## Current demo URLs

- Frontend: `https://frontend-zeta-umber-47.vercel.app`
- Backend: `https://transense-backend-j7qpz3oeuq-as.a.run.app`

These URLs are demo deployment outputs and may change on a future redeploy.

## Environment configuration

### Frontend (Vercel)

```text
VITE_API_BASE_URL=https://transense-backend-j7qpz3oeuq-as.a.run.app
```

The frontend derives `wss://` from an `https://` backend URL and connects to
`/api/ws`.

### Backend (Google Cloud Run)

```text
TRANSENSE_ENVIRONMENT=demo
TRANSENSE_ALLOWED_ORIGINS=https://frontend-zeta-umber-47.vercel.app
TRANSENSE_DATABASE_PATH=/tmp/transense.sqlite3
```

`TRANSENSE_ALLOWED_ORIGINS` is a comma-separated exact-origin allowlist used by
both REST CORS and the WebSocket handshake. Do not use `*` for the demo.

#### Optional feature keys (multi-profil change, 2026-08-16)

```text
ELEVENLABS_API_KEY=sk-...              # used by /api/scribe-token (STT) and /api/tts
ELEVENLABS_TTS_VOICE_ID=...            # enables /api/tts (Netra audio announcements)
GOOGLE_VISION_API_KEY=...              # enables /api/vision/ocr (Netra corridor OCR)
TRANSENSE_REALTIME_ENABLED=1           # enables TJ realtime client for /api/buses, /api/arrivals
```

Behavior when a key is missing (all degrade, never 500):
- `/api/tts` → `503 ElevenLabs TTS not configured`; the frontend falls back to
  visible text.
- `/api/vision/ocr` → `503 Google Cloud Vision not configured`; the Netra scan
  continues in camera-only/simulated mode.
- Realtime endpoints (`/api/buses`, `/api/arrivals`, `/api/journey/track`) →
  `source: "unavailable"`.

Cloud STT/ElevenLabs/Google Vision credentials are backend-only environment
variables, never committed config and never exposed to the browser. Vercel only
needs `VITE_API_BASE_URL` (see above).

## Deployment verification

Before calling deployment complete, verify from the deployed frontend:

1. `GET <backend>/api/health` returns `200` and `status: healthy`.
2. The browser connects to `<backend>/api/ws` and receives `connection.ack`.
3. REST CORS accepts the Vercel origin and a disallowed WebSocket origin is
   rejected before acceptance.
4. Seed update and reset still produce `transit.update` and `transit.reset`.

Cloud Run instances may restart and local SQLite storage is ephemeral. Keep the
local replay path below available for recording and recovery.

## Local replay fallback

From the repository root, run:

```powershell
python scripts/local_replay.py
```

The script uses the same `/api/health` and `/api/ws` contracts as deployment
and enables deterministic seed/update/reset without a cloud service.
