# Transense Multi-Profil Navigasi: Netra (Navigasi Stasiun + Gemini Multimodal) & Daksa (Side by Side)

## Status
Draft

## Ringkasan
Perluas fitur Transense multi-profil: untuk profil **Netra** (tunanetra), tambahkan **navigasi dalam stasiun** — pengguna memotret ke depan stasiun, Gemini multimodal menganalisis gambar dan memberi instruksi kanan/kiri/depan menuju peron sesuai tujuan; untuk profil **Daksa**, fitur Side by Side tetap sebagai peta aksesibilitas (ditingkatkan menjadi panorama 360° beranotasi — spec terpisah). Scope: **1–2 stasiun major** (Bundaran HI + Senayan).

## Latar Belakang & Masalah
- Profil Netra saat ini hanya mendapat: notifikasi TTS, pendekatan bus via kamera (MediaPipe + approach heuristic), OCR koridor. Tidak ada navigasi spasial dalam stasiun.
- Kebutuhan nyata (dari requirement): pengguna tunanetra perlu diarahkan ke peron yang benar dengan instruksi lisan yang aman dan spesifik ("Ke kiri, ada eskalator. Ke depan, garis kuning peron."). AI harus tahu tujuan pengguna agar instruksi relevan.
- Tujuan tersedia dari Antar Aku (PlannerPage memiliki destination/target stop), jadi Transense harus mengekstrak tujuan dan menggunakannya sebagai konteks Gemini.
- Profil Daksa: Side by Side sudah ada (placeholder "Pratinjau 360°"), dan tetap menjadi fitur aksesibilitas visual utama.

## Hasil Riset

### Kandidat approach untuk analisis visual stasiun
| Kandidat | Trade-off |
|---|---|
| **A. Gemini multimodal (Google AI Studio)** — `gemini-2.5-flash-lite` via `generateContent` + JSON schema | Akurasi visual terbaik (analisis scene kompleks: eskalator, lift, garis kuning, peron); biaya sangat kecil (~$0.0002/request paid, $0 free tier); latensi ~1-3 detik; perlu key baru `GEMINI_API_KEY` (external dependency); degrade `source:"unavailable"` saat key hilang (pola repo yang ada) |
| B. Google Cloud Vision OCR + MediaPipe (existing) | Tanpa dependensi baru; tapi OCR hanya membaca teks (tidak menganalisis scene/navigasi); MediaPipe hanya deteksi objek (bus), bukan landmark stasiun; tidak cukup untuk navigasi kanan/kiri yang berarti |
| C. Manual landmark detection (geofencing koordinat) | Deterministik tanpa AI; tapi butuh pemetaan presisi 1-2 stasiun + GPS dalam ruangan tidak andal; tidak skala |

**Keputusan: A — Gemini multimodal.** Justifikasi: (1) akurasi navigasi visual jauh lebih baik daripada OCR+MediaPipe; (2) biaya nyaris nol untuk demo (free tier 1.500 RPD shared); (3) pola degrade konsisten dengan repo (`source:"unavailable"` saat key hilang, tidak crash); (4) JSON schema + `max_output_tokens≈150` + `temperature=0.1` = output stabil untuk TTS; (5) Google AI Studio (bukan Vertex) = setup minimal untuk prototype.

### Model & endpoint (dari riset librarian)
- **Model**: `gemini-2.5-flash-lite` (GA stabil, termurah $0.10/1M input, thinking OFF default = latensi terendah). Env override `TRANSENSE_VISION_MODEL`. JANGAN `gemini-1.5-flash` (retired 2025), `gemini-2.0-flash` (retired June 2026), atau model `-preview`.
- **Endpoint**: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, header `x-goog-api-key: $GEMINI_API_KEY`.
- **Payload**: base64 inline JPEG (max 20MB total; resize ~1024px di frontend → ~4 tile ≈ 1.032 token), teks setelah gambar, `maxOutputTokens: 150`, `responseMimeType: "application/json"`, `responseSchema` (structured output).
- **AI Studio vs Vertex**: AI Studio — setup 1 API key, free tier, tanpa billing. Vertex perlu GCP project + service account (overkill).
- **Prompt** (Bahasa Indonesia, TTS-friendly): instruksi navigasi singkat, mulai dengan arah, landmark terdengar (eskalator, lift, garis kuning, palang tiket, peron), keselamatan dulu (garis peron/celah/kereta mendekat → peringatan), max 2 kalimat / 20 kata.

## Keputusan Teknis
- **Gemini multimodal** sebagai satu-satunya sumber analisis visual stasiun untuk Netra (bukan OCR+MediaPipe).
- **Proxy backend** `POST /api/vision/nav` (pola `POST /api/vision/ocr` yang ada di `backend/api/routers/ai.py`): key server-side (`GEMINI_API_KEY`), degrade `source:"unavailable"` saat key hilang/error/timeout, teks instruksi tidak pernah difabrikasi (kosong = kosong).
- **Tujuan dari Antar Aku**: ekstrak destination stop dari PlannerPage (target yang dipilih pengguna) dan kirim sebagai `destination` + `station_context` ke Gemini agar instruksi relevan.
- **Navigasi arah**: output JSON `{arah: kiri|kanan|depan|berhenti|tidak_jelas, instruksi: string, landmark: string|null, percaya_diri: float}` → `arah` → pola getar kategori + edge flash; `instruksi` → TTS via `TtsProvider`.
- **Pipeline**: kamera (CameraScan existing) → frame periodik (mis. saat user ketuk "Navigasi" atau 3-5 detik) → base64 → `/api/vision/nav` → JSON → TTS + vibrasi.

