# Transense — Implemented Brief

> Status implementasi aktual terhadap `docs/brief.md`, disusun dari inspeksi seluruh repo (backend, frontend, deployment, OpenSpec, git history) — bukan dari rencana.
> **Penanda**: ✅ = selesai & berfungsi; 🔶 = selesai sebagian / dengan catatan; ⬜ = belum dikerjakan.
> Tanggal inspeksi: 2026-08-17 (commit `57d24ff` — setelah postgres-docker migration, rewrite-frontend, rewrite-backend, api-contract).

---

## Ringkasan eksekutif

Transense adalah PWA React 19 + Vite 8 (Vercel) dengan backend FastAPI + WebSocket + SQLite/PostgreSQL (Google Cloud Run). **Semua fitur utama di brief (1–4) sudah diimplementasikan dan berfungsi**, dengan data deterministik seed/simulasi sebagai fallback dan adapter data-riil opt-in (GTFS TransJakarta, TJ realtime, Commute Data Platform kereta). Di luar scope brief, **banyak fitur besar masuk production**:

1. **Perencana perjalanan ala Moovit** (RAPTOR + arrive-by + keterlambatan/insiden + halte favorit/riwayat).
2. **Transit multimodal kereta** (KCI/MRT/LRT) — perluasan eksplisit dari penanda `[FINAL] TransJakarta-only`.
3. **Multi-profil disabilitas** (Tuli/Netra/Daksa) — profil v2, onboarding 3-profil, rendering per-profil, TTS, OCR koridor, CV kamera, facility + occupancy + ramp-request, Side by Side.
4. **Fitur lokasi saya** — endpoint halte terdekat dari koordinat + tombol lokasi di peta + asal default "Pakai lokasi saya" di Antar Aku.
5. **Refactor arsitektur** — frontend dipecah dari App.tsx monolitik (~2600 baris → 113 baris shell) menjadi `types/api/connection/components/screens`; backend dipecah menjadi `api/routers/deps/utils`.
6. **API contract resmi** (`docs/api-contract.md`) — dokumentasi lengkap endpoint HTTP + WebSocket.
7. **Postgres/Docker stack** — docker-compose dengan PostGIS + Redis + OTP + Photon (migration support, SQLite tetap default).

URL production: Frontend `https://frontend-zeta-umber-47.vercel.app` · Backend `https://transense-backend-j7qpz3oeuq-as.a.run.app`. Versi khusus Gemastik (tanpa rail + tanpa multi-profil): `https://transense-gemastik.vercel.app` + `transense-backend-gemastik-274699602190.asia-southeast1.run.app`.

---

## Bagian A — Fitur brief yang SUDAH diimplementasikan

### A1. Jadwal & tracking posisi armada TransJakarta (Fitur Utama #1) — ✅

- **Jadwal**: layar Jadwal (bus + kereta toggle) menampilkan trayek + jadwal per halte. Data statis dari GTFS TransJakarta asli (`backend/gtfs_loader.py`; `parse_gtfs` memuat stops/routes/trips/stop_times/shapes/transfers/calendar/calendar_dates) atau seed deterministik sebagai fallback (`backend/transit.py`; `backend/sources.py`). Jadwal per halte: `GET /api/gtfs/stop/{id}/schedule` (`backend/api/routers/gtfs.py`).
- **Tracking posisi armada real-time**: `GET /api/buses` (`backend/api/routers/realtime.py`) memakai `TjRealtimeClient` (`backend/tj_api.py`, guest login + refresh JWT) — **opt-in** via `TRANSENSE_REALTIME_ENABLED`; saat nonaktif/gagal → `source: "unavailable"` (HTTP 200, bukan error). Frontend poll `/api/buses` tiap 15 detik dan menggambar marker bus realtime di peta.
- **WebSocket real-time**: `WS /api/ws` (`backend/api/routers/ws.py`) — `connection.ack` (protocol `transit-demo.v1`), `transit.update`, `transit.reset`, notifikasi perjalanan, insiden, off-route, transkripsi.
- **Detail halte**: popup info halte + ETA live (`/api/gtfs/stop/{id}/info`), papan kedatangan per halte (`/api/gtfs/stop/{id}/schedule`).
- **Antar Aku tracking**: `GET /api/journey/track` (`backend/api/routers/journey.py`) — statuses `unavailable`/`not_found`/`not_on_route`/`arrived`/`approaching`/`en_route`.

