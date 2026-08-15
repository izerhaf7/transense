# Transense — Implemented Brief

> Status implementasi aktual terhadap `docs/brief.md`, disusun dari inspeksi seluruh repo (backend, frontend, deployment, OpenSpec, git history) — bukan dari rencana.
> **Penanda**: ✅ = selesai & berfungsi; 🔶 = selesai sebagian / dengan catatan; ⬜ = belum dikerjakan.
> Tanggal inspeksi: 2026-08-15 (commit `1afc7a7`, setelah merge multimodal transit).

---

## Ringkasan eksekutif

Transense dibangun sebagai PWA React 19 + Vite 8 (Vercel) dengan backend FastAPI + WebSocket + SQLite (Google Cloud Run). **Semua fitur utama di brief (1–4) sudah diimplementasikan dan berfungsi**, sebagian besar memakai data deterministik seed/simulasi dengan adapter data-riil opsional (GTFS TransJakarta, TJ realtime, Commute Data Platform untuk kereta). Di luar scope brief, **dua fitur besar ikut masuk production**: (1) perencana perjalanan ala Moovit (RAPTOR + arrive-by + keterlambatan/insiden + halte favorit/riwayat) dan (2) **transit multimodal kereta (KCI/MRT/LRT)** — yang merupakan perluasan eksplisit dari penanda `[FINAL] TransJakarta-only` di brief.

URL production: Frontend `https://frontend-zeta-umber-47.vercel.app` · Backend `https://transense-backend-j7qpz3oeuq-as.a.run.app` (DEPLOYMENT.md:14-15).

---

## Bagian A — Fitur brief yang SUDAH diimplementasikan

### A1. Jadwal & tracking posisi armada TransJakarta (Fitur Utama #1) — ✅

- **Jadwal**: layar Jadwal menampilkan trayek + jadwal per halte. Data statis dari GTFS TransJakarta asli (`backend/gtfs_loader.py`; `parse_gtfs` memuat stops/routes/trips/stop_times/shapes/transfers/calendar/calendar_dates, L163-352) atau seed deterministik sebagai fallback (`backend/transit.py`; `backend/sources.py`).
- **Tracking posisi armada real-time**: `GET /api/buses` (main.py:596) memakai `TjRealtimeClient` (`backend/tj_api.py`, guest login + refresh JWT) — **opt-in** via `TRANSENSE_REALTIME_ENABLED`; saat nonaktif/gagal → `source: "unavailable"` (HTTP 200, bukan error). Frontend poll `/api/buses` tiap 15 detik dan menggambar marker bus realtime di peta (App.tsx:1479-1492; MapboxMap.tsx marker inline-styled).
- **WebSocket real-time**: `/api/ws` (main.py:844) — `connection.ack` (protocol `transit-demo.v1`), `transit.update`, `transit.reset`, notifikasi perjalanan, insiden, off-route, transkripsi.
- **Detail halte**: popup info halte + ETA live (`/api/gtfs/stop/{id}/info` main.py:354; `_find_next_stop`), papan kedatangan per halte (`/api/gtfs/stop/{id}/schedule` main.py:406).

### A2. Transcribe — transkripsi percakapan orang (Fitur Utama #2) — ✅

- Layar Transcribe dua-arah (chat) dengan mode **mic + keyboard** (`frontend/src/ChatTranscribe.tsx`: `inputMode 'mic' | 'keyboard'`, L34; komposer L271-343).
- STT real-time via **ElevenLabs Scribe** (`useScribe`: `scribe_v2_realtime`, `languageCode: 'id'`, VAD commit, L56-67) — token dibuat server-side di `GET /api/scribe-token` (main.py:190) dari `ELEVENLABS_API_KEY`.
- **Scope sesuai brief**: hanya transkripsi orang bicara (mikrofon), **bukan** pengumuman PA — enforced di WS boundary (main.py:884-885, 897-898: tolak `audio`/`audio_history`).
- **Histori 7 hari + pin**: transkrip disimpan ke SQLite (`record_type: "transcript"`, `persist_transcript` transcription.py:97-109); `GET /api/transcripts` + `PATCH /api/transcripts/{id}/pin` (main.py:173,180); cleanup 7 hari dengan pengecualian pinned (`persistence.py` L82-86; `cleanup` boundary diuji `test_cleanup_keeps_exact_boundary_and_deletes_older`).
- **Fallback jujur**: `TRANSENSE_STT_PROVIDER=mock` (default) → `MockTranscriptionProvider` deterministik; degradasi visual `source: 'degraded'` / `source: 'mock'` (dijaga transcribe-check.mjs).

