# Realtime Tracker Interpolasi ala Gapeka

## Status
Draft

## Ringkasan
Tambahkan **realtime tracker** yang menampilkan posisi armada TransJakarta/MRT bergerak mulus di peta — bukan dari API realtime (yang tidak ada), melainkan **interpolasi posisi dari jadwal GTFS (stop_times) + polyline rute (shapes)** — seperti platform Gapeka. Backend menghitung posisi otoritatif deterministik per trip aktif; frontend poll dan animasikan dengan rAF.

## Latar Belakang & Masalah
- Tracker MRT/TransJakarta tidak ada API realtime resmi; kita "akalin" dengan jadwal yang tepat waktu + titik-titik diinterpolasi (seperti Gapeka).
- Saat ini `TransitTrackingPage.tsx` **orphaned** (tidak diimpor App.tsx; Antar Aku = PlannerPage, dan "Lanjut ke tracking" masuk ke SimulatedTrackingPage simulasi, bukan realtime).
- Marker bus saat ini snap ke stop (loncat), bukan bergerak mulus sepanjang rute.
- Data untuk interpolasi sudah ada: `feed.stop_times` (urutan stop + arrival/departure per trip, sorted), `feed.shapes` (polyline lat/lng terurut per shape_id), `service_active_on` (kalender), `trip.shape_id` → geometri.

## Hasil Riset

### Kandidat approach interpolasi
| Kandidat | Trade-off |
|---|---|
| **A. Backend authoritative + frontend rAF smoothing** — backend hitung posisi per trip aktif (pure function waktu), frontend poll 1-2s + animasikan lerp antar poll | Deterministik (satu clock server, multi-klien identik — penting untuk demo); reuse `GtfsFeed`/`service_active_on`/`_parse_time` (satu implementasi); latensi disembunyikan animasi; cocok arsitektur repo (backend gateway, degrade `source:"unavailable"`); biaya server trivial (O(trip aktif) + binary search); kekurangan: RTT + interval (disembunyikan animasi) |
| B. Frontend menghitung dari jadwal (client-side) | Latensi ~0; tapi duplikasi logika parse GTFS/kalender di TypeScript (ratusan baris); clock device bervariasi (skew, timezone bug); melanggar pola gateway backend repo; feed GTFS besar ke browser |
| C. Physics engine (accel/braking) ala AluRail | Lebih realistis; tapi non-deterministik dan overkill untuk demo |

**Keputusan: A.** Backend authoritative (satu clock, deterministik, multi-klien identik) + frontend poll + animasikan lerp/easing antar poll.

### Algoritma (dari fastgtfs + Transitland + gtfs2gps)
- **Precompute per trip**: snap tiap stop ke shape-point terdekat (scan monoton), `cum_dist` kumulatif tiap shape point.
- **Posisi pada waktu `t`**: temukan segmen `i` dengan `departure[i] ≤ t < arrival[i+1]`; `frac = (t - dep_i) / (arr_{i+1} - dep_i)`; `dist = cum_dist[stop_shape_idx[i]] + frac * (cum_dist[stop_shape_idx[i+1]] - cum_dist[stop_shape_idx[i]])`; posisi = titik pada shape pada jarak `dist`.
- **Dwell otomatis**: selama `arrival[i] ≤ t < departure[i]` → kecepatan 0, posisi tetap di stop.
- **Service-day**: trip aktif = `departure_first ≤ now < arrival_last`, kalender via `service_active_on` (existing, gtfs_loader.py L359-391); trip lewat tengah malam: cek service_date hari ini + kemarin; waktu >24 jam (mis. "25:30:00") parse ke detik (existing `_parse_time` di planner.py L169-177).
- **Timezone**: GTFS = Asia/Jakarta (WIB/UTC+7). `now` dihitung server UTC → WIB (`now_service_time`). Jangan pakai clock klien untuk logika.

### Smooth movement frontend
- Poll `/api/vehicle-positions` tiap 2 detik (lebih cepat dari `/api/buses` yang 15s — jangan ubah yang lama).
- Animasikan marker dengan `requestAnimationFrame` lerp dari posisi lama ke target baru (~900ms, easeOutCubic) — pola Mapbox resmi.
- Atau dead-reckoning: server kembalikan `position + speed_mps + bearing + server_now`, klien ekstrapolasi tiap frame.

### Struktur data untuk interpolasi (existing)
- `GtfsFeed.stop_times: dict[trip_id → list[GtfsStopTime]]` sorted by stop_sequence (gtfs_loader.py L249-250).
- `GtfsFeed.shapes: dict[shape_id → list[GtfsShapePoint]]` sorted by sequence (L266-267).
- `GtfsTrip.shape_id` → geometri (L47-54).
- `service_active_on(feed, service_id, date)` (L359-391).
- `_parse_time` (planner.py L169-177), `_active_trips_by_route` (L232-244), `haversine` (planner.py L193-202, utils.py L36-40).

