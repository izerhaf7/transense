# Transense — Brief Pengembangan Lanjutan (Multi-Profil) — v2

> Brief untuk AI coding agent yang melanjutkan development di atas implementasi Tuli-only yang sudah production (lihat `docs/implemented-brief.md`). Tujuan: memperluas ke profil **Netra** (tunanetra) dan **Daksa** (disabilitas fisik).
> **Versi ini MENGOVERRIDE** keputusan lama di `docs/brief.md` yang menghapus profil Netra (L96/105/199) dan menurunkan Side by Side jadi nice-to-have (L108). Penanda: **[FINAL]** = keputusan owner. **[SARAN — BELUM DIKONFIRMASI]** = usulan, belum diputuskan.
> Scope kerangka ini adalah **memperlihatkan fitur dan cara kerja (userflow)** — bukan produk siap produksi dengan akurasi/skala penuh.

---

## 1. Baseline — Apa yang Sudah Ada (jangan dibangun ulang)

- **Backend**: FastAPI + WebSocket + SQLite (Cloud Run), data layer GTFS TransJakarta asli + TJ realtime + Commute Data Platform (kereta) — profil-agnostik, tidak perlu diubah.
- **Notification engine** (`backend/notifications.py`): event-driven, konten insiden sudah terstruktur (status/cause/action/instruction) — langsung bisa dipakai sebagai input TTS.
- **Vibration contract** (`journey.ts`): 3 pola getar khas — reusable untuk profil Netra.
- **Planner RAPTOR + multimodal rail, Transcribe**: profil-agnostik, tidak perlu disentuh.

**Yang belum ada sama sekali**: model data profil pengguna, onboarding pemilihan profil, lapisan rendering audio (TTS), computer vision, Side by Side, Buddy Up!.

---

## 2. Gap Arsitektural (prasyarat, dikerjakan lebih dulu untuk KEDUA profil)

| Gap | Kenapa blocking |
|---|---|
| Tidak ada model profil pengguna | Tidak ada tempat menyimpan profil aktif (Netra/Daksa/Tuli) |
| Tidak ada onboarding pemilihan profil | Sistem butuh tahu profil aktif untuk menentukan rendering |
| Rendering notifikasi hardcoded ke Tuli (visual+getar+edge-flash) | Perlu diabstraksi jadi lapisan rendering per-profil |
| Tidak ada lapisan audio/TTS | Prasyarat mutlak untuk profil Netra |

**[FINAL]** Dikerjakan lebih dulu sebelum fitur spesifik-profil.

---

## 3. Profil Netra — Fitur & Instruksi Teknis

**[FINAL]** CV+OCR tetap dipakai. Instruksi eksplisit:

- **Deteksi armada mendekat**: MediaPipe Object Detector (`@mediapipe/tasks-vision`, model `efficientdet_lite0` — WASM client-side, kelas COCO "bus", tanpa API key). Jalan di Web Worker (API sinkron).
- **OCR nomor koridor**: Google Cloud Vision API (text detection), **via proxy backend** (CORS blocker browser). Panggil periodik 2–3 detik, bukan tiap frame.
- **Fallback wajib**: kalau setup API/kredensial jadi blocker, minimal buka live camera feed tanpa deteksi aktif. **Simulated-detection mode wajib** untuk demo deterministik (tombol "Simulasikan armada terdeteksi").
- **Panduan arah pintu**: overlay AR sederhana di atas live camera feed (kamera tidak menutup saat info tampil).
- **Output audio**: semua hasil deteksi disuarakan lewat lapisan TTS.
- **Interaction model [FINAL]**: operator mengetuk tombol, TTS membacakan hasil (demo framework, 3-tap maks, tanpa input voice-command baru).
- **Peta verbal (Side by Side untuk Netra)**: lihat bagian 5.

---

## 4. Profil Daksa — Fitur & Instruksi Teknis

- **Status ketersediaan ruang kursi roda + kepadatan penumpang**: cek dulu response API TJ realtime (`tj_api.py`) untuk field `occupancy_status`; kalau ada, pakai. Kalau tidak, isi data buatan wajar (nilai berubah-ubah deterministik berbasis waktu). **[FINAL override 2026-08-15]**: data disajikan normal tanpa penanda sementara (keputusan owner; dokumentasikan sebagai override AGENTS.md).
- **Tombol "minta petugas siapkan ramp"**: endpoint notifikasi sederhana ke channel petugas simulasi (tanpa integrasi eksternal nyata).
- **Side by Side untuk Daksa (pratinjau visual)**: lihat bagian 5.

---

## 5. Side by Side (dipakai Netra & Daksa, satu data model)

- Model data fasilitas per halte (lift/ramp/toilet difabel/guiding block) — dibuat dari nol, isi data masuk akal untuk 3–5 halte pilot ikonik (Bundaran HI, Monas, Kota Tua, Senayan, Blok M).
- **[FINAL]** Keluaran Daksa: pratinjau visual foto 360°/beranotasi (bukan Gaussian Splatting penuh).
- Keluaran Netra: deskripsi verbal terstruktur dibacakan lewat lapisan TTS.

---

## 6. Buddy Up!

**[FINAL] Di-skip untuk iterasi ini.** Next iteration.

---

## 7. Prioritas & Analisis Paralelisasi

**[FINAL] Urutan prioritas: Netra dulu, baru Daksa.**
- Bagian 2 (gap arsitektural) **wajib sekuensial** — blocking untuk kedua profil.
- Setelah bagian 2 selesai, pekerjaan spesifik-profil **bisa paralel** (subsistem berbeda: Netra kamera/CV/TTS; Daksa okupansi/aksi).
- Satu titik koordinasi: Side by Side (data model fasilitas dibuat duluan, renderer per-profil independen).
- **Kesimpulan**: bisa diparalelkan **setelah** fondasi profil (bagian 2) dan data model fasilitas (bagian 5) selesai.

---

## 8. Non-Goals yang Tetap Berlaku

- Wearable/IoT band — phone-only tetap berlaku.
- Buddy Up! — next iteration.
- Profil disabilitas intelektual & tuli-netra (deafblind).
- Pembangunan/perbaikan infrastruktur fisik.
- Kombinasi profil (mis. Tuli+Daksa) — 3 profil tunggal dulu.
- Akurasi/klaim produksi penuh — kerangka demo.