### A2. Transcribe — transkripsi percakapan orang (Fitur Utama #2) — ✅

- Layar Transcribe dua-arah (chat) dengan mode **mic + keyboard** (`frontend/src/ChatTranscribe.tsx`).
- STT real-time via **ElevenLabs Scribe** (`useScribe`: `scribe_v2_realtime`, `languageCode: 'id'`, VAD commit) — token dibuat server-side di `GET /api/scribe-token` (`backend/api/routers/ai.py`) dari `ELEVENLABS_API_KEY`.
- **Scope sesuai brief**: hanya transkripsi orang bicara (mikrofon), **bukan** pengumuman PA — enforced di WS boundary (tolak `audio`/`audio_history`).
- **Histori 7 hari + pin**: transkrip disimpan (`record_type: "transcript"`, `persist_transcript` transcription.py); `GET /api/transcripts` + `PATCH /api/transcripts/{id}/pin` (`backend/api/routers/transcripts.py`); cleanup 7 hari dengan pengecualian pinned (persistence.py).
- **Fallback jujur**: `TRANSENSE_STT_PROVIDER=mock` (default) → `MockTranscriptionProvider` deterministik; degradasi visual `source: 'degraded'` / `source: 'mock'` (dijaga transcribe-check.mjs).

### A3. Notifikasi real-time dua jenis + pola getar (Fitur Utama #3) — ✅

- **3a. Notifikasi posisi/status perjalanan** — `NotificationEngine` (backend/notifications.py): ambang armada mendekat 2 menit, halte tujuan mendekat 1 menit; event `notification.vehicle_approaching` / `notification.destination_approaching`.
- **3b. Notifikasi keterlambatan/insiden resmi** — format terstruktur ala KAI Commuter: `status/cause/action/instruction` (INCIDENT_STAGES, notifications.py); event `notification.incident`; feed tersimpan 7 hari (`record_type: "incident"`, pin via `PATCH /api/incidents/{id}/pin`, `backend/api/routers/incidents.py`); seed delay incident demo ada.
- **3 pola getar khas (contract)**: `vehicleApproaching [200,100,200]`, `destinationApproaching [300,100,300,100,300]`, `incident [500,200,500,200,1000]` (journey.ts) — distinctness diuji (test_notifications.py + guard journey-check.mjs).
- **Penyampaian audio-blind**: visual teks besar + kilat tepi layar (`edge-flash`) + getar Android via `navigator.vibrate` (guarded, NotificationRenderer `frontend/src/components/NotificationRenderer.tsx`); Android-only per constraint Vibration API.
- **Bukan deteksi visual**: sumber notifikasi = data tracking (fitur 1), bukan computer vision.

### A4. Antar Aku — lapisan integrasi perjalanan (Fitur Utama #4) — ✅ (dengan perluasan besar)

- **Routing halte-ke-halte**: pengguna input asal & tujuan → sistem cocokkan ke halte TJ → gambar rute di peta.
- **Sepanjang perjalanan**: notifikasi armada mendekat (3a), insiden (3b), peringatan keluar-rute.
- **Deteksi keluar-rute**: mock/terkontrol untuk demo — `journey.off_route` (trigger/resolve) via WS; tidak memakai geolokasi.
- **Perluasan besar di luar brief (lihat Bagian B)**: Antar Aku kini menjadi **planner penuh ala Moovit** — RAPTOR A→B, arrive-by, alternatif rute, keterlambatan per leg, insiden di rute, halte favorit, riwayat pencarian, lokasi saya sebagai asal default, simulasi per halte (JIS→Blok M), automated bus-arrival simulation dengan animated warnings.

### A5. Fitur sampingan / non-goals — status

