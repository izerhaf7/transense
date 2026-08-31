# Antar Aku Personalisasi per Profil + Userflow Tujuan

## Status
Implemented

## Ringkasan
Jadikan Antar Aku terintegrasi berdasarkan personalisasi masing-masing profil: **Netra** (UI tombol besar + speech per tombol + Transense sebagai "mata" yang membantu sampai tujuan), **Daksa** (Moovit biasa + preview aksesibilitas per stasiun yang bisa dipencet → masuk Side by Side stasiun itu), **Tuli** (flow existing: cari tujuan → pilih rute → notifikasi per ganti halte + peringatan halte mendekat). Ditambah **userflow awal**: sistem menanyakan tujuan, memperkirakan efektivitas MRT berdasarkan metrik; jika cocok → workflow Antar Aku dimulai; jika tidak → sarankan alternatif (tetap spotlight MRT).

## Latar Belakang & Masalah
- Antar Aku (`PlannerPage.tsx`) saat ini generik untuk semua profil — tidak ada personalisasi.
- Netra: butuh tombol besar + speech per interaksi + Transense yang membantu sampai tujuan (sebagai "mata" via kamera/Gemini — spec terpisah).
- Daksa: perlu info aksesibilitas per stasiun (ramp/lift) untuk memilih rute yang aman.
- Tuli: flow yang sudah ada bekerja (visual notifikasi per halte).
- **Userflow tujuan**: menanyakan "mau kemana" → sistem mengevaluasi efektivitas MRT berdasarkan metrik → keputusan (setuju/tidak) → mulai workflow atau sarankan alternatif.

## Hasil Riset

### Kandidat approach untuk personalisasi per profil
| Kandidat | Trade-off |
|---|---|
| **A. Personalisasi berbasis `ProfileType` di level render** (per profil: tombol besar + speech Netra; aksesibilitas Daksa; flow default Tuli) | Mengikuti pola existing (`resolveNotificationOutput` per profil di notify.ts); minimal invasif; data aksesibilitas dari facilities.py sudah ada; tidak perlu AI tambahan untuk Netra (speech via TtsProvider) |
| B. AI-driven personalisasi (Gemini mengubah UI per profil) | Overkill; non-deterministik; tidak perlu untuk 3 profil tetap |
| C. Satu UI generik dengan adaptasi otomatis | Kehilangan kekuatan personalisasi spesifik per profil |

**Keputusan: A.** Personalisasi berbasis profil di level render, mengikuti pola `resolveNotificationOutput` yang sudah ada di `notify.ts`.

### Metrik efektivitas MRT (userflow tujuan)
- **Metrik deterministik** (bukan AI): dari GTFS (rute tersedia, jumlah transfer, waktu total RAPTOR vs alternatif, jarak walk).
- Kriteria: rute MRT langsung tersedia (0-1 transfer) dan total waktu ≤ batas (mis. 45 menit) dan walk ≤ batas (mis. 600m) → **setuju**; jika tidak → **tidak setuju** → sarankan alternatif.
- **Data sudah ada**: `plan_trip` (RAPTOR) menghasilkan itineraries dengan total_minutes, transfers, walk_distance_m, walk_minutes.

### Aksesibilitas Daksa per stasiun
- Data `backend/facilities.py` sudah punya `facilities` per stop (6 boolean). Tampilkan sebagai chips/logo aksesibilitas di tiap stasiun di itinerary; dipencet → masuk Side by Side untuk stasiun itu (`onNavigate('side-by-side')` dengan konteks stop).

## Keputusan Teknis
- **Personalisasi per profil di level render** (`PlannerPage.tsx` + `HomePage.tsx` gating):
  - **Netra**: tombol besar (`min-height` lebih besar, `profile-card`-style besar), speech per tombol ditekan (TtsProvider.speak label tombol), Transense sebagai "mata" — ekstrak tujuan dari destination yang dipilih, integrasi dengan NetraScan/Gemini (spec terpisah) untuk navigasi stasiun saat sampai.
  - **Daksa**: Moovit biasa (flow existing) + chips aksesibilitas per stasiun di itinerary (ramp/lift logo) yang dipencet → `onNavigate('side-by-side')` untuk stasiun itu; OccupancyCard tetap di Profile.
  - **Tuli**: flow existing (cari tujuan → pilih rute → notifikasi visual per ganti halte + peringatan halte mendekat — sudah ada via journey.ts VIBRATION_PATTERNS + NotificationRenderer).
- **Userflow tujuan** (di PlannerPage, sebelum/at plan): setelah destination dipilih, sistem mengevaluasi efektivitas MRT dari itinerary pertama (RAPTOR): total_minutes ≤ batas dan walk_distance_m ≤ batas dan transfers ≤ batas → **setuju** (mulai workflow: tampilkan itinerary + tombol "Lanjut ke tracking"); jika tidak → **tidak setuju** → tampilkan saran "Tujuan agak jauh kalau pakai MRT. Kami sarankan pake ..." (alternatif: bus/kereta atau transportasi lain yang tidak dicover — spotlight MRT, alternatif diluar app).
- **Integrasi Transense-Netra**: NetraScan menerima `destinationStop` (dari planner destination) sebagai konteks Gemini untuk navigasi stasiun (spec terpisah `transense-multi-profil-navigasi.md`).

