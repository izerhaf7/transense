# Repository Guide

## Current State

- This is a spec-driven workspace. `frontend/` now contains the React + Vite PWA shell and `backend/` contains the FastAPI + WebSocket + SQLite demo foundation. No CI or provider-managed deployment configuration is committed yet; deployment values and the local replay path are documented in `DEPLOYMENT.md`.
- `.opencode/package.json` installs OpenCode tooling only. Never treat it or `.opencode/node_modules/` as Transense app dependencies.
- `.agent/`, `.agents/`, `.claude/`, `.opencode/`, and `.omo/` are agent/tooling surfaces, not product packages. OpenSpec may regenerate duplicated command/skill files there; durable project rules belong here or in `openspec/config.yaml`.

## Sources of Truth

- Read `docs/brief.md` for final product decisions, then `openspec/config.yaml` for repository-wide OpenSpec constraints.
- For implementation, active change artifacts override older broad prose where they are more specific. Read paths returned by OpenSpec rather than assuming artifact names.
- Distinguish planned architecture from implemented code. Current boundaries are `frontend/` (implemented React + Vite PWA shell) and `backend/` (implemented FastAPI + WebSocket + SQLite demo foundation).
- In `docs/brief.md`, specific `[FINAL]` decisions override unresolved or older statements. Transcription means person-to-person speech through phone microphone, not PA announcement transcription.

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
- Demo data may be deterministic dummy/seed/simulation. Keep transit sources replaceable; never imply mock routing, geolocation, incidents, off-route events, or transcripts are production-real.
- Demo target is a real Android device. iOS/Safari is invalid for haptic verification because `navigator.vibrate()` is unsupported there.
- Preserve audio-blind output: large readable text, high contrast, visible status/action states, edge flash, and distinct vibration patterns for notification categories.
- Transcript and incident history retain seven days. Central cleanup removes older non-exempt records; explicitly saved/pinned records survive. Use stable IDs and valid timestamps.
- Keep Cloud STT keys and deployment secrets in environment variables; never commit values.

## Planned Runtime Boundaries

- Frontend deployment: Vercel PWA. Backend deployment: Google Cloud Run FastAPI/WebSocket. Handle REST CORS and WebSocket origin checks because origins differ.
- Foundation endpoints are planned as `GET /api/health` and `/api/ws`. Health must expose persistence availability and visibly fail for missing required non-secret runtime config.
- Beranda uses deterministic seeded nearest-route context, not real geolocation. Interactive maps and real route geometry belong to later journey work.
- Cloud Run may scale idle instances to zero and its local SQLite disk may be ephemeral. Keep deterministic reseeding/local replay available for demo recovery.

## Verification

- Backend commands now defined by `backend/README.md`: install with `python -m pip install -r backend/requirements.txt`, run with `python -m uvicorn backend.main:app --reload`, and run focused tests with `python -m pytest backend/tests -q`. Frontend commands are in `frontend/README.md`: `npm run typecheck`, `npm run build`, and `npm run dev`. Provider deployment is documented in `DEPLOYMENT.md`; no CI or migration command exists yet.
- Foundation completion requires unit coverage for seven-day cleanup boundaries, pinned exemptions, timestamp validation, transit-reference rejection, notification parsing, and critical vibration patterns.
- Before completion, verify REST, WebSocket, CORS/origin handling, deterministic seed reset, and onboarding -> Beranda -> Keterlambatan -> Profil on a real Android device.