## Keputusan Teknis
- **Backend authoritative**: modul baru murni `backend/vehicle_positions.py` (gaya planner.py: stdlib-only, pure function waktu, tanpa state/random) — menghitung posisi semua trip aktif pada waktu `now`.
- **Endpoint baru** `GET /api/vehicle-positions` (router baru `backend/api/routers/vehicles.py` atau di `realtime.py`): kembalikan `{source: "scheduled"|"unavailable", status: "ok"|"outside_service_hours", server_time, vehicles: [{id, trip_id, route_id, route_code, lat, lng, speed_mps, bearing, status: 'at_stop'|'en_route'}]}`.
- **Cache geometri per trip** di `app.state` (bangun sekali per feed load, invalidasi saat feed reload — pola `gtfs_feed` di lifespan main.py L44-51).
- **Frontend**: poll `/api/vehicle-positions` tiap 2 detik; animasikan marker dengan rAF lerp dari posisi lama ke target baru; gunakan `server_time` dari snapshot untuk delta-time (bukan clock klien untuk logika).
- **Integrasi**: gunakan data trips/shapes/kalender dari `GtfsFeed` existing; degradasi `source:"unavailable"` bila feed hilang; `outside_service_hours` bila tidak ada trip aktif; fallback stop-to-stop garis lurus bila `shape_id` kosong (tandai `geometry:"estimated"`).
- **Tidak mengklaim realtime**: label UI "simulasi jadwal" (konsisten aturan repo: jangan klaim mock adalah real).

## Rancangan Spesifikasi Teknis

### Data model / schema
Tidak ada perubahan store. Modul baru `backend/vehicle_positions.py`:
```python
TripGeometry { shape: list[GtfsShapePoint], cum_dist: list[float], stop_shape_idx: list[int], dep_s: list[int], arr_s: list[int] }
VehiclePosition { id, trip_id, route_id, route_code, lat, lng, speed_mps, bearing, status }
```

### API baru
`GET /api/vehicle-positions` (`backend/api/routers/vehicles.py`, prefix `/api`):
- Response: `{source: "scheduled", status: "ok", server_time: ISO, vehicles: [...]}` atau `{source: "unavailable", status: "outside_service_hours", vehicles: []}` (HTTP 200).
- Cache `app.state.vehicle_geometry_cache: dict[trip_id → TripGeometry]` (bangun per feed load).

### Backend modul `backend/vehicle_positions.py`
```python
WIB_OFFSET_S = 7 * 3600

def now_service_time(now_utc) -> tuple[date, int]  # (service_date, seconds_since_midnight WIB)
def build_trip_geometry(feed, trip_id) -> TripGeometry | None
def position_at(g: TripGeometry, now_s: int) -> dict  # pure function waktu
def vehicles_at(feed, cache, now_utc) -> dict  # semua trip aktif
```

### Frontend
- Komponen baru/penambahan di Beranda atau TrackingPage: poll `/api/vehicle-positions` tiap 2s, animasikan marker dengan rAF lerp.
- Marker `mapboxgl.Marker` per kendaraan (pola `.vehicle-marker` existing), `setLngLat` di loop rAF.
- Label "simulasi jadwal" di UI.

## Edge Case & Failure Handling
- **Feed hilang** → `source: "unavailable"`, `vehicles: []` (HTTP 200, pola repo).
- **Tidak ada trip aktif (di luar jam operasional)** → `status: "outside_service_hours"`, `vehicles: []`, copy UI "Di luar jam operasional layanan".
- **`shape_id` kosong** → fallback interpolasi stop-ke-stop garis lurus, `geometry: "estimated"`.
- **Trip selesai (t ≥ arrival_last)** → trip hilang dari set aktif (tidak lagi ditampilkan).
- **Trip belum mulai (t < departure_first)** → `not_started` (tidak ditampilkan atau status khusus).
- **Float drift** → clamp waktu shape point ke waktu resmi GTFS di stop (pola fastgtfs).
- **Clock skew klien** → klien pakai `server_time` dari snapshot untuk animasi, bukan logika.

## Testing Plan
- **pytest backend**: `test_vehicle_positions.py` — posisi pada waktu tetap = koordinat konstan; gerakan monoton sepanjang cum_dist; speed=0 saat dwell; trip kemarin-pukul-24:xx masih aktif jam 00:xx; `t < dep_first` → not_started; `t ≥ arr_last` → trip hilang; feed hilang → unavailable; shape kosong → estimated.
- **pytest endpoint**: `GET /api/vehicle-positions` → 200 source:"scheduled" dengan feed mock; feed None → unavailable; tidak ada trip → outside_service_hours.
- **Frontend**: `npm run check` exit 0; marker animasi rAF; poll interval benar.

## Risiko & Mitigasi
- **Jadwal GTFS TransJakarta mungkin tidak akurat real-time** → mitigasi: label "simulasi jadwal" jelas; ini demo deterministik, bukan klaim realtime.
- **Timezone salah** → mitigasi: satu fungsi `now_service_time` (server UTC → WIB); test timezone.
- **Performance banyak trip** → mitigasi: precompute geometri per trip sekali; binary search per request (trivial).
- **Feed reload** → mitigasi: cache geometry di-binding ke objek feed (rebuild saat feed berubah di lifespan).

## Referensi
- fastgtfs realtime_position.rs: https://github.com/nicomazz/fastgtfs/blob/f77cd57f334d094ee84fa0a2bbe00e30a330b134/src/realtime_position.rs
- Mapbox animate-point-along-line: https://docs.mapbox.com/mapbox-gl-js/example/animate-point-along-line/
- Mapbox blog lerp: https://www.mapbox.com/blog/building-cinematic-route-animations-with-mapboxgl
- Transitland departures: https://www.transit.land/documentation/rest-api/departures
- GTFS reference: https://gtfs.org/documentation/schedule/reference/
- Existing: `backend/gtfs_loader.py` (GtfsFeed, service_active_on), `backend/planner.py` (_parse_time, _active_trips_by_route, haversine), `backend/api/routers/realtime.py` (`/api/buses`), `frontend/src/MapboxMap.tsx`
