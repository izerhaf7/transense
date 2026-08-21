# Transense — Backend API Contract

> Source of truth untuk kontrak HTTP + WebSocket backend Transense.
> Base URL default: `http://localhost:8000` (via `VITE_API_BASE_URL`).

## Struktur kode

Backend diorganisir per lapisan (rewrite struktur `rewrite-backend`):

- `backend/main.py` — app factory `create_app()` + `lifespan`; hanya men-setup state, middleware, dan `include_router` (bukan lagi menampung semua route).
- `backend/api/routers/` — satu `APIRouter` per domain: `health`, `schedule`, `facilities`, `incidents`, `transcripts`, `ai` (scribe-token/tts/vision), `conversations`, `gtfs`, `transit` (kereta), `realtime` (buses/arrivals), `journey` (track/plan), `ws`.
- `backend/api/deps.py` — dependency accessor (`get_store`, `get_settings`, `get_gtfs_feed`, …) via `request.app.state`.
- `backend/api/utils.py` — helper murni (haversine, lookup GTFS, timetable, ETA enrich, OCR extract).
- `backend/` root — lapisan domain/inti yang dipertahankan: `config.py` (Settings), `transit.py`/`notifications.py`/`planner.py` (logika bisnis), `persistence.py`/`conversation.py`/`transcription.py` (data + domain), `gtfs_loader.py`/`tj_api.py`/`commute.py`/`sources.py`/`facilities.py`/`walk_graph.py` (feed & integrasi eksternal).

Semua endpoint tetap `response_model=None` dengan body `dict` polos — kontrak respons di bawah tidak berubah oleh refactor.

Konvensi umum:

- Semua respons `Content-Type: application/json` kecuali `POST /api/tts` (`audio/mpeg`).
- Error HTTP memakai body `{"detail": "..."}` (default FastAPI).
- Field `source` menandakan asal data: `"seed"` (simulasi deterministik), `"gtfs"` (feed TransJakarta asli), `"realtime"` (TJ realtime client), `"commute"` (Commute Data Platform kereta), `"unavailable"`/`"error"` (degradasi). Degradasi bersifat graceful: endpoint realtime mengembalikan `source: "unavailable"` (HTTP 200) alih-alih error saat client/feed hilang.
- Timestamp selalu ISO-8601 UTC dengan suffix `Z`.

## Ringkasan Endpoint

