from __future__ import annotations

import base64
import json
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx

logger = logging.getLogger(__name__)

DEFAULT_API_BASE = "https://tijeapi.transjakarta.co.id"
DEFAULT_RADIUS_KM = 3.0
DEFAULT_POLL_INTERVAL = 15
DEFAULT_CENTER_LAT = -6.1944
DEFAULT_CENTER_LNG = 106.8227


class TjApiError(RuntimeError):
    pass


@dataclass(frozen=True)
class RealtimeBus:
    bus_id: str
    route_code: str
    lat: float
    lng: float
    direction_id: int | None
    trip_id: str | None
    observed_at: datetime


class TjRealtimeClient:
    def __init__(
        self,
        api_base: str | None = None,
        device_id: str | None = None,
        timeout: float = 20.0,
    ):
        self.api_base = (api_base or DEFAULT_API_BASE).rstrip("/")
        self.device_id = device_id or f"transense-{uuid.uuid4().hex[:12]}"
        self.timeout = timeout
        self._token: str | None = None
        self._token_expiry: float = 0.0
        self._app_version: str | None = None
        self._client = httpx.Client(timeout=self.timeout, follow_redirects=True)

    def close(self) -> None:
        self._client.close()

    def _headers(self, version: str, authenticated: bool = True) -> dict[str, str]:
        headers: dict[str, str] = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "okhttp/4.12.0",
            "X-App-OS": "android",
            "X-App-Version": version,
            "X-Device-ID": self.device_id,
        }
        if authenticated and self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    def _jwt_expiry(self, token: str) -> float:
        try:
            payload = token.split(".")[1]
            payload += "=" * (-len(payload) % 4)
            decoded = json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
            return float(decoded.get("exp", 0))
        except Exception:
            return 0

    def authenticate(self, force: bool = False) -> str:
        now = time.time()
        if not force and self._token and now < self._token_expiry - 60:
            return self._token

        versions = [v for v in (["3.0.0", "2.10.2"]) if v != self._app_version]
        if self._app_version:
            versions.insert(0, self._app_version)
        last_error: Exception | None = None
        for version in versions:
            try:
                resp = self._client.post(
                    f"{self.api_base}/v1/auth/login/guest",
                    headers=self._headers(version, authenticated=False),
                    json={"device_id": self.device_id},
                )
                resp.raise_for_status()
                data = resp.json()
                token = _find_token(data)
                if not token:
                    raise TjApiError("Guest login returned no token")
                self._token = str(token)
                self._token_expiry = self._jwt_expiry(self._token) or (now + 86400)
                self._app_version = version
                return self._token
            except Exception as exc:
                last_error = exc
        raise TjApiError(f"Guest authentication failed: {last_error}")

    def _get(self, path: str, params: dict[str, Any]) -> Any:
        self.authenticate()
        version = self._app_version or "3.0.0"
        resp = self._client.get(
            f"{self.api_base}{path}",
            params=params,
            headers=self._headers(version),
        )
        if resp.status_code == 401:
            self.authenticate(force=True)
            version = self._app_version or version
            resp = self._client.get(
                f"{self.api_base}{path}",
                params=params,
                headers=self._headers(version),
            )
        resp.raise_for_status()
        return resp.json()

    def get_buses(
        self,
        lat: float = DEFAULT_CENTER_LAT,
        lng: float = DEFAULT_CENTER_LNG,
        radius_km: float = DEFAULT_RADIUS_KM,
    ) -> list[RealtimeBus]:
        payload = self._get(
            "/v1/bus",
            {"latitude": lat, "longitude": lng, "radius": radius_km},
        )
        rows = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            raise TjApiError("Unexpected /v1/bus response structure")

        buses: list[RealtimeBus] = []
        observed = datetime.now(timezone.utc)
        for row in rows:
            if not isinstance(row, dict):
                continue
            lat_val = _to_float(row.get("latitude") or row.get("lat"))
            lng_val = _to_float(row.get("longitude") or row.get("lng") or row.get("lon"))
            if lat_val is None or lng_val is None:
                continue
            bus_id = str(
                row.get("bus_body_no") or row.get("body_no") or row.get("vehicle_id") or row.get("id") or ""
            ).strip()
            route_code = str(
                row.get("route_code") or row.get("route_short_name") or row.get("route") or ""
            ).strip()
            if not bus_id or not route_code:
                continue
            buses.append(
                RealtimeBus(
                    bus_id=bus_id,
                    route_code=route_code,
                    lat=lat_val,
                    lng=lng_val,
                    direction_id=(
                        int(row["direction_id"])
                        if row.get("direction_id") is not None
                        else None
                    ),
                    trip_id=(str(row.get("trip_id")).strip() if row.get("trip_id") else None),
                    observed_at=observed,
                )
            )
        return buses


def _find_token(payload: Any) -> str | None:
    if isinstance(payload, dict):
        for key in ("token", "access_token", "jwt"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for value in payload.values():
            found = _find_token(value)
            if found:
                return found
    return None


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
