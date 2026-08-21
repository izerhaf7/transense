"""Transport-layer dependency helpers.

State hangs off ``app.state`` (see backend/AGENTS.md); these helpers give route
handlers typed, testable access to the resolved settings and shared singletons
without touching module globals.
"""

from __future__ import annotations

from typing import Any

from fastapi import Request

from ..config import Settings
from ..persistence import DemoStore


def get_settings(request: Request) -> Settings:
    """Resolved runtime settings for the active app."""
    return request.app.state.settings


def get_store(request: Request) -> DemoStore | None:
    """The demo persistence store, or ``None`` when unavailable."""
    return getattr(request.app.state, "store", None)


def get_gtfs_feed(request: Request) -> Any:
    """The loaded GTFS feed, or ``None`` when not loaded."""
    return getattr(request.app.state, "gtfs_feed", None)


def get_walk_graph(request: Request) -> Any:
    """The loaded walk graph, or ``None`` when not loaded."""
    return getattr(request.app.state, "walk_graph", None)


def get_realtime_client(request: Request) -> Any:
    """The TJ realtime client, or ``None`` when unavailable."""
    return getattr(request.app.state, "realtime_client", None)


def get_commute_feed(request: Request) -> Any:
    """The rail Commute feed, or ``None`` when unavailable."""
    return getattr(request.app.state, "commute_feed", None)