| Metode | Path | Fungsi | Router |
|---|---|---|---|
| GET | `/api/health` | Status kesehatan + konfigurasi | `health` |
| GET | `/api/schedule` | Jadwal statis (seed / Commute TJ) | `schedule` |
| GET | `/api/facilities/stops` | Daftar halte ikonik + fasilitas | `facilities` |
| GET | `/api/facilities/stops/{stop_id}` | Detail fasilitas satu halte | `facilities` |
| GET | `/api/facilities/stops/{stop_id}/occupancy` | Okupansi halte (daksa) | `facilities` |
| GET | `/api/incidents` | Riwayat insiden | `incidents` |
| PATCH | `/api/incidents/{record_id}/pin` | Pin/unpin insiden | `incidents` |
| GET | `/api/transcripts` | Riwayat transkrip | `transcripts` |
| PATCH | `/api/transcripts/{record_id}/pin` | Pin/unpin transkrip | `transcripts` |
| GET | `/api/scribe-token` | Token ElevenLabs scribe (STT) | `ai` |
| POST | `/api/tts` | Sintesis suara (netra) | `ai` |
| POST | `/api/vision/ocr` | OCR proxy Google Vision (netra) | `ai` |
| GET | `/api/conversations` | Daftar percakapan | `conversations` |
| POST | `/api/conversations` | Buat percakapan | `conversations` |
| PATCH | `/api/conversations/{record_id}` | Ubah percakapan | `conversations` |
| DELETE | `/api/conversations/{record_id}` | Hapus percakapan | `conversations` |
| GET | `/api/gtfs/status` | Status feed GTFS | `gtfs` |
| GET | `/api/gtfs/stops` | Semua halte GTFS | `gtfs` |
| GET | `/api/gtfs/stops/search` | Cari halte (nama) | `gtfs` |
| GET | `/api/gtfs/stops/nearby` | Halte terdekat koordinat | `gtfs` |
| GET | `/api/gtfs/routes` | Semua rute GTFS | `gtfs` |
| GET | `/api/gtfs/route/{route_id}/stops` | Halte dalam satu rute | `gtfs` |
| GET | `/api/gtfs/route/{route_id}/shape` | Geometri rute | `gtfs` |
| GET | `/api/gtfs/stop/{stop_id}/info` | Info halte + kedatangan | `gtfs` |
| GET | `/api/gtfs/stop/{stop_id}/schedule` | Jadwal + live satu halte | `gtfs` |
| GET | `/api/transit/lines` | Lin kereta (KCI/MRT/LRT) | `transit` |
| GET | `/api/transit/stations` | Stasiun kereta | `transit` |
| GET | `/api/transit/line/{operator}/{code}/stations` | Stasiun dalam satu lin | `transit` |
| GET | `/api/transit/stop/{operator}/{code}/info` | Info stasiun kereta | `transit` |
| GET | `/api/transit/stop/{operator}/{code}/schedule` | Jadwal stasiun kereta | `transit` |
| GET | `/api/transit/lines/geometry` | Geometri lin kereta | `transit` |
| GET | `/api/buses` | Posisi bus realtime | `realtime` |
| GET | `/api/arrivals` | Kedatangan bus di halte | `realtime` |
| GET | `/api/journey/track` | Tracking bus aktif | `journey` |
| GET | `/api/journey/plan` | Rencana perjalanan (RAPTOR) | `journey` |
| WS | `/api/ws` | WebSocket simulasi + transkripsi | `ws` |

## Health & Konfigurasi

### `GET /api/health`

Tanpa parameter. HTTP **503** saat config wajib hilang atau SQLite down.

```json
{
  "status": "healthy",
  "environment": "local",
  "persistence": { "available": true, "detail": "sqlite available" },
  "transit": { "source": "seed", "state_version": 0 }
}
```

Saat tidak sehat (503), ada tambahan:

```json
{ "status": "unhealthy", "configuration": { "missing": ["TRANSENSE_ENVIRONMENT"] } }
```

## Jadwal Statis

### `GET /api/schedule`

```json
{
  "source": "seed",
  "attribution": null,
  "simulated": true,
  "data": {
    "stops": [ { "id": "stop-kp", "name": "Halte Karet" } ],
    "routes": [ { "id": "route-1", "name": "Koridor 1", "stop_ids": ["stop-kp", "stop-bun"] } ],
    "timetables": []
  }
}
```

- `source`: `"seed"` bila `TRANSENSE_COMMUTE_API_URL` kosong/gagal; selain itu URL Commute dengan `attribution: "Commute Data Platform, ODbL-1.0"`.
- `data.stops`: `{id, name}[]`. `data.routes`: `{id, name, stop_ids}[]`.

## Fasilitas (Side-by-Side / Daksa)

### `GET /api/facilities/stops`

```json
{
  "stops": [
    {
      "id": "fac-bundaran-hi",
      "name": "Bundaran HI",
      "lat": -6.1946,
      "lng": 106.8231,
      "facilities": {
        "ramp": true, "lift": true, "toilet_accessible": true,
        "guiding_block": true, "staffed": true, "step_free_access": true
      }
    }
  ],
  "source": "facility-seed"
}
```

### `GET /api/facilities/stops/{stop_id}`

```json
{ "stop": { "id": "...", "name": "...", "lat": 0, "lng": 0, "facilities": {} }, "source": "facility-seed" }
```

**404** saat `stop_id` tidak dikenal.

### `GET /api/facilities/stops/{stop_id}/occupancy`

