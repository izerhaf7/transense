import json
from urllib.parse import urlparse

from backend.sources import CommuteDataPlatformAdapter, SourceMappingError, load_static_schedule
from backend.transit import TransitSimulator


def valid_payload():
    return {"stops": [{"id": "stop-a", "name": "A"}], "routes": [{"id": "route-a", "name": "Line A", "stop_ids": ["stop-a"]}], "timetables": [{"route_id": "route-a", "service": "demo"}]}


def test_source_maps_static_entities_with_odbl_attribution():
    result = CommuteDataPlatformAdapter("https://example.test").map_payload(valid_payload())
    assert result.attribution == "Commute Data Platform, ODbL-1.0"
    assert result.data["routes"][0]["id"] == "route-a"


def test_invalid_mapping_and_unconfigured_source_fall_back_to_seed():
    seed = TransitSimulator.create().snapshot()
    fallback = load_static_schedule(seed, None)
    assert fallback.source == "seed"
    try:
        CommuteDataPlatformAdapter("https://example.test").map_payload({})
    except SourceMappingError:
        pass
    else:
        raise AssertionError("invalid mapping was accepted")


def test_source_loads_tj_stations_lines_and_timetables_from_public_api_shape():
    responses = {
        "/stations/TJ": {"data": [{"id": "TJ-A", "name": "Halte A"}]},
        "/operators": {"data": [{"code": "TJ", "lines": [{"lineCode": "1", "name": "Koridor 1"}]}]},
        "/lines/TJ/1": {"data": {"segments": [{"stations": [{"id": "TJ-A", "code": "A", "name": "Halte A"}]}]}},
        "/stations/TJ/A/timetable/1": {"data": [{"id": "schedule-1"}]},
    }

    class FakeResponse:
        def __init__(self, payload):
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def read(self):
            return json.dumps(self.payload).encode()

    def fake_opener(request, timeout):
        path = urlparse(request.full_url).path
        return FakeResponse(responses[path])

    result = CommuteDataPlatformAdapter("https://api.example", opener=fake_opener).load()
    assert result.source == "https://api.example"
    assert result.data["routes"] == [{"id": "TJ:1", "name": "Koridor 1", "stop_ids": ["TJ-A"]}]
    assert result.data["timetables"] == [{"route_id": "TJ:1", "station_id": "TJ-A", "data": [{"id": "schedule-1"}]}]
