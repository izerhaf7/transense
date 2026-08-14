-- =====================================================================
-- Transense — Database Schema
-- =====================================================================
-- Engine   : SQLite (sqlite3 native, tanpa ORM)
-- File     : backend/transense.sqlite3 (path diatur via
--            env TRANSENSE_DATABASE_PATH, default: backend/transense.sqlite3)
-- Pemakai  : backend/persistence.py (class DemoStore)
-- Version  : schema tunggal, tidak ada migration table.
-- =====================================================================
--
-- CATATAN PENTING
-- --------------
-- Seluruh aplikasi memakai SATU tabel generik. Tidak ada relasi antar
-- tabel, tidak ada foreign key. Setiap baris menyimpan "payload" berupa
-- JSON string yang strukturnya ditentukan oleh kolom `record_type`.
--
-- Nilai `record_type` yang valid saat ini:
--   1. 'incident'    -> feed insiden/keterlambatan (demo/simulasi)
--   2. 'transcript'  -> hasil transkripsi percakapan (STT)
--   3. 'conversation'-> percakapan chat dua arah (user vs lawan bicara)
--
-- RETENSI 7 HARI
-- --------------
-- Record dengan `pinned = 0` dan `created_at` lebih tua dari 7 hari akan
-- DIHAPUS otomatis oleh method DemoStore.cleanup(). Record yang di-pin
-- (`pinned = 1`) dikecualikan dari cleanup dan bertahan selamanya.
--
-- TIMESTAMP
-- ---------
-- `created_at` disimpan sebagai ISO-8601 UTC dengan akhiran "Z",
-- contoh: "2026-08-11T15:10:54.578039Z". Timestamp tanpa timezone
-- akan ditolak (TimestampValidationError).
-- =====================================================================

CREATE TABLE IF NOT EXISTS demo_records (
    id          TEXT PRIMARY KEY,      -- ID unik (uuid atau slug seed)
    record_type TEXT NOT NULL,         -- 'incident' | 'transcript' | 'conversation'
    payload     TEXT NOT NULL,         -- JSON string, struktur sesuai record_type
    created_at  TEXT NOT NULL,         -- ISO-8601 UTC ("...Z")
    pinned      INTEGER NOT NULL DEFAULT 0  -- 0 = ikut cleanup 7 hari, 1 = dikecualikan
);

-- =====================================================================
-- STRUKTUR PAYLOAD per record_type
-- =====================================================================
--
-- 1. incident
-- {
--   "id": "incident-demo-01",
--   "route_id": "route-1",
--   "status": "normal",           // normal | delay | diverted | resolved
--   "message": "Layanan berjalan normal",
--   "cause": "...",               // penyebab (KAI Commuter style)
--   "action": "...",              // tindakan yang diambil
--   "instruction": "...",         // instruksi ke pengguna
--   "updated_at": "...",
--   "simulated": true
-- }
--
-- 2. transcript
-- {
--   "text": "Halo, ini transkrip demo percakapan.",
--   "session_id": "transcription-session-...",
--   "provider": "mock",           // mock | live | elevenlabs_scribe
--   "mode": "mock",               // mock | live
--   "functional": true
-- }
--
-- 3. conversation
-- {
--   "title": "Judul percakapan",
--   "messages": [
--     {
--       "id": "msg-...",
--       "sender": "user",         // user (Tuli) | other (lawan bicara)
--       "text": "isi pesan",
--       "timestamp": "2026-08-12T18:41:15.651Z",
--       "source": "typed"         // typed | stt
--     }
--   ],
--   "created_at": "...",
--   "updated_at": "..."
-- }
-- =====================================================================