### A3. Notifikasi real-time dua jenis + pola getar (Fitur Utama #3) — ✅

- **3a. Notifikasi posisi/status perjalanan** — `NotificationEngine` (backend/notifications.py): ambang armada mendekat 2 menit, halte tujuan mendekat 1 menit (L10-11); event `notification.vehicle_approaching` / `notification.destination_approaching`.
- **3b. Notifikasi keterlambatan/insiden resmi** — format terstruktur ala KAI Commuter: `status/cause/action/instruction` (INCIDENT_STAGES, notifications.py:143-146); event `notification.incident`; feed tersimpan 7 hari (`record_type: "incident"`, pin via `PATCH /api/incidents/{id}/pin` main.py:163); seed delay incident demo ada (`incident-demo-delay-01`, route "1").
- **3 pola getar khas (contract)**: `vehicleApproaching [200,100,200]`, `destinationApproaching [300,100,300,100,300]`, `incident [500,200,500,200,1000]` (journey.ts:54-58) — distinctness diuji (`test_notifications.py` + guard `journey-check.mjs`).
- **Penyampaian audio-blind**: visual teks besar + kilat tepi layar (`edge-flash`) + getar Android via `navigator.vibrate` (guarded, NotificationRenderer App.tsx:1024-1062); Android-only per constraint Vibration API.
- **Bukan deteksi visual**: sumber notifikasi = data tracking (fitur 1), bukan computer vision.

### A4. Antar Aku — lapisan integrasi perjalanan (Fitur Utama #4) — ✅ (dengan perluasan)

- **Routing halte-ke-halte**: pengguna input asal & tujuan → sistem cocokkan ke halte TJ → gambar rute di peta.
- **Sepanjang perjalanan**: notifikasi armada mendekat (3a), insiden (3b), peringatan keluar-rute.
- **Deteksi keluar-rute**: per brief, versi mock/terkontrol untuk demo — `journey.off_route` (trigger/resolve) via WS (main.py:879-880; notifications.py:109-125), tidak memakai geolokasi.
- **Perluasan besar di luar brief (lihat Bagian B)**: Antar Aku kini menjadi **planner penuh ala Moovit** — RAPTOR A→B, arrive-by, alternatif rute, keterlambatan per leg, insiden di rute, halte favorit, riwayat pencarian — bukan sekadar tracker satu armada.

### A5. Fitur sampingan / non-goals — status

- **Side by Side (peta aksesibilitas 3D)** — 🔶 **belum diimplementasikan** (nice-to-have per brief; tidak ada kode terkait di repo).
- **Buddy Up!, wearable/IoT, profil netra, profil mobilitas, indoor nav** — ⬜ sesuai non-goals brief; **tidak dibangun** (diverifikasi tidak ada kode).

---

## Bagian B — Fitur di LUAR brief yang masuk production

Perluasan ini adalah keputusan implementasi yang dilakukan setelah brief ditulis. Yang paling signifikan (multimodal kereta) **memperluas** penanda `[FINAL] Lokasi pilot: TransJakarta` — per AGENTS.md root: "treat `[FINAL]` brief markers as the product decision source unless a newer OpenSpec change overrides".

### B1. Transit multimodal kereta — KCI/MRT/LRT (besar, out-of-brief) — ✅ LIVE

