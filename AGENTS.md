# Repository Guide

## Current State

- Spec-driven monorepo. `backend/` is FastAPI + WebSocket + SQLite; `frontend/` is React 19 + Vite 8 + TS 6 PWA. Deployment values and local replay are in `DEPLOYMENT.md`; the backend Dockerfile is committed under `backend/Dockerfile`.
- Remote `origin/main` is the source of truth. If the local branch diverges (e.g. `git status` shows ahead/behind), reconcile with `origin/main` before pushing; local-only files may include `README.md`, `.env.example`, `frontend/.gitignore`, and per-change `.openspec.yaml` metadata.
- `.opencode/package.json` and `.opencode/node_modules/` install OpenCode tooling only — never treat them as Transense app dependencies.
- `.agent/`, `.agents/`, `.claude/`, `.opencode/`, `.omo/`, `.sisyphus/` are agent/tooling surfaces, gitignored, not product packages. Durable rules belong here or in `openspec/config.yaml`.

## Sources of Truth

- Read `docs/brief.md` for final product decisions (`[FINAL]` markers), then `openspec/config.yaml` for repository-wide OpenSpec constraints.
- Active OpenSpec specs live in `openspec/specs/`; completed work is archived under `openspec/changes/archive/`. For implementation, read paths returned by OpenSpec rather than assuming artifact names.
- In `docs/brief.md`, `[FINAL]` decisions override unresolved or older statements. Transcription means person-to-person speech through phone microphone, not PA announcement transcription.

## OpenSpec Workflow

- List active work with `openspec list --json`.
- Before applying a change, run:
  ```bash
  openspec status --change "<change-name>" --json
  openspec instructions apply --change "<change-name>" --json
  ```
  Read every returned `contextFiles` path. Do not implement while apply state is blocked.
- Use `/opsx-propose` for planning only and `/opsx-apply` for implementation. Keep proposal, specs, design, tasks, and code coherent; check off each task immediately after verified completion.
- `openspec/config.yaml` requires proposal `Non-goals` with at least three explicit items and implementation tasks sized to at most two hours.
- Validate one change with `openspec validate "<change-name>" --strict`. Validate all current artifacts non-interactively with `openspec validate --all --strict --no-interactive`.

## Product and Demo Constraints

- Scope is Tuli users on TransJakarta, phone-only. Do not reintroduce blind-profile CV/OCR, mobility/wheelchair profiles, Buddy Up!, wearable/IoT bands, or indoor walking navigation without a new explicit scope decision.
- Real data is opt-in and replaceable: GTFS feed (`gtfs_loader`), TJ realtime client (`tj_api`, `TRANSENSE_REALTIME_ENABLED`), and Commute Data Platform adapter (`sources`, `TRANSENSE_COMMUTE_API_URL`). Keep seed/simulation as the deterministic fallback; never imply mock routing, geolocation, incidents, off-route events, or transcripts are production-real.
- Demo target is a real Android device. iOS/Safari is invalid for haptic verification because `navigator.vibrate()` is unsupported there.
- Preserve audio-blind output: large readable text, high contrast, visible status/action states, edge flash, and distinct vibration patterns for notification categories.
- Transcript and incident history retain seven days. Central cleanup removes older non-exempt records; explicitly saved/pinned records survive. Use stable IDs and valid timestamps.
- Keep Cloud STT keys, ElevenLabs keys, Mapbox tokens, and deployment secrets in environment variables; never commit values.

## Runtime Boundaries

- Frontend deployment: Vercel PWA. Backend deployment: Google Cloud Run FastAPI/WebSocket. Handle REST CORS and WebSocket origin checks because origins differ.
- REST/WS live at `/api/*` and `/api/ws`. `GET /api/health` exposes persistence availability and visibly fails for missing required non-secret runtime config (`TRANSENSE_ENVIRONMENT`, `TRANSENSE_ALLOWED_ORIGINS`).
- Realtime endpoints (`/api/buses`, `/api/arrivals`, `/api/journey/track`) return `source: "unavailable"` instead of errors when the TJ client or GTFS feed is missing; the frontend degrades gracefully.
- Cloud Run may scale idle instances to zero and its local SQLite disk may be ephemeral. Keep deterministic reseeding/local replay available for demo recovery.

## Verification

- Backend: install with `python -m pip install -r backend/requirements.txt`, run with `python -m uvicorn backend.main:app --reload`, tests with `python -m pytest backend/tests -q`.
- Frontend: `cd frontend && npm install && npm run check` (typecheck + build), plus contract guards `npm run check:journey` and `npm run check:transcribe`. Vite reads the root `.env` (`envDir: '..'`); only `VITE_*` vars reach browser code.
- Local replay: `python scripts/local_replay.py` (backend :8000 + frontend :5173, dedicated replay SQLite).
- OpenSpec validation: `openspec validate --all --strict --no-interactive`.
- Android device QA checklist: `docs/android-qa.md`. Before completion, verify REST, WebSocket, CORS/origin handling, deterministic seed reset, and onboarding -> Beranda -> Keterlambatan -> Profil on a real Android device.