- **Side by Side (peta aksesibilitas 3D)** — ✅ **diimplementasikan** (dahulu nice-to-have per brief, kini live sebagai "Fasilitas halte" dengan dual renderer daksa visual + netra verbal). Lihat Bagian B3.
- **Buddy Up!, wearable/IoT, indoor nav** — ⬜ sesuai non-goals brief; **tidak dibangun** (diverifikasi tidak ada kode).
- **Profil netra + daksa** — ✅ **diimplementasikan** (di luar brief awal — lihat Bagian B2).

---

## Bagian B — Fitur di LUAR brief yang masuk production

Perluasan ini adalah keputusan implementasi yang dilakukan setelah brief ditulis. Yang paling signifikan (multimodal kereta) **memperluas** penanda `[FINAL] Lokasi pilot: TransJakarta` — per AGENTS.md root: "treat `[FINAL]` brief markers as the product decision source unless a newer OpenSpec change overrides".

### B1. Transit multimodal kereta — KCI/MRT/LRT (besar, out-of-brief) — ✅ LIVE

- **Sumber data**: Commute Data Platform adapter `backend/commute.py` (`CommuteClient`/`CommuteFeed`; `RAIL_OPERATORS = KCI/MRTJ/LRTJ`, excludes KAI Bandara; urllib-only). Opt-in namun **default ON** (`TRANSENSE_COMMUTE_ENABLED`); feed dimuat di lifespan.
- **Endpoint `/api/transit/*`** (`backend/api/routers/transit.py`): `lines`, `stations`, `line/{op}/{code}/stations`, `stop/{op}/{code}/info` (amenitas stasiun), `stop/{op}/{code}/schedule`, `lines/geometry`. Degradasi `source: "unavailable"` bila feed/geom hilang.
- **Geometri**: `backend/data/rail_geometry.json` (RITJ-2021) dari `scripts/convert_rail_geometry.py`.
- **UI**: toggle **Bus/Kereta** di peta Beranda + layar Jadwal, marker stasiun kereta, popup info stasiun + amenitas, filter per jalur dengan warna, polyline geometri per jalur.
- Bukti production: 7 jalur (KCI:C Cikarang, KCI:B Bogor, KCI:R Rangkasbitung, MRTJ, LRTJ), 113 stasiun, station info dengan amenitas — diverifikasi langsung.
- **Versi Gemastik**: fitur rail ini **dihapus** di branch `origin/gemastik-version` (commit `59a2c2e` "remove rail features and netra/daksa onboarding") — versi khusus submission Gemastik yang mengembalikan scope TransJakarta-only.

### B2. Multi-profil disabilitas — Tuli/Netra/Daksa (besar, out-of-brief) — ✅ LIVE

- **Model profil v2** (`frontend/src/profile.ts`): `DemoProfile { displayName, profile: 'tuli' | 'netra' | 'daksa', createdAt, outputChannel? }` + migrasi v1→v2 silent + field `outputChannel` (visual/haptic/audio/auto) — guard `profile-storage-check.mjs`.
- **Onboarding 3-profil** (`frontend/src/screens/Onboarding.tsx`): kartu Tuli/Netra/Daksa dengan icon SVG, touch ≥48dp, persist v2.
- **Rendering per-profil**: `NotificationRenderer` (`frontend/src/components/NotificationRenderer.tsx`) — tuli visual+haptic, netra TTS+vibrasi+text twin, daksa visual besar; `notify.ts` (resolveNotificationOutput per profil).
- **TTS**: backend `POST /api/tts` (`backend/api/routers/ai.py`) via ElevenLabs (`ELEVENLABS_API_KEY` + `ELEVENLABS_TTS_VOICE_ID`; 503 degrade); frontend `TtsProvider` (`frontend/src/tts.ts`, play MP3 + cache + degrade ke visible text).
- **Facility seed**: `backend/facilities.py` (5 halte ikonik: Bundaran HI, Monas, Kota Tua, Senayan, Blok M); `GET /api/facilities/stops` (`backend/api/routers/facilities.py`).
- **Daksa occupancy + ramp-request**: `GET /api/facilities/stops/{id}/occupancy` (deterministik time-based); WS `ramp.request` → `ramp.request.ack`; `OccupancyCard.tsx`.
- **Netra kamera + CV + OCR**: `CameraScan.tsx` + `mediapipe.worker.ts` (`@mediapipe/tasks-vision@1.0.1`, categoryAllowlist bus, classic worker + self-host wasm `/wasm`, simulated-detection mode); approach heuristic (`approach.ts`: box-growth → TTS + vibrasi); `POST /api/vision/ocr` proxy Google Cloud Vision (`GOOGLE_VISION_API_KEY` server-side; 503 degrade, text tak pernah difabrikasi); `NetraScan.tsx` screen.
- **Side by Side "Fasilitas halte"**: `SideBySidePage.tsx` dual renderer — daksa visual (chips fasilitas) + netra verbal (TTS announcement + text twin); screen 'side-by-side' untuk netra/daksa; kartu fitur tile.
- **Pemindai Netra screen**: 'netra-scan' screen untuk profil netra (tile feature card).
- **Versi Gemastik**: fitur multi-profil ini **dihapus** di branch `origin/gemastik-version` (onboarding netra/daksa dihapus, tersisa Tuli saja).
- **OpenSpec**: change `multi-profil-netra-daksa` — archived `2026-08-16` + main spec synced (`openspec/specs/multi-profil-netra-daksa`).

