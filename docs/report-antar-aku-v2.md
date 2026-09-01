# Report: Antar Aku v2 — Real Tracking + Multimodal Connected

Status: merged to `main` (commit `e1b6327`, branch `Antar-Aku-Real`). Target profil: **Tuli** (visual + haptic + edge-flash, tanpa audio).

## Antar Aku sebelum (v1)

- **Moda**: hanya TransJakarta bus (RAPTOR over GTFS resmi). Scope spec lama: *"tidak mencari rute lintas operator"* — MRT/KRL/LRT tidak disarankan.
- **Tracking setelah pilih rute**: simulasi deterministik (`SimulatedTrackingPage`, 1 menit = 3 detik, UI berlabel "SIMULASI PERJALANAN").
- **ETA bus di halte**: kasar (`jarak / 0.3`), tanpa ETA operator.
- **Posisi kereta**: tidak ada.
- **Jalan kaki**: haversine garis lurus x1,4.
- **Pemilihan rute**: hanya total waktu tercepat.

## Yang dikerjakan di v2

### 1. Real tracking (bukan simulasi)
- `SimulatedTrackingPage` dihapus -> `JourneyTrackingPage.tsx`: GPS user (`watchPosition`), geofence 100 m (tiba) / 500 m (mendekat), advance leg itinerary otomatis tiap halte yang dilewati, tombol manual "Naik bus/kereta" jika GPS ditolak.
- Notifikasi Tuli per transisi: `navigator.vibrate` (`vehicleApproaching` [200,100,200], `destinationApproaching` [300,100,300,100,300]) + edge-flash + `aria-live="assertive"` teks besar.

### 2. ETA bus real (`/api/arrivals`)
- ETA 3 tingkat: **realtime** (ETA operator TJ per halte) -> **scheduled** (jadwal GTFS, di-clamp dengan estimasi jarak) -> **estimated** (jarak/kecepatan).
- Filter `route_code` + field `eta_source`/`lat`/`lng` per kedatangan.
- Terverifikasi live: `eta 2 realtime` (bus koridor 6).

### 3. Multimodal connected — semua moda dalam satu pencarian
- `rail_planner.py` (menggantikan `mrt_planner.py`): saran **WALK -> RAIL -> WALK** untuk MRT (MRTJ:M), KRL (KCI:B/C/R/T/TP), LRT (LRTJ:S).
- `plan_intermodal`: **bus -> kereta -> bus** dalam satu itinerary (RAPTOR ke/ dari stasiun yang dilewati koordinat).
- **Jaklingko (98 rute `JAK.*`) + BRT (koridor) + non-BRT (feeder)** sudah ada di GTFS TransJakarta dan ikut dirutekan RAPTOR (terbukti live: `JAK.79` langsung, rantai `3C -> JAK.04 -> 2A`).
- Ranking **utamakan transit, minim jalan kaki**: sort `total_menit + walk_menit x 0.5`; radius akses rail 1500 m; alternatif dibatasi 8.
- Mode `arrive_by` tidak menampilkan saran rail (estimasi tanpa jam tidak bisa menjanjikan waktu tiba).

### 4. Posisi kereta (referensi menunggu)
- `rail_positions.py` + `GET /api/transit/positions`: interpolasi jadwal di atas geometry rel (`rail_geometry.json`) -> `progress_pct` + stasiun berikutnya + marker di peta. Kosong di luar jam operasi (benar).

### 5. Walk graph osmnx (siap, cache haversine sementara)
- `walk_graph.py`: build osmnx **chunked per grid** (batch + logging, RAM terkontrol) dari extract OSM lokal (`data/osm/jakarta-walk.osm`).
- Keputusan sementara: cache `walk_graph_cache.json` = haversine (370.880 edge). Regenerate kapan pun: `python scripts/build_walk_graph.py --method osmnx --osm-file data/osm/jakarta-walk.osm --output backend/walk_graph_cache.json`.

## Perbandingan

| Aspek | v1 (dulu) | v2 (sekarang) |
|---|---|---|
| Moda | TransJakarta bus saja | BRT + non-BRT + Jaklingko + MRT + KRL + LRT + kombinasi bus<->kereta |
| Tracking | Simulasi (1 mnt = 3 dtk) | Real: GPS user + ETA bus realtime + advance leg |
| ETA bus | jarak/0.3 kasar | ETA operator realtime (3-tier) |
| Posisi kereta | Tidak ada | Simulasi jadwal (progress + stasiun berikutnya) |
| Pemilihan rute | Tercepat | Utamakan transit, minim jalan kaki |
| Jalan kaki | Haversine | Haversine sementara (osmnx siap) |
| Aksesibilitas Tuli | Notifikasi dasar | Getar + edge-flash + teks besar per transisi |

## Verifikasi

- Backend: **158 test lulus** (test baru: arrivals, rail_planner, rail_positions, walk_graph osm_file).
- Frontend: typecheck + build hijau; contract guards lulus.
- Live di Docker: backend `:8001` healthy; frontend `:5173`; endpoint `journey/plan` mengembalikan alternatif bus/kereta/intermodal; `arrivals` ETA realtime.

## Masih DEMO / open item

- Jalan kaki antar halte: haversine (osmnx siap regenerate).
- Badge delay di hasil plan (`enrich_bus_legs_eta`): simulasi deterministik (label "simulasi").
- Posisi kereta: simulasi jadwal (bukan feed realtime rail) — sengaja, asumsi 99% on-time.
- Verifikasi GPS tracking di device Android nyata (butuh device; fallback tombol manual sudah ada).