```json
{
  "occupancy": "low",
  "wheelchair_spots_available": 3,
  "updated_at": "2026-08-16T12:00:00Z",
  "source": "facility-seed"
}
```

- `occupancy`: `"low" | "moderate" | "high"` (deterministik per menit).
- `wheelchair_spots_available`: integer `0..5`.

## Insiden

### `GET /api/incidents`

```json
{
  "records": [
    {
      "id": "seed-incident-demo-delay-01",
      "record_type": "incident",
      "payload": {
        "status": "delay", "cause": "...", "action": "...", "instruction": "...",
        "route_id": "1", "updated_at": "...", "created_at": "..."
      },
      "created_at": "2026-08-16T12:00:00Z",
      "pinned": false
    }
  ],
  "retention_days": 7
}
```

- `records` kosong bila store tidak tersedia. `payload.status`: `"delay"`, `"diverted"`, `"normal"`, atau `"resolved"`.

### `PATCH /api/incidents/{record_id}/pin`

Body: `{ "pinned": boolean }`. **422** bila `pinned` bukan boolean, **404** bila record tidak ditemukan.

```json
{ "id": "seed-incident-demo-delay-01", "pinned": true }
```

## Transkrip

### `GET /api/transcripts`

```json
{
  "records": [
    {
      "id": "transcript-<session>",
      "record_type": "transcript",
      "payload": { "text": "...", "session_id": "...", "provider": "mock", "mode": "live", "functional": true },
      "created_at": "2026-08-16T12:00:00Z",
      "pinned": false
    }
  ],
  "retention_days": 7
}
```

### `PATCH /api/transcripts/{record_id}/pin`

