# Frontend Guide

React 19.2 + Vite 8 + TS ~6.0 PWA. Facts below are frontend-local; product scope, deployment, OpenSpec, and repo-level commands live in the root `AGENTS.md`.

## Env

- `vite.config.ts` sets `envDir: '..'`, so the ROOT `.env` feeds browser vars, not `frontend/.env`. `frontend/.env.example` is a redundant duplicate of the root one.
- Only `VITE_*` reach browser code: `VITE_API_BASE_URL` (default `http://localhost:8000`, trailing `/` stripped in App.tsx), `VITE_MAPBOX_TOKEN`. Never put secrets here; Cloud STT/ElevenLabs credentials stay backend-only.

## Architecture

- Monolithic `src/App.tsx` (~2418 lines). No router, no state library, no eslint/prettier. A single `type Screen` union drives navigation via `useState` and conditional renders.
- `useBackendConnection()` owns the ONE WebSocket to `${apiBaseUrl}/api/ws` in a ref. Capped exponential reconnect (`Math.min(15000, 1000 * 2 ** min(attempts-1, 4))`), runtime type-guard suite (`isRecord`, `isTransitState`, `isTranscriptionResult`, ...) so unknown messages are dropped, and a full `TransitState` clone at mount from `SEEDED_TRANSIT_STATE`.
- `useOptionalStaticData()` fetches `GET /api/schedule`; on failure falls back to seed (`source: 'seed' | 'optional' | 'fallback'`). Local seed simulation (`SEEDED_TRANSIT_STATE`) is the deterministic fallback whenever the socket is closed.
- `src/icons.tsx` holds 7 inline SVG components (`BellIcon`, `MinimizeIcon`, `MaximizeIcon`, `AntarAkuIcon`, `TranscribeIcon`, `DelaysIcon`, `ScheduleIcon`) — line-style `viewBox 0 0 24 24`, `fill="currentColor"` (or stroke for line icons), size prop default 24.

## Screens (`type Screen`)

- `onboarding`: writes `localStorage` key `transense.demo-profile.v1`; initial screen chosen by `readProfile()`.
- `home` (Beranda): 3-zone layout — (A) `home-topbar` greeting + search + `notification-btn` bell with unread badge; (B) `home-hero` collapsible map (minimized 220px / maximized 80vh via `map-toggle-btn`) with bus/rail mode toggle, GTFS routes + rail lines filters, `MapboxMap`, arrivals bottom sheet; (C) `feature-list` 2-col grid of 4 `feature-tile` cards (Antar Aku, Transcribe, Keterlambatan, Jadwal). Bus data: GTFS stops/routes/shapes (`/api/gtfs/*`) + `/api/buses` polled 15 s. Rail data: `/api/transit/lines/geometry` + `/api/transit/stations`; rail stations clickable → `/api/transit/stop/{operator}/{code}/info` popup. `mapMode: 'bus' | 'rail'` gates which props reach MapboxMap.
- `schedule` (Jadwal & armada): renders `useOptionalStaticData` result plus local simulation controls (Simulasikan ETA, Reset ke seed, simulate notification); also has bus/rail `schedule-mode-toggle` — rail mode fetches `/api/transit/lines`, per-line stations via `/api/transit/line/{operator}/{code}/stations`, and stop schedules via `/api/transit/stop/{operator}/{code}/schedule`.
- `delays` (Keterlambatan): incident records + pin (`pinIncident`).
- `transcribe` (ChatTranscribe): ElevenLabs `useScribe` (`scribe_v2_realtime`, `languageCode: 'id'`, VAD commit) via `GET /api/scribe-token`; conversations CRUD at `/api/conversations`; backend WS messages `transcription.session.*`/`transcription.result` with a `MOCK DEMO` degraded path.
- `antar-aku` (TransitTrackingPage): `/api/journey/track` polled every 15 s while tracking; vehicle-id and GPS modes; stop search via `/api/gtfs/stops/search`.
- `profile`: display name, connection status, simulation detail, reset.

## MapboxMap (`src/MapboxMap.tsx`)

- Props: `stops` (required), `routeShapes?`, `buses?`, `walkLegs?`, plus rail: `railLines?`, `railStations?`, `railStationPopup?`, `onRailStationClick?(stationId)`, `onRailStationPopupClose?()`. No `mapMode` prop — mode gating happens in App.tsx (pass empty/`[]` for the inactive mode).
- Bus: route-shape line layers (`shape-*`/`layer-shape-*`), walk dashed lines (`walk-*`), `#1677ff` stop markers, inline-styled bus markers (`.vehicle-marker`, no CSS rule — `el.style.cssText`).
- Rail: `MultiLineString` line layers per `operator:code` (`rail-*`/`layer-rail-*`, width 4, color from line), `.rail-station-marker` buttons (inline SVG train, inline-styled), rail station popup (`stop-popup__*` classes, amenities chips, `onRailStationPopupClose` on close).
- Fit bounds on load (`padding 16, maxZoom 15`); ResizeObserver re-fits (`padding 16, maxZoom 18`) debounced 260 ms so the hero minimize/maximize toggle fills the map. No token → `.map-placeholder` fallback.

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