### B3. Side by Side (peta aksesibilitas) — ✅ LIVE

Dahulu nice-to-have per brief (Bagian A5), kini **diimplementasikan** sebagai bagian multi-profil:
- `SideBySidePage.tsx` — 5 halte ikonik dengan fasilitas aksesibilitas (ramp, lift, toilet aksesibel, guiding block, staf, step-free).
- **Dual renderer**: daksa visual (chips on/off + placeholder panorama 360°) / netra verbal (TTS `buildStopAnnouncement` + text twin visible + speak button).
- Data facility disajikan **normal tanpa badge simulated** (override user untuk data Daksa/fasilitas).
- Tile "Fasilitas halte" di Beranda (profil netra/daksa) → screen 'side-by-side'.
- OpenSpec guard `sidebyside-check.mjs`.

### B4. Perencana perjalanan ala Moovit (RAPTOR) — ✅ LIVE

- **Mesin RAPTOR** (`backend/planner.py`): earliest-arrival search, walk access/egress via walk graph (`backend/walk_graph.py`, haversine fallback), transfer via `feed.transfers`, **service-day filter** (calendar), **hingga 3 alternatif** via first-leg route banning.
- **Arrive-by (tiba jam X)**: reverse RAPTOR `_run_reverse_raptor` — mengembalikan keberangkatan terakhir yang masih tiba ≤ target.
- **Endpoint** `GET /api/journey/plan` (`backend/api/routers/journey.py`): stop-id atau koordinat, `date`/`time`/`arrive_by`/`include_eta`; 200-degrade `source:"unavailable"`, 422 untuk param invalid.
- **Departure/Arrival independent fields** (upstream `7aed447`): dua input waktu opsional independen — `time` (forward plan) dan `arrive_by` (latest departure), perbaiki kontrak `planner-check.mjs`.
- **Automated bus-arrival simulation** (upstream `7cfdee0`): simulasi per halte dengan animated warnings di PlannerPage (JIS → Blok M demo route, pin ke valid trip window 05:00).
- **Frontend PlannerPage.tsx**: pencarian halte, tab alternatif, daftar leg (WALK/BUS), polyline per leg di Mapbox, **badge keterlambatan per leg** (`delay_minutes`/`live_eta_minutes`/`eta_source:"simulated"`, deterministik zlib.crc32), **banner insiden aktif** di rute, toggle arrive-by, tombol "Pakai lokasi saya" untuk asal default (geolocation → `/api/gtfs/stops/nearby`), handoff ke tracking (`TransitTrackingPage`), **demo: JIS → Blok M button**.
- **Halte favorit + riwayat pencarian**: localStorage `transense.demo-saved-stops.v1` + `transense.demo-search-history.v1` (plannerStorage.ts), cap 10, dedupe, tap-to-fill.
- **Tracking live**: `TransitTrackingPage.tsx` — mode Nomor kendaraan / GPS HP, schematic vs Mapbox view, vibration saat approaching/arrived.
- OpenSpec: `trip-planner-routing` (planner dasar) + `trip-planner-moovit` (Moovit additions) — keduanya archived.

