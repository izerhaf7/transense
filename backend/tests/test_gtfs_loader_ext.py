"""Tests for extended GTFS loading: transfers, calendar, calendar_dates, service_active_on."""

import datetime
import zipfile

from backend.gtfs_loader import (
    GtfsCalendar,
    GtfsTransfer,
    GtfsTrip,
    parse_gtfs,
    service_active_on,
)

MINIMAL_FILES = {
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nS1,A,-6.2,106.8\nS2,B,-6.3,106.9\n",
    "routes.txt": "route_id,route_short_name,route_long_name,route_type\nR1,1,Koridor 1,3\n",
    "trips.txt": "trip_id,route_id,shape_id,direction_id,trip_headsign,service_id\nT1,R1,SH1,0,Terminal,WD\n",
    "stop_times.txt": (
        "trip_id,stop_id,stop_sequence,arrival_time,departure_time\n"
        "T1,S1,1,08:00:00,08:00:00\n"
        "T1,S2,2,08:10:00,08:10:00\n"
    ),
}


def write_zip(tmp_path, extra=None):
    path = tmp_path / "feed.zip"
    with zipfile.ZipFile(path, "w") as zf:
        for name, content in MINIMAL_FILES.items():
            zf.writestr(name, content)
        for name, content in (extra or {}).items():
            zf.writestr(name, content)
    return path


def test_parses_transfers(tmp_path):
    path = write_zip(
        tmp_path,
        {
            "transfers.txt": (
                "from_stop_id,to_stop_id,transfer_type,min_transfer_time\n"
                "S1,S2,2,120\n"
                "S2,S1,3,\n"
            )
        },
    )
    feed = parse_gtfs(path)
    assert feed.transfers[("S1", "S2")] == GtfsTransfer("S1", "S2", "2", 120)
    assert feed.transfers[("S2", "S1")] == GtfsTransfer("S2", "S1", "3", 0)
    assert len(feed.transfers) == 2


def test_transfer_defaults_and_bad_rows_are_skipped(tmp_path):
    path = write_zip(
        tmp_path,
        {
            "transfers.txt": (
                "from_stop_id,to_stop_id,transfer_type,min_transfer_time\n"
                "S1,S2,,abc\n"
                ",S3,0,\n"
                "S3,,0,\n"
            )
        },
    )
    feed = parse_gtfs(path)
    assert feed.transfers[("S1", "S2")] == GtfsTransfer("S1", "S2", "0", 0)
    assert ("", "S3") not in feed.transfers
    assert ("S3", "") not in feed.transfers


def test_parses_calendar_and_calendar_dates(tmp_path):
    path = write_zip(
        tmp_path,
        {
            "calendar.txt": (
                "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
                "WD,1,1,1,1,1,0,0,20240101,20241231\n"
                "WE,0,0,0,0,0,1,1,20240101,20241231\n"
            ),
            "calendar_dates.txt": (
                "service_id,date,exception_type\n"
                "WD,20240501,2\n"
                "HOL,20240501,1\n"
            ),
        },
    )
    feed = parse_gtfs(path)
    assert feed.calendar["WD"] == GtfsCalendar("WD", {0, 1, 2, 3, 4}, "20240101", "20241231")
    assert feed.calendar["WE"].weekdays == {5, 6}
    assert feed.calendar_dates == {"WD": {"20240501": 2}, "HOL": {"20240501": 1}}


def test_service_active_on_weekday_range_and_string_form(tmp_path):
    path = write_zip(
        tmp_path,
        {
            "calendar.txt": (
                "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
                "WD,1,1,1,1,1,0,0,20240101,20241231\n"
            )
        },
    )
    feed = parse_gtfs(path)
    monday = datetime.date(2024, 1, 1)
    sunday = datetime.date(2024, 1, 7)
    assert service_active_on(feed, "WD", monday) is True
    assert service_active_on(feed, "WD", "20240101") is True
    assert service_active_on(feed, "WD", sunday) is False
    assert service_active_on(feed, "WD", datetime.date(2025, 1, 1)) is False
    assert service_active_on(feed, "UNKNOWN", monday) is False


def test_service_active_on_exception_overrides_calendar(tmp_path):
    path = write_zip(
        tmp_path,
        {
            "calendar.txt": (
                "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
                "WD,1,1,1,1,1,0,0,20240101,20241231\n"
            ),
            "calendar_dates.txt": (
                "service_id,date,exception_type\n"
                "WD,20240101,2\n"
                "HOL,20240101,1\n"
            ),
        },
    )
    feed = parse_gtfs(path)
    monday = datetime.date(2024, 1, 1)
    tuesday = datetime.date(2024, 1, 2)
    assert service_active_on(feed, "WD", monday) is False
    assert service_active_on(feed, "WD", tuesday) is True
    assert service_active_on(feed, "HOL", monday) is True
    assert service_active_on(feed, "HOL", tuesday) is False


def test_feed_without_optional_files_still_loads(tmp_path):
    feed = parse_gtfs(write_zip(tmp_path))
    assert feed.stops["S1"].name == "A"
    assert feed.routes["R1"].short_name == "1"
    assert feed.trips["T1"].route_id == "R1"
    assert feed.trips["T1"].service_id == "WD"
    assert feed.transfers == {}
    assert feed.calendar == {}
    assert feed.calendar_dates == {}


def test_trip_service_id_defaults_to_empty_string():
    trip = GtfsTrip(trip_id="t", route_id="r", shape_id=None, direction_id=0, headsign="")
    assert trip.service_id == ""


def test_zip_without_service_id_column_parses_trips(tmp_path):
    files = dict(MINIMAL_FILES)
    files["trips.txt"] = "trip_id,route_id,shape_id,direction_id,trip_headsign\nT1,R1,SH1,0,Terminal\n"
    path = tmp_path / "feed.zip"
    with zipfile.ZipFile(path, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    feed = parse_gtfs(path)
    assert feed.trips["T1"].service_id == ""
