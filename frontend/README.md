# Transense frontend

React + Vite TypeScript PWA shell for the Transense Android demo. The shell is deliberately audio-blind: onboarding validation, navigation state, backend connection state, status, and feature availability are all represented visually.

## Run locally

Start the backend from the repository root in one terminal:

```bash
python -m pip install -r backend/requirements.txt
TRANSENSE_ENVIRONMENT=local TRANSENSE_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174 python -m uvicorn backend.main:app --reload
```

Then start the frontend in a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open the local URL printed by Vite. The frontend defaults to `http://localhost:8000` for the backend WebSocket at `/api/ws` and sends the Vite origin in the browser WebSocket handshake.

When the connection is acknowledged, Beranda renders the backend's seeded `route-1`, `vehicle-kp-01`, stop, and ETA context. The visible controls are explicitly local simulation controls: `Simulasikan ETA -1 menit` sends the documented update message and `Reset ke seed` restores the seeded four-minute ETA. They never represent real-time TransJakARTA data. If the backend is unavailable, `BACKEND OFFLINE` remains visible, the shell stays navigable, and the connection retries with a capped exponential delay.

## Environment

All configuration lives in a single `.env` file at the repository root (see `.env.example`). The Vite dev server reads it via `envDir` in `vite.config.ts`. `VITE_API_BASE_URL` and `VITE_MAPBOX_TOKEN` are the frontend-specific variables:

```bash
VITE_API_BASE_URL=http://localhost:8000
VITE_MAPBOX_TOKEN=pk.your_mapbox_public_token_here
```

Only `VITE_` variables are exposed to browser code. Do not put secrets in this file.

## Verify and build

```bash
npm run typecheck
npm run build
npm run preview
```

For the focused backend WebSocket contract test, run from the repository root:

```bash
python -m pytest backend/tests -q
```

The local integration path is: backend health at `http://localhost:8000/api/health`, frontend at the Vite URL, then Beranda simulation update and reset. Journey notifications, incident history, and vibration patterns are deterministic demo behavior; live vehicle positions and official incidents are not claimed.

The production build includes `manifest.webmanifest`, the SVG app mark, and a baseline service worker. Transcribe is a functional conversation-only screen: it sends additive `transcription.session.start` / `transcription.session.stop` messages over `/api/ws`, accepts `transcription.result` and `transcription.session.error`, and reads history from `GET /api/transcripts` with `PATCH /api/transcripts/{id}/pin`. If the backend/provider is unavailable, the screen visibly switches to `DEGRADED` and generates a deterministic `MOCK DEMO` result; it never claims that mock text is live Cloud STT and never stores raw audio. Cloud STT credentials remain backend-only; vehicle/incident notifications remain deterministic demo behavior and Android vibration still requires device validation.