### B5. Jadwal per halte dari GTFS + ETA live (stop schedule board) — ✅

- `GET /api/gtfs/stop/{id}/schedule` — jadwal GTFS per halte (service-day filtered) + ETA live.
- UI layar Jadwal (`frontend/src/screens/SchedulePage.tsx`): `schedule-mode-toggle` bus/kereta, hasil pencarian expandable trayek → daftar halte → jadwal per halte (detail view dengan live ETA + timetable per grup + platform).

### B6. UI Beranda rework — full-screen map + scrolling sheet — ✅

- Beranda 3 zona: (A) **topbar sapaan gradient accent** (gradient biru `#1677ff`, shadow accent samar) + tombol notifikasi dengan badge count; (B) **map full-bleed** antara topbar dan bottom nav (filter rute bus/kereta + mode toggle + locate button); (C) **home-sheet** panel scrollable di atas map (default ~55% tinggi, toggle min/max via grip).
- **Home sheet**: SearchEntry ("Mau ke halte mana?") + grid 2 kolom feature-tile (Antar Aku, Transcribe [tuli-only], Keterlambatan, Fasilitas halte [netra/daksa], Pemindai Netra [netra]) + ArrivalsSheet (bus menuju haltemu) + NetraScan [netra]. Sheet toggle: minimized (hanya search) ↔ maximized (92% tinggi, berhenti tepat di bawah top bar) — resize HANYA via grip button, scroll menelusuri konten.
- **Bottom nav 3 item** (Beranda, Jadwal, Profil) dengan icon SVG (HomeIcon, ScheduleIcon, UserIcon).
- **AppHeader dengan tombol back** (← ArrowBackIcon) di semua screen fitur → kembali ke Beranda.
- **Screen transition**: fade-in + slide-up halus antar screen (keyed wrapper, `prefers-reduced-motion` dihormati).
- **Icon family SVG**: ~11 icon baru (HomeIcon, UserIcon, SearchIcon, ArrowRightIcon, LocateIcon, StarIcon, CloseIcon, ChevronUp/Down, WalkIcon, ArrowUpRightIcon) + existing (BellIcon, AntarAkuIcon, TranscribeIcon, DelaysIcon, ScheduleIcon, AccessibilityIcon, CameraIcon, ArrowBackIcon) — semua glyph/emoji icons dimigrasi ke SVG.
- **Modern & lively styling**: kartu radius 16px + shadow lembut + hover naik 2px, feature-tile icon dalam circle accent, tombol primary shadow accent, state badge rounded, empty-state mark dalam circle accent, token baru (`--brand-radius-2xl`, `--brand-shadow-*`).
- **Android scale**: font base 16px (dulu 18px), control-height 46px (dulu 48px), max-width 480px (dulu 560px), spacing disesuaikan untuk HP — tetap aksesibel (kontras, touch ≥44px).
- Jejak git: `fcf9ba3`, `3166904`, `7ba21d5`, `da1935e`, `c9c2913`, `8ef5514`, `cd77525`, `148c3ce`.

### B7. Fitur lokasi saya — ✅ LIVE

- **Endpoint halte terdekat**: `GET /api/gtfs/stops/nearby?lat=&lng=&limit=` (`backend/api/routers/gtfs.py`) — haversine, urut jarak ascending, clamp 1–20, degrade `source:"unavailable"`; test `test_nearby_stops.py` (5 test: ordering, 422, clamp, degrade).
- **Tombol lokasi di peta Beranda** (`MapboxMap.tsx`): tombol locate (◎ icon) → geolocation → `flyTo` zoom 14 ke lokasi user + **Mapbox marker user** di posisi geografis (bukan overlay); flyTo race fix (handle geolocation resolve sebelum map load via `map.loaded()`/`once('load')`); **marker tidak tembus sheet** (z-index di dalam map, tertutup sheet saat maximized — sesuai perilaku map normal).
- **Asal default "Pakai lokasi saya"** di PlannerPage (Antar Aku): tombol di field asal → geolocation → `/api/gtfs/stops/nearby?limit=1` → halte terdekat jadi origin; error states (izin ditolak, tidak ada halte dekat).
- Jejak git: `3c4667b`, `79e1cb1`, `0b9e3fd`, `a081928`, `1f1ad27`, `148c3ce`.