- **Sumber data**: Commute Data Platform adapter `backend/commute.py` (`CommuteClient`/`CommuteFeed`; `RAIL_OPERATORS = KCI/MRTJ/LRTJ`, excludes KAI Bandara; urllib-only). Opt-in namun **default ON** (`TRANSENSE_COMMUTE_ENABLED`, config.py:33,60); feed dimuat di lifespan (main.py:58-65).
- **Endpoint `/api/transit/*`** (main.py:450-594): `lines`, `stations`, `line/{op}/{code}/stations`, `stop/{op}/{code}/info` (amenitas stasiun), `stop/{op}/{code}/schedule`, `lines/geometry`. Degradasi `source: "unavailable"` bila feed/geom hilang.
- **Geometri**: `backend/data/rail_geometry.json` (RITJ-2021) dari `scripts/convert_rail_geometry.py`.
- **UI**: toggle **Bus/Kereta** di peta Beranda + layar Jadwal (App.tsx:1406,1659-1668,2199-2218), marker stasiun kereta, popup info stasiun + amenitas, filter per jalur dengan warna, polyline geometri per jalur (MapboxMap.tsx rail layers/markers/popups).
- Bukti production: `/api/transit/lines` → 7 jalur (KCI:C Cikarang, KCI:B Bogor, KCI:R Rangkasbitung, MRTJ, LRTJ), 113 stasiun, station info dengan amenitas — diverifikasi langsung.
- **Jejak git**: `2e835c2` → `c00af44` (merge multimodal transit).

### B2. Perencana perjalanan ala Moovit (RAPTOR) — ✅ LIVE

- **Mesin RAPTOR** (`backend/planner.py`): earliest-arrival search, walk access/egress via walk graph (`backend/walk_graph.py`, haversine fallback), transfer via `feed.transfers`, **service-day filter** (calendar), **hingga 3 alternatif** via first-leg route banning.
- **Arrive-by (tiba jam X)**: reverse RAPTOR `_run_reverse_raptor` — mengembalikan keberangkatan terakhir yang masih tiba ≤ target (planner.py:607-688).
- **Endpoint** `GET /api/journey/plan` (main.py:772): stop-id atau koordinat, `date`/`time`/`arrive_by`/`include_eta`; 200-degrade `source:"unavailable"`, 422 untuk param invalid.
- **Frontend PlannerPage.tsx**: pencarian halte, tab alternatif, daftar leg (WALK/BUS), polyline per leg di Mapbox, **badge keterlambatan per leg** (`delay_minutes`/`live_eta_minutes`/`eta_source:"simulated"`, deterministik zlib.crc32), **banner insiden aktif** di rute, toggle arrive-by, handoff ke tracking (`TransitTrackingPage`).
- **Halte favorit + riwayat pencarian**: localStorage `transense.demo-saved-stops.v1` + `transense.demo-search-history.v1` (plannerStorage.ts:38-39), cap 10, dedupe, tap-to-fill.
- OpenSpec: `trip-planner-routing` (planner dasar) + `trip-planner-moovit` (Moovit additions) — moovit 6.4 **terverifikasi production** (commit `fa68e43`).

### B3. Jadwal per halte dari GTFS + ETA live (stop schedule board) — ✅

- `GET /api/gtfs/stop/{id}/schedule` (main.py:406) — jadwal GTFS per halte (service-day filtered) + ETA live.
- UI layar Jadwal: `schedule-mode-toggle` bus/kereta, hasil pencarian expandable trayek → daftar halte → jadwal per halte (App.tsx:1815-2234).
- Jejak git: `f587857`, `b32aad3`, `162c2ef`, `f096086`.

### B4. UI Beranda rework — layout 3 zona & resize Android — ✅

