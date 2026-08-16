# Android QA Checklist — Transense Demo

Blocker saat ini: semua task OpenSpec yang tersisa memerlukan perangkat Android nyata
(foundation 6.3, 7.1, 7.2, 7.3; journey 5.5, 9.1; transcribe 4.3). `adb devices` kosong dan
emulator tidak terpasang. Checklist ini adalah langkah eksekusi yang siap dipakai begitu
device tersambung; setelah lulus, centang task terkait.

## Prasyarat

- Perangkat Android (fisik) dengan Chrome terbaru dan USB debugging aktif.
- Sambungkan dan verifikasi: `adb devices` harus menampilkan satu baris `device`.
- Pastikan perangkat punya akses internet (demo deployed).

## URL demo (saat ini)

- Frontend (PWA): `https://frontend-zeta-umber-47.vercel.app`
- Backend: `https://transense-backend-j7qpz3oeuq-as.a.run.app`
- Health check: `https://transense-backend-j7qpz3oeuq-as.a.run.app/api/health`

## 1. Foundation — 6.3, 7.1, 7.2

Buka URL frontend di Chrome Android, lalu verifikasi:

1. PWA dapat diinstal (manifest + icon + service worker).
2. Onboarding: isi nama → tombol "Masuk ke Transense" → Beranda.
3. Beranda: greeting, status card menampilkan seed ETA, WebSocket badge `TERHUBUNG`.
4. Bottom nav: Beranda → Keterlambatan → Profil, state terpilih tetap terlihat.
5. Keterlambatan: feed insiden tersimpan tampil; tombol "Simpan / pin" berfungsi.
6. Jadwal & armada: tile "Jadwal TransJakarta" → ETA update "Maju 1 menit" dan "Reset ke seed".
7. Status card dan WebSocket tetap `TERHUBUNG` di device, bukan hanya desktop.

## 2. Journey — 5.5, 9.1

1. Antara tile "Antar Aku": isi tujuan "Bundaran HI" → Cocokkan → "Mulai perjalanan demo".
2. Simulasi keluar rute → warning "Keluar rute simulasi" → "Tandai kembali ke rute" → resolved.
3. **Getar (5.5):** verifikasi tiga pola berbeda saat notifikasi muncul, persis sesuai design.md:
   - Armada mendekat: `[200, 100, 200]`
   - Halte tujuan mendekat: `[300, 100, 300, 100, 300]`
   - Insiden resmi: `[500, 200, 500, 200, 1000]`
   - Catatan: iOS/Safari tidak valid untuk verifikasi getar; `navigator.vibrate()` hanya Android.

## 3. Transcribe — 4.3

1. Buka tile "Transcribe" → "Mulai transcribe".
2. Izinkan akses mikrofon saat diminta sistem Android.
3. Ucapkan kalimat sederhana → teks hasil tampil besar dan mudah dibaca.
4. Tolak izin sekali lagi → state `DEGRADED` / `MOCK DEMO` tampil jelas, aplikasi tetap navigable.
5. History transkrip tampil dengan timestamp; tombol "Simpan / pin" berfungsi.

## 4. Multi-profil (Netra + Daksa) — change `multi-profil-netra-daksa` (2026-08-16)

> Bagian ini melengkapi checklist untuk verifikasi device nyata dari change multi-profil-netra-daksa.
> Flow Netra butuh **HTTPS** (getUserMedia tidak valid di LAN-IP http). Gunakan URL demo deployed.

1. **Onboarding 3-profil**: fresh profile → 3 kartu (Tuli/Netra/Daksa) tampil → pilih **Netra** → isi nama → Beranda. Verifikasi localStorage `transense.demo-profile.v2` berisi `profile: "netra"`.
2. **Netra — camera + simulated detection + TTS**:
   - Izinkan kamera → NetraScan tampil di Beranda (status "Mencari bus…").
   - Aktifkan "mode demo tersimulasi" → klik tombol simulasikan → status **"Bus mendekat!"** → verifikasi getar `[200, 100, 200]` (vehicleApproaching) + audio TTS terdengar.
   - Tolak izin kamera → error "Kamera tidak tersedia — aktifkan izin kamera" tampil, aplikasi tidak crash, mode simulasi tetap berfungsi.
3. **Netra — OCR koridor (opsional)**: dengan `GOOGLE_VISION_API_KEY` terisi di backend, arahkan kamera ke koridor bus → nomor koridor dibacakan via TTS (periodik 2–3s). Tanpa key → mode kamera-only, tidak error.
4. **Side by Side (netra)**: kartu "Side by Side" tampil → 5 halte (Bundaran HI, Monas, Kota Tua, Senayan, Blok M) → tombol "Bacakan" → TTS membacakan fasilitas + text twin tampil.
5. **Daksa — occupancy + ramp**:
   - Reset profil → pilih **Daksa** → okupansi kursi roda tampil (low/moderate/high, deterministik).
   - Tombol "Minta petugas siapkan ramp" → konfirmasi "Petugas menerima permintaan ramp" tampil (WS ack).
   - Side by Side (daksa): chips Ramp/Lift/Guiding block/Staf/Step-free dengan state jelas — **tanpa badge DEMO/simulated pada data fasilitas** (override user).
6. **Tuli regression**: reset → pilih **Tuli** → kartu "Side by Side" **tidak** tampil; notifikasi visual + haptic tetap normal.
7. **Switch profil mid-camera**: Netra dengan NetraScan aktif → reset profil → Tuli → Beranda normal, tidak crash.

## 5. Finalisasi — 7.3

Setelah 1–4 lulus, jalankan dari komputer:

```powershell
python -m pytest backend/tests -q
cd frontend; npm run typecheck; npm run build
openspec validate --all --strict --no-interactive
```

Lalu centang task: foundation 6.3, 7.1, 7.2, 7.3; journey 5.5, 9.1; transcribe 4.3; multi-profil-netra-daksa 4 (Android QA via HTTPS).
