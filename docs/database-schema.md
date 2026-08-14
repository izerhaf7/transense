# Database Schema — Transense

Dokumen ini menjelaskan struktur database Transense agar developer yang baru
clone repo langsung paham konteksnya. Schema SQL lengkap ada di
[`backend/schema.sql`](../backend/schema.sql).

## Ringkasan

Transense pakai **SQLite** (`sqlite3` native Python, tanpa ORM). Semua data
disimpan dalam **satu tabel** bernama `demo_records`. Tidak ada relasi antar
tabel, tidak ada foreign key, tidak ada tabel migration.

| Item | Nilai |
|---|---|
| Engine | SQLite |
| File DB | `backend/transense.sqlite3` |
| Konfigurasi path | env `TRANSENSE_DATABASE_PATH` (default: `backend/transense.sqlite3`) |
| Akses kode | `backend/persistence.py` → class `DemoStore` |
| Jumlah tabel | 1 (`demo_records`) |
| ORM | Tidak ada (query manual via `sqlite3`) |

## Tabel `demo_records`

```sql
CREATE TABLE IF NOT EXISTS demo_records (
    id          TEXT PRIMARY KEY,
    record_type TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    pinned      INTEGER NOT NULL DEFAULT 0
);
```

### Penjelasan kolom

| Kolom | Tipe | Keterangan |
|---|---|---|
| `id` | TEXT (PK) | ID unik. Bisa UUID (`conv-...`, `transcript-...`) atau slug seed (`seed-incident-demo-01`). |
| `record_type` | TEXT | Jenis record. Hanya 3 nilai valid (lihat bawah). |
| `payload` | TEXT | JSON string. Strukturnya berbeda-beda tergantung `record_type`. |
| `created_at` | TEXT | Timestamp ISO-8601 UTC, berakhiran `Z`. Contoh: `2026-08-11T15:10:54.578039Z`. |
| `pinned` | INTEGER | `0` = ikut cleanup 7 hari, `1` = dikecualikan (bertahan selamanya). |

## Nilai `record_type`

Ada 3 jenis record. Tiap jenis punya struktur `payload` sendiri.

### 1. `incident` — feed insiden / keterlambatan

Menyimpan notifikasi resmi keterlambatan/insiden (format terstruktur ala KAI
Commuter Line: status, penyebab, tindakan, instruksi).

```json
{
  "id": "incident-demo-01",
  "route_id": "route-1",
  "status": "normal",
  "message": "Layanan berjalan normal",
  "cause": "Tidak ada gangguan pada simulasi seed.",
  "action": "Layanan berjalan sesuai skenario demo.",
  "instruction": "Tetap lihat pembaruan visual di aplikasi.",
  "updated_at": "2026-08-11T15:10:54.578039Z",
  "simulated": true
}
```

- `status`: `normal` | `delay` | `diverted` | `resolved`
- Ditulis saat seed (startup) dan saat event insiden masuk via WebSocket.

### 2. `transcript` — hasil transkripsi (STT)

Menyimpan hasil transkripsi percakapan orang (bukan pengumuman PA). Hanya teks
fungsional yang disimpan; audio mentah / ambient noise tidak pernah masuk.

```json
{
  "text": "Halo, ini transkrip demo percakapan.",
  "session_id": "transcription-session-1786461573015",
  "provider": "mock",
  "mode": "mock",
  "functional": true
}
```

- `provider`: `mock` | `live` | `elevenlabs_scribe`
- `mode`: `mock` | `live`

### 3. `conversation` — percakapan chat dua arah

Menyimpan percakapan chat antara pengguna (Tuli) dan lawan bicara, dua arah.

```json
{
  "title": "Memang seperti itu cara bermainnya.",
  "messages": [
    {
      "id": "msg-1786560790985-sedaxh",
      "sender": "other",
      "text": "Memang seperti itu cara bermainnya.",
      "timestamp": "2026-08-12T18:53:10.985Z",
      "source": "stt"
    },
    {
      "id": "msg-1786560795080-i4i5qq",
      "sender": "user",
      "text": "benar",
      "timestamp": "2026-08-12T18:53:15.080Z",
      "source": "typed"
    }
  ],
  "created_at": "2026-08-12T18:53:10.988952Z",
  "updated_at": "2026-08-12T18:53:19.692653Z"
}
```

- `sender`: `user` (pengguna Tuli) | `other` (lawan bicara)
- `source`: `typed` (diketik) | `stt` (hasil speech-to-text)

## Retensi 7 hari & pin

- Method `DemoStore.cleanup()` menghapus record dengan `pinned = 0` yang
  `created_at`-nya lebih tua dari 7 hari.
- Record dengan `pinned = 1` dikecualikan dan bertahan selamanya.
- Cleanup dipanggil saat startup dan sebelum list `transcript`/`incident`.
- Batas 7 hari bersifat **exact** (test memastikan record hari ke-7 masih ada).

## Cara akses (API)

| Endpoint | record_type | Operasi |
|---|---|---|
| `GET /api/incidents` | incident | List |
| `PATCH /api/incidents/{id}/pin` | incident | Pin/unpin |
| `GET /api/transcripts` | transcript | List (terbaru dulu) |
| `PATCH /api/transcripts/{id}/pin` | transcript | Pin/unpin |
| `GET /api/conversations` | conversation | List |
| `POST /api/conversations` | conversation | Buat |
| `PATCH /api/conversations/{id}` | conversation | Update (append pesan) |
| `DELETE /api/conversations/{id}` | conversation | Hapus |

## Kode terkait

- `backend/persistence.py` — `DemoStore` (semua query DB)
- `backend/conversation.py` — validasi & CRUD conversation
- `backend/transcription.py` — persist & history transcript
- `backend/main.py` — endpoint REST + seed incident

## Catatan

- Database bersifat **ephemeral** di Google Cloud Run (disk lokal bisa hilang
  saat instance restart). Fallback seed/replay tersedia untuk recovery.
- File `backend/transense.sqlite3` dan `backend/gtfs_cache.zip` bersifat
  **gitignored** — tidak pernah di-commit ke repo.
- Tidak ada data produksi; semua record saat ini adalah data demo/simulasi.