### B8. Percakapan (conversations) — ✅

- CRUD percakapan dua-arah (`/api/conversations` POST/PATCH/DELETE, `backend/api/routers/conversations.py`; `backend/conversation.py`) — menyimpan pesan dengan sender (user/other) & source (typed/stt), record `conversation` di store.

### B9. Refactor arsitektur — ✅

**Frontend** (`1300c13 refactor(frontend): split monolithic App.tsx`):
- **App.tsx**: ~2600 baris → **113 baris** (shell + MainShell + screen map + onboarding handler).
- **Struktur baru**:
  - `frontend/src/types.ts` — type union Screen, DemoProfile, TransitState, NotificationRecord, dll.
  - `frontend/src/api.ts` — `apiBaseUrl` (dari `VITE_API_BASE_URL`).
  - `frontend/src/connection.ts` — `useBackendConnection` hook (WebSocket + state transit + notifikasi + transkripsi + ramp).
  - `frontend/src/components/` — AppHeader, ArrivalsSheet, BottomNavigation, NotificationRenderer, SearchEntry.
  - `frontend/src/screens/` — DelaysPage, HomePage, Onboarding, ProfilePage, SchedulePage, SplashScreen.
  - File fitur tetap di root: PlannerPage, TransitTrackingPage, ChatTranscribe, SideBySidePage, NetraScan, CameraScan, OccupancyCard, MapboxMap, plannerStorage, profile, tts, notify, approach, journey, profileOptions, icons, mediapipe.worker.

**Backend** (`443f72f refactor(backend): restructure FastAPI into routers/deps/utils layout`):
- **main.py**: 1464 baris → **124 baris** (app factory `create_app()` + lifespan; setup state, middleware, `include_router`).
- **Struktur baru**:
  - `backend/api/routers/` — satu `APIRouter` per domain: `health`, `schedule`, `facilities`, `incidents`, `transcripts`, `ai` (scribe-token/tts/vision), `conversations`, `gtfs`, `transit` (kereta), `realtime` (buses/arrivals), `journey` (track/plan), `ws`.
  - `backend/api/deps.py` — dependency accessor (`get_store`, `get_settings`, `get_gtfs_feed`, ...).
  - `backend/api/utils.py` — helper murni (haversine, lookup GTFS, timetable, ETA enrich, OCR extract, walk-graph loader).
  - Domain tetap di root: `config.py`, `transit.py`, `notifications.py`, `planner.py`, `persistence.py`, `conversation.py`, `transcription.py`, `gtfs_loader.py`, `tj_api.py`, `commute.py`, `sources.py`, `facilities.py`, `walk_graph.py`.
- **Kontrak respons tidak berubah** oleh refactor (semua endpoint tetap `response_model=None` + body dict polos).

### B10. API contract resmi — ✅

- **`docs/api-contract.md`** — dokumentasi lengkap kontrak HTTP + WebSocket backend: struktur kode, konvensi umum (response_model=None, dict body, field `source`, timestamp ISO-8601 UTC `Z`), ringkasan endpoint, detail per router, WebSocket protocol (`connection.ack`, pesan inbound/outbound, error envelope). Source of truth untuk kontrak API.
- Jejak git: `59c03ec docs(api): add backend API contract (HTTP + WebSocket)`.

### B11. Postgres/Docker stack — ✅ (migration support, default SQLite tetap)