## Rancangan Spesifikasi Teknis

### PlannerPage.tsx — personalisasi
- Tambah `profile: ProfileType` prop (sudah ada di wiring App.tsx? — cek; kalau tidak, pass dari App.tsx).
- **Netra**: 
  - Semua tombol aksi utama (Cari rute, Pakai lokasi saya, Lanjut ke tracking, Pilihan itinerary) → `min-height: var(--brand-control-height-lg)` (46px) atau lebih besar; class tambahan `planner-btn--netra`.
  - `onPress` speech: `tts?.speak(label)` untuk setiap tombol (TtsProvider dari App.tsx prop).
  - Saat sampai (SimulatedTrackingPage 'arrived') → integrasi: tampilkan "Navigasi ke peron" → pindah ke NetraScan dengan `destinationStop` (spec terpisah).
- **Daksa**:
  - Di `LegRow` / itinerary: untuk setiap BUS stop (from/to), tampilkan chips aksesibilitas jika stop punya data facility (dari `/api/facilities/stops`): `<button class="facility-access-chip" onClick={() => onNavigate('side-by-side', {stopId})}>` dengan ikon aksesibilitas (ramp/lift).
  - Fetch facilities sekali saat mount (sudah ada pola fetch di SideBySidePage L114-132).
- **Tuli**: tidak ada perubahan (flow existing).

### Userflow tujuan (PlannerPage)
- Setelah `choosePoint('destination', stop)` dan sebelum/at `executePlan`:
  - Tampilkan pertanyaan implisit "Mau ke {destination.name}?".
  - Setelah itinerary pertama dihitung (RAPTOR), evaluasi:
    - `setuju = itinerary && itinerary.transfers <= 1 && itinerary.total_minutes <= 45 && (itinerary.walk_distance_m ?? 0) <= 600`
  - Jika `setuju`: lanjut workflow (tampilkan tabs itinerary + tombol "Lanjut ke tracking rute ini").
  - Jika `!setuju`: tampilkan panel saran: "Tujuan agak jauh kalau pakai MRT. Kami sarankan pake [alternatif umum]." — alternatif sederhana: "transportasi darat lain (bus/kereta sejalan)" atau "transportasi online" (di luar app, spotlight MRT). Tetap tampilkan itinerary (info) tapi tanpa highlight "Lanjut ke tracking".
- Metrik dari itinerary pertama (yang tercepat dari RAPTOR).

### Integrasi destination → NetraScan
- Simpan destination yang dipilih sebagai state (mis. `selectedDestination: PlanPoint | null`).
- Pass ke NetraScan via App.tsx wiring: `NetraScan` menerima prop `destinationStop?: {name: string, lat, lng}` (untuk konteks Gemini — spec terpisah).

## Edge Case & Failure Handling
- **Destination tidak dipilih** → userflow tidak dievaluasi (tidak ada itinerary).
- **Tidak ada itinerary (0 hasil)** → tidak setuju → saran alternatif (atau pesan "Tidak ada rute MRT ke sana").
- **Facility tidak ada untuk stop** → chips aksesibilitas tidak ditampilkan (tidak error).
- **Speech/TTS gagal** (Netra) → visible text twin (pola existing).
- **Data aksesibilitas untuk Daksa** → fallback tanpa chips (tidak menggantung).

## Testing Plan
- **Frontend**: `npm run check` + `planner-check.mjs`/`planner-storage-check.mjs` exit 0 (kontrak planner tidak berubah); `notify-check.mjs`/`tts-check.mjs` exit 0.
- **Manual QA** (Android, 3 profil): Netra → tombol besar + speech; Daksa → chips aksesibilitas → pencet → Side by Side; Tuli → flow existing; userflow tujuan → setuju/tidak setuju tampil benar.

## Risiko & Mitigasi
- **Metrik terlalu ketat/longgar** → mitigasi: nilai batas (45 menit, 600m, 1 transfer) sebagai konstanta yang mudah diubah; verifikasi dengan data GTFS nyata.
- **Alternatif "di luar app" tidak jelas** → mitigasi: pesan eksplisit "kami sarankan pake transportasi darat lain" tanpa mengklaim integrasi (spotlight MRT tetap).
- **Speech per tombol mengganggu** → mitigasi: hanya untuk profil Netra; bisa dimatikan via preferensi kanal keluaran (outputChannel 'audio' vs 'auto').

## Referensi
- `frontend/src/PlannerPage.tsx` (executePlan, LegRow, SimulatedTrackingPage, itinerary types)
- `frontend/src/profile.ts` (ProfileType), `frontend/src/notify.ts` (resolveNotificationOutput per profil)
- `frontend/src/tts.ts` (TtsProvider), `frontend/src/NetraScan.tsx`
- `backend/facilities.py` (facility data), `backend/api/routers/facilities.py`
- `frontend/src/SideBySidePage.tsx` (target navigasi chips aksesibilitas)
- `backend/planner.py` (RAPTOR, Itinerary.total_minutes, walk_distance_m)
