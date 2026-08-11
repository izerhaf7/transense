from datetime import datetime, timedelta, timezone

import pytest

from backend.persistence import DemoStore, TimestampValidationError


def test_cleanup_keeps_exact_boundary_and_deletes_older(tmp_path):
    store = DemoStore(tmp_path / "demo.sqlite3")
    now = datetime(2026, 8, 11, 12, tzinfo=timezone.utc)
    store.add("transcript", {"text": "boundary"}, now - timedelta(days=7), record_id="boundary")
    store.add("transcript", {"text": "old"}, now - timedelta(days=7, seconds=1), record_id="old")
    assert store.cleanup(now) == 1
    assert [record["id"] for record in store.list_records()] == ["boundary"]
    store.close()


def test_pinned_old_record_survives_until_unpinned(tmp_path):
    store = DemoStore(tmp_path / "demo.sqlite3")
    now = datetime(2026, 8, 11, 12, tzinfo=timezone.utc)
    store.add("incident", {"status": "saved"}, now - timedelta(days=8), pinned=True, record_id="saved")
    assert store.cleanup(now) == 0
    store.set_pinned("saved", False)
    assert store.cleanup(now) == 1
    assert store.list_records() == []
    store.close()


def test_timestamp_requires_timezone(tmp_path):
    store = DemoStore(tmp_path / "demo.sqlite3")
    with pytest.raises(TimestampValidationError):
        store.add("transcript", {}, datetime(2026, 8, 11))
    store.close()


def test_incident_retention_uses_shared_cleanup_and_pinned_exemption(tmp_path):
    store = DemoStore(tmp_path / "demo.sqlite3")
    now = datetime(2026, 8, 11, 12, tzinfo=timezone.utc)
    payload = {"status": "delay", "cause": "test", "action": "test", "instruction": "test", "updated_at": now.isoformat().replace("+00:00", "Z")}
    store.add("incident", payload, now - timedelta(days=8), record_id="old-incident")
    store.add("incident", payload, now - timedelta(days=8), pinned=True, record_id="saved-incident")
    assert store.cleanup(now) == 1
    assert [record["id"] for record in store.list_records()] == ["saved-incident"]
    store.set_pinned("saved-incident", False)
    assert store.cleanup(now) == 1
    store.close()