Sama seperti pin insiden: body `{ "pinned": boolean }`, **422**/**404** bila salah.

## STT / TTS / Vision (profil Netra)

### `GET /api/scribe-token`

- **503** bila `ELEVENLABS_API_KEY` kosong. **502** bila pembuatan token gagal.

```json
{ "token": "<single-use-token>" }
```

### `POST /api/tts`

Body: `{ "text": "...", "model_id": "eleven_multilingual_v2" }` (`model_id` opsional).

- **422** bila `text` kosong atau > 5000 karakter.
- **503** bila `ELEVENLABS_API_KEY` / `ELEVENLABS_TTS_VOICE_ID` kosong.
- **502** bila panggilan ElevenLabs gagal.

Respons sukses: `Content-Type: audio/mpeg` (body biner MP3, bukan JSON).

### `POST /api/vision/ocr`

Body: `{ "image_base64": "<base64 JPEG/PNG>" }`.

- **422** bila `image_base64` kosong atau > 5,000,000 karakter.
- **503** bila `GOOGLE_VISION_API_KEY` kosong. **502** bila panggilan Vision gagal.

```json
{ "text": "koridor 1", "source": "google-cloud-vision" }
```

`text` bisa string kosong (hasil deteksi valid yang tidak menemukan teks).

## Percakapan

### `GET /api/conversations`

```json
{
  "conversations": [
    {
      "id": "conv-<uuid>",
      "title": "Percakapan",
      "messages": [
        { "id": "msg-<uuid>", "sender": "user", "text": "...", "timestamp": "2026-08-16T12:00:00Z", "source": "typed" }
      ],
      "created_at": "2026-08-16T12:00:00Z",
      "updated_at": "2026-08-16T12:00:00Z"
    }
  ],
  "retention_days": 7
}
```

### `POST /api/conversations`

Body: `{ "title"?: string, "messages": [{ "sender": "user"|"other", "text": string, "source"?: "typed"|"stt", "id"?: string, "timestamp"?: string }] }`.

- **422** bila validasi pesan gagal (sender/source/text). **503** bila store tidak tersedia.

```json
{ "id": "conv-<uuid>", "title": "...", "messages": [], "created_at": "...", "updated_at": "..." }
```

### `PATCH /api/conversations/{record_id}`

Body sama dengan POST. **422** validasi, **404** tidak ditemukan.

### `DELETE /api/conversations/{record_id}`

**404** bila tidak ditemukan.

```json
{ "id": "conv-<uuid>", "deleted": true }
```

## GTFS (TransJakarta)

### `GET /api/gtfs/status`

```json
{
  "loaded": true,
  "stops": 8091, "routes": 240, "trips": 700, "shapes": 700,
  "source": "https://ppid.transjakarta.co.id/informasi/berkala/gtfs"
}
```

Bila feed gagal dimuat: `{ "loaded": false, "error": "..." }`.

### `GET /api/gtfs/stops`

```json
{
  "stops": [
    {
      "id": "H00273P", "name": "Jakarta International Stadium",
      "lat": -6.126689, "lng": 106.85587,
      "location_type": "1", "parent_station": null,
      "platform_code": "", "wheelchair_boarding": "2"
    }
  ],
  "source": "gtfs"
}
```

- `location_type`: `"0"` (halte/platform) atau `"1"` (stasiun).
- `wheelchair_boarding`: `"0"`/`"1"`/`"2"` (tidak tersedia/tersedia/tidak diketahui).
- Degradasi feed hilang: `{ "stops": [], "source": "seed" }`.

### `GET /api/gtfs/stops/search?q=<query>`

```json
{
  "stops": [
    { "id": "H00273P", "name": "...", "lat": 0, "lng": 0, "type": "BRT Station", "wheelchair_boarding": "2" }
  ],
  "source": "gtfs"
}
```

- `q` wajib; kosong → `{ "stops": [], "source": "gtfs" }`.
- Hasil maksimal 20, dedup per nama (prioritas `location_type == "1"`).
- `type`: `"BRT Station"` atau `"Bus Stop"`.

### `GET /api/gtfs/stops/nearby?lat=<lat>&lng=<lng>&limit=<n>`

```json
{
  "stops": [
    { "id": "...", "name": "...", "lat": 0, "lng": 0, "distance_km": 0.1234 }
  ],
  "source": "gtfs"
}
```

- `lat`, `lng` wajib (float). `limit` default 5, dibatasi `1..20`.
- Diurutkan ascending `distance_km`.

### `GET /api/gtfs/routes`

```json
{
  "routes": [
    { "id": "1", "name": "1", "long_name": "...", "color": "#D62126", "stop_ids": ["..."] }
  ],
  "source": "gtfs"
}
```

### `GET /api/gtfs/route/{route_id}/stops`

**503** feed hilang, **404** route tidak dikenal.

```json
{
  "stops": [ { "id": "H00273P", "name": "...", "lat": 0, "lng": 0 } ],
  "source": "gtfs"
}
```

### `GET /api/gtfs/route/{route_id}/shape`

**503** feed hilang, **404** route tanpa shape.

```json
{
  "coordinates": [[106.85, -6.12]],
  "lines": [[[106.85, -6.12]]],
  "source": "gtfs"
}
```

`coordinates` = `lines[0]` (dedup geometri). Koordinat `[lng, lat]` (GeoJSON).

### `GET /api/gtfs/stop/{stop_id}/info`

**503** feed hilang, **404** halte tidak dikenal.

```json
{
  "stop": {
    "id": "...", "name": "...", "lat": 0, "lng": 0,
    "location_type": "1", "parent_station": null,
    "platform_code": "", "wheelchair_boarding": "2"
  },
  "routes": [ { "route_code": "14", "color": "#F5AB6E" } ],
  "arrivals": [ { "bus_id": "DMR-240198", "route_code": "14", "eta_minutes": 0 } ],
  "source": "gtfs"
}
```

`arrivals` kosong saat realtime client tidak tersedia.

### `GET /api/gtfs/stop/{stop_id}/schedule`

**503** feed hilang, **404** halte tidak dikenal.

```json
{
  "stop": { "id": "...", "name": "...", "lat": 0, "lng": 0, "wheelchair_boarding": "2" },
  "timetable": [
    { "route_code": "1", "color": "#D62126", "headsign": "Blok M", "direction": "0", "times": ["05:10", "05:25"] }
  ],
  "live": [
    { "bus_id": "...", "route_code": "1", "eta_minutes": 5, "headsign": "Blok M" }
  ],
  "source": "gtfs"
}
```

## Transit Kereta (KCI / MRT / LRT)

Semua endpoint `/api/transit/*` memakai `CommuteFeed` (`backend/commute.py`). Saat feed hilang: endpoint list mengembalikan `source: "unavailable"` + list kosong (HTTP 200); endpoint detail mengembalikan **503**.

### `GET /api/transit/lines`

```json
{
  "lines": [
    { "operator": "KCI", "operator_name": "...", "code": "BOGOR", "name": "...", "color": "#...", "mode": "RAIL", "mode_label": "KRL" }
  ],
  "source": "commute"
}
```

### `GET /api/transit/stations`

```json
{
  "stations": [
    { "id": "KCI-...", "operator": "KCI", "code": "...", "name": "...", "lat": 0, "lng": 0, "lines": ["..."] }
  ],
  "source": "commute"
}
```

### `GET /api/transit/line/{operator}/{code}/stations`

**503** feed hilang, **404** lin tidak dikenal.

```json
{
  "line": "BOGOR", "name": "...", "color": "#...",
  "stations": [ { "id": "...", "code": "...", "name": "...", "lat": 0, "lng": 0 } ],
  "source": "commute"
}
```

### `GET /api/transit/stop/{operator}/{code}/info`

**503** feed hilang, **404** stasiun tidak dikenal.

```json
{
  "stop": {
    "id": "KCI-...", "name": "...", "operator": "KCI", "official_name": "...",
    "lines": ["..."],
    "amenities": [ { "type": "lift", "label": "Lift", "text": "..." } ]
  },
  "source": "commute"
}
```

### `GET /api/transit/stop/{operator}/{code}/schedule`

**503** feed hilang, **404** stasiun tidak dikenal.

```json
{
  "stop": { "id": "...", "name": "...", "operator": "...", "official_name": "...", "lines": [], "amenities": [] },
  "timetable": [
    { "route_code": "BOGOR", "color": "#...", "headsign": "...", "direction": "...", "platform": "...", "times": ["05:00"] }
  ],
  "source": "commute"
}
```

### `GET /api/transit/lines/geometry`

```json
{
  "lines": [
    {
      "operator": "KCI", "code": "BOGOR", "name": "...", "color": "#...",
      "mode_label": "KRL", "segments": [[[106.85, -6.12]]], "source": "ritj-2021"
    }
  ],
  "source": "commute"
}
```

- `segments`: MultiLineString `[number,number][][]` (GeoJSON `[lng,lat]`).
- `source` per lin: `"ritj-2021"` bila ada geometri RITJ, selain itu `"commute"`.

## Realtime Bus

### `GET /api/buses`

```json
{
  "buses": [
    {
      "id": "DMR-240198", "route_code": "14", "lat": 0, "lng": 0,
      "observed_at": "2026-08-16T12:00:00Z",
      "next_stop": { "name": "...", "sequence": 3 }
    }
  ],
  "source": "realtime",
  "error": null
}
```

- `source`: `"realtime"` (client aktif), `"unavailable"` (client tidak aktif, `buses` mungkin memuat cache terakhir), `"error"` (exception, `buses: []`).

### `GET /api/arrivals?stop_id=<id>` atau `?lat=<lat>&lng=<lng>`

```json
{
  "arrivals": [
    { "bus_id": "...", "route_code": "1", "headsign": "Blok M", "eta_minutes": 5, "distance_km": 1.5 }
  ],
  "stop": { "id": "...", "name": "...", "lat": 0, "lng": 0 },
  "source": "realtime"
}
```

- Wajib `stop_id` ATAU `lat`+`lng`. Maks 20 hasil, ascending `eta_minutes`.
- `source`: `"realtime"` / `"unavailable"` / `"error"` (dengan `error` string).

## Perjalanan (Journey)

### `GET /api/journey/track`

Parameter: `vehicle_id?`, `target_stop_id?`, `user_lat?`, `user_lng?`.

Status `status` yang mungkin: `"unavailable"`, `"not_found"`, `"not_on_route"`, `"arrived"`, `"approaching"`, `"en_route"`.

Sukses (dengan bus aktif):

```json
{
  "status": "approaching",
  "vehicle": { "id": "...", "route_code": "1", "lat": 0, "lng": 0, "observed_at": "..." },
  "route": { "id": "1", "name": "1", "headsign": "Blok M", "stops": [ { "id": "...", "name": "...", "lat": 0, "lng": 0 } ] },
  "target_stop": { "id": "...", "name": "...", "lat": 0, "lng": 0 },
  "next_stop": { "name": "...", "sequence": 3 },
  "eta_minutes": 3
}
```

Degradasi (HTTP 200, bukan error):

```json
{ "status": "unavailable", "error": "realtime bus tracking disabled" }
```

### `GET /api/journey/plan`

Parameter:

- Titik asal/tujuan: `from_stop`+`to_stop` ATAU `from_lat`+`from_lng`+`to_lat`+`to_lng`.
- Waktu: `date` (`YYYY-MM-DD`, default hari ini Asia/Jakarta), `time` (`HH:MM`), `arrive_by` (`HH:MM`, menang atas `time` bila keduanya dikirim).
- `include_eta` (boolean): annotate ETA tiap leg BUS.

Sukses:

```json
{
  "itineraries": [
    {
      "legs": [
        {
          "mode": "WALK",
          "from": { "stop_id": "H00273P", "name": "...", "lat": 0, "lng": 0 },
          "to": { "stop_id": "B05892P", "name": "...", "lat": 0, "lng": 0 },
          "duration_minutes": 1,
          "distance_m": 69.4,
          "start_time": "10:00",
          "end_time": "10:00",
          "walk_estimate": true
        },
        {
          "mode": "BUS",
          "from": { "stop_id": "B05892P", "name": "...", "lat": 0, "lng": 0 },
          "to": { "stop_id": "B01835P", "name": "...", "lat": 0, "lng": 0 },
          "duration_minutes": 11,
          "distance_m": 2220.0,
          "start_time": "10:12",
          "end_time": "10:23",
          "route": { "id": "BW4", "short_name": "BW4", "color": "FFB6DB" },
          "headsign": "Pencakar Langit",
          "trip_id": "BW4-L01",
          "delay_minutes": 14,
          "live_eta_minutes": 25,
          "eta_source": "realtime"
        }
      ],
      "transfers": 0,
      "walk_distance_m": 153.3,
      "walk_minutes": 2,
      "waiting_minutes": 11,
      "total_minutes": 24
    }
  ],
  "source": "gtfs",
  "incidents": [
    {
      "id": "...",
      "status": "delay",
      "cause": "...",
      "action": "...",
      "instruction": "...",
      "route_id": "1",
      "updated_at": "...",
      "affects_route": true
    }
  ]
}
```

- Leg `mode`: `"WALK"` atau `"BUS"`. `route` ada hanya untuk leg BUS.
- `delay_minutes` / `live_eta_minutes` / `eta_source` ada hanya saat `include_eta=true` dan leg BUS punya `route.id` + `from.stop_id`.
- `eta_source`: `"simulated"` (realtime client tidak aktif) atau `"realtime"`.
- `incidents`: hanya insiden aktif (`delay`/`diverted`); `affects_route: true` bila route cocok dengan itinerary.
- Degradasi: `{"itineraries": [], "source": "unavailable", "incidents": []}` (HTTP 200) saat feed GTFS/walk graph belum dimuat. **422** untuk origin/destination/date/time invalid.

## WebSocket `/api/ws`

- Origin header wajib cocok dengan `TRANSENSE_ALLOWED_ORIGINS`; jika tidak, koneksi ditutup dengan close code **1008** sebelum `accept()`.
- Frame pertama selalu: `{"type":"connection.ack","protocol":"transit-demo.v1","state":<seed snapshot>}`.

### State snapshot (`TransitState`)

```json
{
  "stops": [ { "id": "stop-kp", "name": "Halte Karet" } ],
  "routes": [ { "id": "route-1", "name": "Koridor 1", "stop_ids": ["stop-kp", "stop-bun"] } ],
  "trips": [ { "id": "trip-1", "route_id": "route-1", "vehicle_id": "vehicle-kp-01" } ],
  "vehicles": [ { "id": "vehicle-kp-01", "trip_id": "trip-1", "position": "stop-kp", "eta_minutes": 4 } ],
  "etas": [ { "id": "eta-vehicle-kp-01", "vehicle_id": "vehicle-kp-01", "stop_id": "stop-bun", "minutes": 4 } ],
  "incidents": [ { "id": "incident-demo-01", "route_id": "route-1", "status": "normal", "message": "Layanan berjalan normal" } ]
}
```

### Inbound messages (`{ "type": ... }`)

| Type | Payload | Outbound |
|---|---|---|
| `transit.update` | `vehicle_id` | `transit.update` event + notifikasi terkait |
| `transit.reset` | — | `transit.reset` |
| `journey.subscribe` / `journey.start` | `vehicle_id`, `route_id`, `origin_stop_id`, `destination_stop_id` | `journey.subscribed` |
| `incident.update` | `route_id`, `incident_id?`, `stage` (0/1/2) | `notification.incident` |
| `journey.off_route` | `action` (`trigger`/`resolve`) | `journey.off_route` |
| `transcription.session.start` | `session_id`, `source: "conversation_microphone"` | `transcription.session.started` |
| `transcription.session.stop` | `session_id` | `transcription.result` |
| `transcription.save` | `session_id`, `text` | `transcription.result` |
| `ramp.request` | `stop_id` | `ramp.request.ack` |

### Outbound penting

`transit.update`:

```json
{
  "type": "transit.update",
  "event_id": "event-0001",
  "vehicle_id": "vehicle-kp-01",
  "eta_minutes": 3,
  "position": "stop-kp",
  "occurred_at": "2026-08-16T12:00:00Z",
  "state_version": 1
}
```

`notification.vehicle_approaching` / `notification.destination_approaching`:

```json
{
  "type": "notification.vehicle_approaching",
  "event_id": "vehicle_approaching-vehicle-kp-01-1",
  "vehicle_id": "vehicle-kp-01",
  "route_id": "route-1",
  "stop_id": "stop-bun",
  "eta_minutes": 2,
  "occurred_at": "2026-08-16T12:00:00Z",
  "vibration_pattern": [200, 100, 200],
  "simulated": true
}
```

`transcription.result`:

```json
{
  "type": "transcription.result",
  "id": "transcript-<session>",
  "session_id": "...",
  "text": "...",
  "created_at": "2026-08-16T12:00:00Z",
  "provider": "mock",
  "mode": "live",
  "functional": true
}
```

`ramp.request.ack`:

```json
{
  "type": "ramp.request.ack",
  "stop_id": "fac-bundaran-hi",
  "status": "received",
  "occurred_at": "2026-08-16T12:00:00Z"
}
```

### Error envelope

```json
{ "type": "error", "code": "invalid_transit_reference", "message": "..." }
```

Kode `code` yang mungkin:

- `invalid_json` — payload bukan JSON.
- `invalid_transit_reference` — referensi transit tidak valid (TransitValidationError/TypeError/AttributeError).
- `invalid_request` — error transkripsi (mis. session tidak aktif, raw audio ditolak).
- `invalid_stop_reference` — `stop_id` fasilitas tidak dikenal (ramp.request).
- `unknown_message` — type pesan tidak dikenali.
- `provider_configuration` — provider STT tidak terkonfigurasi (via `transcription.session.error`).
