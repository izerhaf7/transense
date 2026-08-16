## 1. Governance & Fondasi Profil

- [ ] 1.1 Commit `docs/brief-v2.md` (override FINAL Netra-deleted) + OpenSpec change multi-profil-netra-daksa (proposal/spec/tasks)
- [ ] 1.2 Profile model v2: `DemoProfile {displayName, profile: 'tuli'|'netra'|'daksa', createdAt}` + key `transense.demo-profile.v2` + migrasi v1→v2 silent (default tuli) + test
- [ ] 1.3 Onboarding 3-profil UI (kartu Tuli/Netra/Daksa, touch ≥48dp) + persist v2 + Playwright

## 2. Rendering Layer & TTS

- [ ] 2.1 Backend `POST /api/tts` (scribe-token pattern, `ELEVENLABS_API_KEY` + `ELEVENLABS_TTS_VOICE_ID`, 503 missing key, audio/mpeg) + test
- [ ] 2.2 Frontend `tts.ts` `TtsProvider` (play MP3, cache per-text, degrade ke visible text) 
- [ ] 2.3 Per-profile `NotificationRenderer` (tuli visual / netra TTS+vibrasi+text twin / daksa visual besar) + unit test

## 3. Facility & Daksa

- [ ] 3.1 `backend/facilities.py` seed 3–5 halte ikonik + `GET /api/facilities/stops` + test (tanpa penanda simulated — override user)
- [ ] 3.2 `GET /api/facilities/stops/{id}/occupancy` (deterministik time-based) + ramp.request channel + test

## 4. Netra Camera & CV/OCR

- [ ] 4.1 `CameraScan.tsx` + `mediapipe.worker.ts` (`@mediapipe/tasks-vision@1.0.1`, categoryAllowlist bus, simulated-detection button, permission-denied fallback) + check guards
- [ ] 4.2 Approach heuristic (box growth) → TTS + vibrasi
- [ ] 4.3 Backend `POST /api/vision/ocr` proxy (Google Cloud Vision, 503 missing key, source unavailable degrade) + test

## 5. Side by Side

- [ ] 5.1 `SideBySidePage.tsx` visual renderer (daksa, 360° placeholder + facility labels)
- [ ] 5.2 `SideBySidePage.tsx` verbal renderer (netra, TTS + text twin)
- [ ] 5.3 Register `'side-by-side'` screen di union + render block + kartu navigasi

## 6. Verification

- [ ] 6.1 Backend pytest green (TTS/OCR/facility/ramp + existing)
- [ ] 6.2 Frontend `npm run check` + 4 guard scripts green
- [ ] 6.3 `openspec validate --all --strict --no-interactive` passes
- [ ] 6.4 Android device QA (onboarding 3-profil, Netra camera+simulated+TTS, Daksa ramp, Side by Side) via HTTPS
