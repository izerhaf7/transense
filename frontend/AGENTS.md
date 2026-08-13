# Frontend Guide

React 19.2 + Vite 8 + TS ~6.0 PWA. Facts below are frontend-local; product scope, deployment, OpenSpec, and repo-level commands live in the root `AGENTS.md`.

## Env

- `vite.config.ts` sets `envDir: '..'`, so the ROOT `.env` feeds browser vars, not `frontend/.env`. `frontend/.env.example` is a redundant duplicate of the root one.
- Only `VITE_*` reach browser code: `VITE_API_BASE_URL` (default `http://localhost:8000`, trailing `/` stripped in App.tsx), `VITE_MAPBOX_TOKEN`. Never put secrets here; Cloud STT/ElevenLabs credentials stay backend-only.

## Architecture

- Monolithic `src/App.tsx` (~1840 lines). No router, no state library, no eslint/prettier. A single `type Screen` union drives navigation via `useState` and conditional renders.
- `useBackendConnection()` owns the ONE WebSocket to `${apiBaseUrl}/api/ws` in a ref. Capped exponential reconnect (`Math.min(15000, 1000 * 2 ** min(attempts-1, 4))`), runtime type-guard suite (`isRecord`, `isTransitState`, `isTranscriptionResult`, ...) so unknown messages are dropped, and a full `TransitState` clone at mount from `SEEDED_TRANSIT_STATE`.
- `useOptionalStaticData()` fetches `GET /api/schedule`; on failure falls back to seed (`source: 'seed' | 'optional' | 'fallback'`). Local seed simulation (`SEEDED_TRANSIT_STATE`) is the deterministic fallback whenever the socket is closed.

## Screens (`type Screen`)

- `onboarding`: writes `localStorage` key `transense.demo-profile.v1`; initial screen chosen by `readProfile()`.
- `home` (Beranda): fetches GTFS stops/routes/route shapes (`/api/gtfs/*`) plus `/api/buses` polled every 15 s (`setInterval(..., 15_000)`); arrivals sheet.
- `schedule` (Jadwal & armada): renders `useOptionalStaticData` result plus local simulation controls (Simulasikan ETA, Reset ke seed, simulate notification).
- `delays` (Keterlambatan): incident records + pin (`pinIncident`).
- `transcribe` (ChatTranscribe): ElevenLabs `useScribe` (`scribe_v2_realtime`, VAD commit) via `GET /api/scribe-token`; conversations CRUD at `/api/conversations`; backend WS messages `transcription.session.*`/`transcription.result` with a `MOCK DEMO` degraded path.
- `antar-aku` (TransitTrackingPage): `/api/journey/track` polled every 15 s while tracking; vehicle-id and GPS modes; stop search via `/api/gtfs/stops/search`.
- `profile`: display name, connection status, simulation detail, reset.

## Vibration contract (`src/journey.ts`)

- `VIBRATION_PATTERNS`: `vehicleApproaching [200,100,200]`, `destinationApproaching [300,100,300,100,300]`, `incident [500,200,500,200,1000]`.
- Guarded: `'vibrate' in navigator && typeof navigator.vibrate === 'function'`. Visual banner + edge flash render first; vibration is a supplement, never the only cue.

## Contract guard scripts

- `npm run check:journey` and `npm run check:transcribe` are node scripts that SCAN source text for exact strings (`[200, 100, 200]`, `transcription.session.start`, `/api/transcripts/${encodeURIComponent(transcriptId)}/pin`, `source: 'degraded'`, ...) and HARD-FAIL if a pattern changes or raw-audio tokens (`MediaRecorder`, `audio-history`, `ambient-noise`) appear. Do not rename/refactor those strings; they are the contract.

## Toolchain

- Strict TS: `verbatimModuleSyntax`, `noUnusedLocals`/`noUnusedParameters`, `moduleResolution: Bundler`, `noEmit`. Type-only imports MUST use `import type`.
- Single gate is `npm run check` = `tsc -b` (project refs: tsconfig.app.json for `src`, tsconfig.node.json for vite.config.ts) + `vite build`.

## PWA

- Hand-rolled `public/sw.js`: precaches shell assets, network-first with cache fallback, old-cache cleanup. `manifest.webmanifest` in `public/`. No `vite-plugin-pwa`; registration is manual in `main.tsx` on `window load`.

## Gotchas

- `frontend/.pytest_cache` is a leftover; tests live in `backend/tests` and never run here.
- Font/icon/assets are referenced from `/fonts`, `/icons`, `/logos` in `public/`; `index.html` preloads the variable font.
