-- =====================================================================
-- Transense — PostgreSQL Schema
-- =====================================================================
-- Engine   : PostgreSQL (psycopg3, tanpa ORM)
-- Pemakai  : backend/persistence.py (class PostgresStore)
--           Dipilih saat env DATABASE_URL (postgresql://...) diset;
--           tanpa DATABASE_URL backend tetap memakai SQLite (DemoStore).
-- Version  : schema tunggal, tidak ada migration table.
-- =====================================================================

CREATE TABLE IF NOT EXISTS demo_records (
    id          TEXT PRIMARY KEY,      -- ID unik (uuid atau slug seed)
    record_type TEXT NOT NULL,         -- 'incident' | 'transcript' | 'conversation'
    payload     TEXT NOT NULL,         -- JSON string, struktur sesuai record_type
    created_at  TEXT NOT NULL,         -- ISO-8601 UTC ("...Z")
    pinned      BOOLEAN NOT NULL DEFAULT FALSE  -- FALSE = ikut cleanup 7 hari, TRUE = dikecualikan
);