## Rancangan Spesifikasi Teknis

### Data model / schema
Tidak ada perubahan store. Env baru (server-side only): `GEMINI_API_KEY` (Google AI Studio), `TRANSENSE_VISION_MODEL` (default `gemini-2.5-flash-lite`).

### API baru
`POST /api/vision/nav` (di `backend/api/routers/ai.py`, pola `/api/vision/ocr` L56-84):
- Body: `{image_base64: string (≤5M chars), station_context: string, destination: string}`
- `GEMINI_API_KEY` hilang → 503 `{"detail": "Gemini vision not configured"}`
- Call Gemini: httpx POST generateContent (timeout 12s via `asyncio.wait_for` + SDK retry 429/5xx)
- Sukses → `{source: "gemini", model: string, instruction: {arah, instruksi, landmark, percaya_diri}}`
- Error/timeout/empty → 200 `{source: "unavailable", fallback_text: "Fitur navigasi kamera tidak tersedia. Gunakan tombol bantuan atau tanya petugas stasiun."}` (TTS-friendly, tidak pernah 500)

### Frontend — Netra navigasi (perluasan NetraScan)
- `frontend/src/NetraScan.tsx` (existing): tambah mode "Navigasi stasiun" di samping deteksi armada:
  - Tombol besar "Navigasi ke peron" (min-height besar, profil Netra = tombol besar).
  - Ambil frame dari CameraScan (`onFrame`) periodik (mis. saat tombol ditekan atau tiap 4 detik saat mode aktif).
  - Base64 → `POST /api/vision/nav` dengan `station_context` (nama stasiun dari facility/GTFS terdekat) + `destination` (dari Antar Aku destination).
  - Respons: `instruction.instruksi` → `tts.speak(...)`; `instruction.arah` → vibrasi pola kategori + status visual besar; `percaya_diri` rendah → qualifier.
  - Degrade: `source:"unavailable"` → `tts.speak(fallback_text)` + tampilkan teks besar (text twin).
- Ekstraksi tujuan: PlannerPage menyimpan `destination` (PlanPoint). NetraScan menerima prop `destinationStop?: {name: string}` atau membaca dari state planner (lewat App.tsx wiring — planner destination di-pass ke NetraScan via prop dari App.tsx).

### Backend modul baru (opsional, atau inline di ai.py)
Fungsi murni `_build_nav_prompt(station_context, destination)` (Bahasa Indonesia, TTS-friendly) — untuk determinisme prompt dan unit test.

### Scope stasiun
1-2 stasiun major: **Bundaran HI** (fac-bundaran-hi) + **Senayan** (fac-senayan) — data facility sudah ada (`backend/facilities.py` L11-82).

## Edge Case & Failure Handling
- **Key hilang** → 503 → degrade ke fallback_text (TTS + teks besar), tidak crash.
- **Timeout Gemini (>12s)** → fallback_text.
- **Respons kosong/diblok safety** → fallback_text.
- **Gambar gelap/kabur/bukan stasiun** → Gemini mengembalikan `arah:"tidak_jelas"` → instruksi minta foto ulang.
- **Tujuan tidak dipilih** (pengguna belum pakai Antar Aku) → gunakan station_context saja, instruksi generik menuju peron.
- **TTS gagal** → visible text twin selalu tampil (pola NetraScan existing L165-190).
- **Kamera ditolak** → error Indonesia + fallback (CameraScan existing readableCameraError).

## Testing Plan
- **pytest backend**: mock Gemini client → 200 dengan instruction JSON; key hilang → 503; error → 200 source:"unavailable"; timeout → 200 unavailable; input image_base64 kosong/terlalu besar → 422.
- **pytest prompt**: `_build_nav_prompt` menghasilkan prompt dengan station_context + destination benar.
- **Frontend**: `npm run check` + guard `approach-check.mjs`/`notify-check.mjs`/`tts-check.mjs` exit 0 (tidak merusak kontrak existing); NetraScan mode navigasi render tombol besar + status.
- **Manual QA** (Android): onboarding Netra → kamera → tombol navigasi → TTS + vibrasi + teks besar; kamera ditolak → error Indonesia; key hilang → fallback.

## Risiko & Mitigasi
- **Akurasi Gemini pada scene stasiun Indonesia** → mitigasi: prompt dengan landmark spesifik (eskalator, garis kuning, palang tiket), scope 1-2 stasiun, percaya_diri qualifier saat rendah, instruksi keselamatan dulu.
- **Latensi ~1-3 detik** untuk navigasi berjalan → mitigasi: event-driven (bukan kontinu), thinking off, cap output tokens, resize gambar.
- **Biaya** → mitigasi: free tier 1.500 RPD; paid ~$0.20/1.000 request (nyaris gratis).
- **Privasi (free tier data dipakai Google)** → mitigasi: pertimbangkan paid tier untuk pilot; dokumentasikan.
- **API key hilang di production** → mitigasi: degrade `source:"unavailable"`, tidak pernah 500.

## Referensi
- Gemini API docs: https://ai.google.dev/gemini-api/docs/api-overview, https://ai.google.dev/gemini-api/docs/image-understanding, https://ai.google.dev/gemini-api/docs/pricing, https://ai.google.dev/gemini-api/docs/rate-limits, https://ai.google.dev/gemini-api/docs/api-errors
- Model lifecycle: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions
- Existing repo: `backend/api/routers/ai.py` (pola `/api/vision/ocr`), `frontend/src/NetraScan.tsx`, `frontend/src/CameraScan.tsx`, `frontend/src/approach.ts`, `frontend/src/tts.ts`