- Beranda 3 zona: (A) topbar sapaan + search + **lonceng notifikasi dengan badge count**; (B) **map hero collapsible** (minimized 220px / maximized 80vh, toggle floating) + grid filter bus/kereta; (C) **grid 2 kolom 4 kartu fitur** (Antar Aku, Transcribe, Keterlambatan, Jadwal).
- **Bottom nav dipangkas ke 2 item** (Beranda, Profil) — fitur lain pindah ke kartu grid.
- Resize untuk Android PWA: touch target 48dp, grid 8dp, safe-area (`env(safe-area-inset-*)`).
- Jejak git: `949f9ad`, `12c296d`.

### B5. Percakapan (conversations) — ✅

- CRUD percakapan dua-arah (`/api/conversations` POST/PATCH/DELETE, main.py:203-238; `backend/conversation.py`) — di luar transkrip, menyimpan pesan dengan sender (user/other) & source (typed/stt), record `conversation` di SQLite.

### B6. Sumber data riil yang diintegrasikan (opt-in) — ✅

- **GTFS TransJakarta asli** (URL PPID; `TRANSENSE_GTFS_URL`) — selalu dicoba di startup, fallback seed.
- **TJ realtime internal API** (`tj_api.py`; `TRANSENSE_REALTIME_ENABLED`) — bus live.
- **Commute Data Platform** (kereta; `TRANSENSE_COMMUTE_ENABLED` default ON + `TRANSENSE_COMMUTE_API_BASE`; statis `TRANSENSE_COMMUTE_API_URL` untuk jadwal TJ).

---

## Bagian C — Status verifikasi & deployment

| Area | Status |
|---|---|
| Backend tests | ✅ 82 test (10 file) hijau — `python -m pytest backend/tests -q` |
| Frontend build | ✅ `npm run check` (typecheck + build) hijau |
| Contract guards | ✅ `journey` / `transcribe` / `planner` / `planner-storage` exit 0 |
| OpenSpec | ✅ `openspec validate --all --strict` → 11 lulus (9 specs + 2 change aktif) |
| Backend production | ✅ Cloud Run live (revision terbaru memuat GTFS + Commute + TJ realtime; health `healthy`) |
| Frontend production | ✅ Vercel live (bundle memuat seluruh fitur incl. multimodal + beranda rework + Mapbox token) |
| Android device QA | 🔶 **Belum** — blocker: tidak ada emulator/device (README.md:15; `docs/android-qa.md`) |

### Item yang masih terbuka
- `trip-planner-routing` **task 6.4** (manual browser check) belum dicentang — fungsional dibangun, verifikasi manual menunggu device.
- Android device QA checklist (`docs/android-qa.md`) belum dieksekusi penuh.
- Side by Side (nice-to-have) tidak dibangun (konsisten dengan brief).

---

## Lampiran — Peta fitur → modul/endpoint

| Fitur | Backend | Frontend |
|---|---|---|
| Jadwal & tracking TJ | gtfs_loader.py, tj_api.py, `/api/buses`, `/api/arrivals`, `/api/journey/track`, WS | App.tsx Beranda/Jadwal, MapboxMap.tsx |
| Transcribe + 7 hari + pin | transcription.py, `/api/scribe-token`, `/api/transcripts(+pin)`, WS | ChatTranscribe.tsx |
| Notifikasi 2 jenis + getar | notifications.py, WS `notification.*` | App.tsx NotificationRenderer, journey.ts VIBRATION_PATTERNS |
| Antar Aku (tracking) | `/api/journey/track`, WS `journey.*`/`off_route` | TransitTrackingPage.tsx |
| Perencana Moovit | planner.py, `/api/journey/plan` | PlannerPage.tsx, plannerStorage.ts |
| Multimodal kereta | commute.py, `/api/transit/*`, rail_geometry.json | App.tsx (mode Bus/Kereta), MapboxMap.tsx |
| Beranda rework 3-zona | — (frontend) | App.tsx HomePage, icons.tsx |
| Percakapan | conversation.py, `/api/conversations` | ChatTranscribe.tsx |
| Persistence | persistence.py, schema.sql | — |