- **`persistence.py`**: `Store = DemoStore | PostgresStore`. `DemoStore` (SQLite, default, `sqlite3` stdlib) + `PostgresStore` (PostgreSQL via `DATABASE_URL`, `psycopg` imported lazily) — interface identik (record CRUD, cleanup 7 hari, pin).
- **`docker-compose.yml`**: multi-service stack — `db` (postgis/postgis:16-3.4-alpine), `redis` (redis:7-alpine), `backend` (Dockerfile backend, `DATABASE_URL` postgres), `frontend` (Dockerfile frontend); profiles `routing` (OpenTripPlanner 2.5.0 — butuh GTFS zip + OSM pbf di `./data/otp/`) dan `geocoding` (Photon 0.5.0 + Elasticsearch 8.13.4 — butuh OSM di `./data/osm/`).
- **`.env.example`**: dokumen env lengkap (backend env, `DATABASE_URL` opsional untuk Postgres, `REDIS_URL`/`OTP_URL`/`PHOTON_URL` future wiring, frontend `VITE_API_BASE_URL` + `VITE_MAPBOX_TOKEN`).
- **`requirements.txt`**: `psycopg[binary]>=3.1,<4` ditambahkan.
- **Status**: infrastruktur tersedia; SQLite tetap default untuk production Cloud Run (ephemeral, demo). Redis/OTP/Photon diaktifkan via profile, belum di-wire ke kode (future).
- Jejak git: `8ca6d82 feat(docker): postgres/postgis migration + redis/otp/photon compose`, `57d24ff` (merge).

### B12. Splash screen + tagline baru — ✅

- **Tagline**: "Mobilitas Sepatutnya Mudah untuk Semua" — di splash screen (`frontend/src/screens/SplashScreen.tsx`, logo + tagline), onboarding heading isi nama, dan PWA manifest (`frontend/public/manifest.webmanifest` description).
- Jejak git: `16adc95`, `d7d35ac`.

### B13. Versi Gemastik (branch khusus) — ✅ LIVE (project terpisah)

- **Branch** `origin/gemastik-version` (commit `59a2c2e`): menghapus fitur rail (kereta) + onboarding Netra/Daksa — versi khusus submission Gemastik yang mengembalikan scope TransJakarta-only + Tuli saja.
- **Deployment terpisah** (tidak menyentuh production utama):
  - Frontend: `https://transense-gemastik.vercel.app` (project Vercel `transense-gemastik`).
  - Backend: `transense-backend-gemastik-274699602190.asia-southeast1.run.app` (Cloud Run service `transense-backend-gemastik`, revision 00004, `ELEVENLABS_API_KEY` terpasang untuk STT).
  - Env frontend: `VITE_API_BASE_URL` → backend gemastik, `VITE_MAPBOX_TOKEN` terpasang.
- **Verifikasi**: rail endpoint `/api/transit/lines` → 404 (dihapus), Tuli-only, backend health 200, CORS mengizinkan origin gemastik.

### B14. Sumber data riil yang diintegrasikan (opt-in) — ✅

- **GTFS TransJakarta asli** (URL PPID; `TRANSENSE_GTFS_URL`) — selalu dicoba di startup, fallback seed.
- **TJ realtime internal API** (`tj_api.py`; `TRANSENSE_REALTIME_ENABLED`) — bus live.
- **Commute Data Platform** (kereta; `TRANSENSE_COMMUTE_ENABLED` default ON + `TRANSENSE_COMMUTE_API_BASE`; statis `TRANSENSE_COMMUTE_API_URL` untuk jadwal TJ).
- **ElevenLabs** (STT `ELEVENLABS_API_KEY`; TTS `ELEVENLABS_TTS_VOICE_ID` untuk Netra).
- **Google Cloud Vision** (OCR `GOOGLE_VISION_API_KEY` untuk Netra koridor — proxy backend, server-side only).

---

## Bagian C — Status verifikasi & deployment

