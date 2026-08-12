from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4


class TimestampValidationError(ValueError):
    """Raised when a record timestamp is missing or not timezone-aware UTC."""


def parse_timestamp(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise TimestampValidationError("created_at must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None:
        raise TimestampValidationError("created_at must include a timezone")
    return parsed.astimezone(timezone.utc)


def timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        raise TimestampValidationError("created_at must include a timezone")
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class DemoStore:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.connection = sqlite3.connect(self.path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("""CREATE TABLE IF NOT EXISTS demo_records (
            id TEXT PRIMARY KEY, record_type TEXT NOT NULL, payload TEXT NOT NULL,
            created_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0
        )""")
        self.connection.commit()

    def check_available(self) -> bool:
        self.connection.execute("SELECT 1").fetchone()
        return True

    def close(self) -> None:
        self.connection.close()

    def add(self, record_type: str, payload: dict[str, Any], created_at: datetime, pinned: bool = False, record_id: str | None = None) -> str:
        created = timestamp(created_at)
        record_id = record_id or f"record-{uuid4()}"
        self.connection.execute("INSERT INTO demo_records (id, record_type, payload, created_at, pinned) VALUES (?, ?, ?, ?, ?)", (record_id, record_type, json.dumps(payload), created, int(pinned)))
        self.connection.commit()
        return record_id

    def list_records(self, record_type: str | None = None) -> list[dict[str, Any]]:
        if record_type is None:
            rows = self.connection.execute("SELECT * FROM demo_records ORDER BY created_at").fetchall()
        else:
            rows = self.connection.execute("SELECT * FROM demo_records WHERE record_type = ? ORDER BY created_at", (record_type,)).fetchall()
        return [{"id": row["id"], "record_type": row["record_type"], "payload": json.loads(row["payload"]), "created_at": row["created_at"], "pinned": bool(row["pinned"])} for row in rows]

    def set_pinned(self, record_id: str, pinned: bool) -> bool:
        changed = self.connection.execute("UPDATE demo_records SET pinned = ? WHERE id = ?", (int(pinned), record_id)).rowcount
        self.connection.commit()
        return changed == 1

    def update_record(self, record_id: str, payload: dict[str, Any], created_at: datetime) -> bool:
        created = timestamp(created_at)
        changed = self.connection.execute(
            "UPDATE demo_records SET payload = ?, created_at = ? WHERE id = ?",
            (json.dumps(payload), created, record_id),
        ).rowcount
        self.connection.commit()
        return changed == 1

    def delete_record(self, record_id: str) -> bool:
        changed = self.connection.execute("DELETE FROM demo_records WHERE id = ?", (record_id,)).rowcount
        self.connection.commit()
        return changed == 1

    def cleanup(self, now: datetime) -> int:
        cutoff = now.astimezone(timezone.utc) - timedelta(days=7)
        deleted = self.connection.execute("DELETE FROM demo_records WHERE pinned = 0 AND created_at < ?", (timestamp(cutoff),)).rowcount
        self.connection.commit()
        return deleted
