## Why

Transense saat ini hanya melayani profil Tuli (audio-blind). Pengguna Netra (tunanetra) tidak bisa mengakses informasi yang hanya visual, dan pengguna Daksa (disabilitas fisik) butuh info fasilitas (kursi roda, ramp) yang tidak tersedia. Brief v2 (docs/brief-v2.md) menetapkan perluasan ke 3 profil tunggal dengan lapisan rendering per-profil + TTS.

## What Changes

- Menambahkan model profil pengguna v2 (tuli/netra/daksa) + onboarding pemilihan profil + migrasi dari storage v1.
- Menambahkan lapisan rendering notifikasi per-profil (visual untuk tuli/daksa, audio+TTS untuk netra).
- Menambahkan lapisan TTS (ElevenLabs) untuk output audio profil Netra.
- Menambahkan deteksi armada via kamera (MediaPipe Object Detector) + OCR koridor (Google Cloud Vision via proxy backend) untuk Netra.
- Menambahkan info fasilitas + okupansi kursi roda + tombol minta ramp untuk Daksa.
- Menambahkan Side by Side (data model fasilitas 3–5 halte pilot; renderer visual untuk Daksa, verbal+TTS untuk Netra).

### Non-goals

- Tidak mengimplementasikan kombinasi profil (mis. Tuli+Daksa); 3 profil tunggal dulu.
- Tidak mengimplementasikan Buddy Up! (relawan) — next iteration.
- Tidak mengimplementasikan profil disabilitas intelektual, tuli-netra (deafblind), atau indoor navigation.
- Tidak membangun perangkat wearable/IoT band — phone-only tetap.
- Tidak mengklaim akurasi produksi penuh (deteksi CV/OCR, okupansi, fasilitas) — kerangka demo (userflow).
- Tidak menyediakan input voice-command baru untuk Netra; operator mengetuk, TTS membacakan.

## Capabilities

### New Capabilities

- `profile-selection`: Model profil pengguna v2 (tuli/netra/daksa) + onboarding pemilihan + rendering notifikasi per-profil.
- `netra-detection`: Deteksi armada via kamera (MediaPipe) + OCR koridor (Google Cloud Vision proxy) + output TTS.
- `daksa-facilities`: Data fasilitas halte + okupansi kursi roda + tombol minta ramp + Side by Side (visual 360° / verbal+TTS).

### Modified Capabilities

Tidak ada; memperluas `demo-app-shell` (onboarding/profile) dan `demo-persistence` (data fasilitas) yang sudah ada.