| Area | Status |
|---|---|
| Backend tests | ✅ 111 test (16 file) dikoleksi — `python -m pytest backend/tests -q` |
| Frontend build | ✅ `npm run check` (typecheck + build) hijau |
| Contract guards | ✅ `journey` / `transcribe` / `planner` / `planner-storage` / `profile-storage` / `tts` / `notify` / `camera` / `approach` / `sidebyside` exit 0 |
| OpenSpec | ✅ `openspec validate --all --strict` → 12+ lulus (10 specs aktif incl. multi-profil-netra-daksa + 2 change aktif: trip-planner-moovit, trip-planner-routing) |
| Backend production | ✅ Cloud Run live (`transense-backend-j7qpz3oeuq-as.a.run.app`, memuat GTFS + Commute + TJ realtime; health `healthy`) |
| Frontend production | ✅ Vercel live (`frontend-zeta-umber-47.vercel.app`, bundle memuat seluruh fitur incl. multimodal + multi-profil + UI rework + Mapbox token) |
| Versi Gemastik | ✅ Live (`transense-gemastik.vercel.app` + `transense-backend-gemastik-...run.app`, TransJakarta-only Tuli) |
| Android device QA | 🔶 **Belum** — blocker: tidak ada emulator/device (README.md; `docs/android-qa.md` diperluas untuk multi-profil) |

### Item yang masih terbuka
- Android device QA checklist (`docs/android-qa.md`) belum dieksekusi penuh (blocker device).
- Backend Cloud Run production utama: `ELEVENLABS_TTS_VOICE_ID` + `GOOGLE_VISION_API_KEY` belum diset (TTS/OCR degrade 503 — sesuai desain).
- Redis/OTP/Photon di docker-compose: diaktifkan via profile, belum di-wire ke kode (future integration).

---

## Lampiran — Peta fitur → modul/endpoint

| Fitur | Backend | Frontend |
|---|---|---|
| Jadwal & tracking TJ | gtfs_loader.py, tj_api.py, `api/routers/realtime.py` (`/api/buses`, `/api/arrivals`), `api/routers/journey.py` (`/api/journey/track`), WS | screens/HomePage, screens/SchedulePage, MapboxMap.tsx |
| Transcribe + 7 hari + pin | transcription.py, `api/routers/ai.py` (`/api/scribe-token`), `api/routers/transcripts.py` (`/api/transcripts+pin`), WS | ChatTranscribe.tsx |
| Notifikasi 2 jenis + getar | notifications.py, WS `notification.*` | components/NotificationRenderer, journey.ts VIBRATION_PATTERNS |
| Antar Aku (tracking) | `api/routers/journey.py` (`/api/journey/track`), WS `journey.*`/`off_route` | TransitTrackingPage.tsx |
| Perencana Moovit | planner.py, `api/routers/journey.py` (`/api/journey/plan`) | PlannerPage.tsx, plannerStorage.ts |
| Multimodal kereta | commute.py, `api/routers/transit.py` (`/api/transit/*`), rail_geometry.json | screens/HomePage + SchedulePage (mode Bus/Kereta), MapboxMap.tsx |
| Multi-profil | facilities.py, `api/routers/ai.py` (`/api/tts`, `/api/vision/ocr`), `api/routers/facilities.py` (`/api/facilities/stops`, occupancy), WS ramp | profile.ts, notify.ts, tts.ts, CameraScan.tsx, NetraScan.tsx, SideBySidePage.tsx, OccupancyCard.tsx, screens/Onboarding, screens/ProfilePage, mediapipe.worker.ts, approach.ts |
| Beranda rework 3-zona | — (frontend) | screens/HomePage, components/AppHeader, components/BottomNavigation, components/NotificationRenderer, components/SearchEntry, components/ArrivalsSheet, icons.tsx |
| Fitur lokasi saya | `api/routers/gtfs.py` (`/api/gtfs/stops/nearby`) | MapboxMap.tsx (locate button + flyTo), PlannerPage.tsx (Pakai lokasi saya) |
| Percakapan | conversation.py, `api/routers/conversations.py` (`/api/conversations`) | ChatTranscribe.tsx |
| Persistence | persistence.py (DemoStore SQLite + PostgresStore), schema.sql | — |
| Docker/Postgres | docker-compose.yml, persistence.py (PostgresStore), Dockerfile backend, Dockerfile frontend | Dockerfile frontend |
