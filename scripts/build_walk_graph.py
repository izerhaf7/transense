"""Offline walk-graph builder for Transense.

Precomputes the radius-limited walk graph (nearby stop pairs with street
distance/time estimates) from a GTFS feed and writes the versioned JSON cache
that the app loads at runtime.  Runs with no optional dependencies: when
``osmnx`` is installed real street distances are used (labelled ``"osmnx"``),
otherwise the deterministic haversine fallback is used and every edge is
labelled ``"haversine-estimate"``.

Example:

    python scripts/build_walk_graph.py --help
    python scripts/build_walk_graph.py
    python scripts/build_walk_graph.py --radius-km 1.5 --output backend/walk_graph_cache.json
    python scripts/build_walk_graph.py --no-download --gtfs-cache backend/gtfs_cache.zip
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.gtfs_loader import GtfsError, download_gtfs, parse_gtfs  # noqa: E402
from backend.walk_graph import (  # noqa: E402
    DEFAULT_RADIUS_KM,
    build_walk_graph,
    save_walk_graph,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="build_walk_graph",
        description="Build the Transense walk graph JSON cache from GTFS data (offline).",
    )
    parser.add_argument(
        "--gtfs-url",
        default="https://gtfs.transjakarta.co.id/files/file_gtfs.zip",
        help="URL to download the GTFS zip from (ignored with --no-download).",
    )
    parser.add_argument(
        "--gtfs-cache",
        default=str(ROOT / "backend" / "gtfs_cache.zip"),
        help="Local GTFS zip path used as download cache / direct input.",
    )
    parser.add_argument(
        "--radius-km",
        type=float,
        default=DEFAULT_RADIUS_KM,
        help="Walk radius around each stop in kilometres (default: %(default)s).",
    )
    parser.add_argument(
        "--output",
        default=str(ROOT / "backend" / "walk_graph_cache.json"),
        help="Output JSON cache path (default: %(default)s).",
    )
    parser.add_argument(
        "--no-download",
        action="store_true",
        help="Use the existing --gtfs-cache file without attempting a download.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.no_download:
        cache_path = Path(args.gtfs_cache)
        if not cache_path.exists():
            build_parser().error(
                f"--no-download given but GTFS cache not found: {cache_path}"
            )
    else:
        try:
            cache_path = download_gtfs(url=args.gtfs_url, cache_path=args.gtfs_cache)
        except GtfsError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

    feed = parse_gtfs(cache_path)
    graph = build_walk_graph(feed, radius_km=args.radius_km)
    save_walk_graph(graph, args.output)
    print(
        f"Walk graph built: {len(graph.nodes)} nodes, {len(graph.edges)} directed "
        f"edges (radius {graph.radius_km:g} km), method={graph.method}"
    )
    print(f"Cache written to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
