# Transense

PWA phone-only untuk penyandang Tuli pengguna TransJakarta: informasi perjalanan yang
audio-only/tidak andal dikonversi menjadi **visual + haptic** yang setara (teks besar,
kontras tinggi, kilat tepi layar, dan pola getar berbeda per jenis notifikasi).

Demo saat ini memakai **data seed/simulasi deterministik** — bukan feed resmi TransJakarta.
Semua batasan mock vs real ditandai eksplisit di UI dan kontrak.

## Status

- Frontend PWA React + Vite (TypeScript) di **Vercel**
- Backend FastAPI + WebSocket + SQLite di **Google Cloud Run**
- 3 change OpenSpec sudah selesai, di-archive, dan main specs tersinkron
- Android device QA di-skip sementara (tidak ada emulator); checklist siap di `docs/android-qa.md`

## URL demo

- Frontend: https://frontend-zeta-umber-47.vercel.app
- Backend: https://transense-backend-j7qpz3oeuq-as.a.run.app
- Health: https://transense-backend-j7qpz3oeuq-as.a.run.app/api/health

## Struktur

```text
frontend/   React + Vite PWA shell (audio-blind, white-base tokens)
backend/    FastAPI: /api/health, /api/ws, transit seed, notifikasi,
            insiden, transkripsi, SQLite 7-hari cleanup + pin
scripts/    local_replay.py (jalankan backend + frontend sekaligus)
openspec/   spec-driven workflow (specs aktif + changes arsip)
docs/       brief.md (keputusan produk), android-qa.md (QA checklist)
DEPLOYMENT.md  konfigurasi dan nilai deployment
AGENTS.md      panduan kerja untuk agen/developer
```

## Menjalankan lokal

### Cara cepat (backend + frontend sekaligus)

```powershell
python scripts/local_replay.py
```

Lalu buka `http://localhost:5173`.

### Manual

Terminal 1 — backend:

```powershell
python -m pip install -r backend/requirements.txt
$env:TRANSENSE_ENVIRONMENT="local"
$env:TRANSENSE_ALLOWED_ORIGINS="http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174"
python -m uvicorn backend.main:app --reload
```

Terminal 2 — frontend:

```powershell
cd frontend
npm install
npm run dev
```

## Verifikasi

```powershell
# backend tests
python -m pytest backend/tests -q

# frontend typecheck + build
cd frontend
npm run check

# checks deterministik journey & transcribe
npm run check:journey
npm run check:transcribe

# OpenSpec validation
openspec validate --all --strict --no-interactive
```

## Konteks produk

Target: penyandang Tuli (validasi wawancara GERKATIN), TransJakarta, phone-only.
Keputusan final produk ada di `docs/brief.md` (penanda `[FINAL]`).
Fitur: jadwal/tracking armada, transkripsi percakapan langsung, notifikasi
visual+haptic, Antar Aku (rute halte-ke-halte), histori 7 hari dengan pin.
Transkripsi berarti **orang berbicara ke mikrofon**, bukan pengumuman PA.

## Catatan

- Cloud STT hanya boundary + mock fallback; credential backend-only via env,
  tidak pernah masuk browser/repo.
- Live vehicle/ETA/insiden/off-route semuanya simulasi deterministik.
- Detail deployment: `DEPLOYMENT.md`. Panduan kerja: `AGENTS.md`.
