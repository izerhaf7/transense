"""Convert the RITJ rail shapefile (Jalur LRT/MRT/KRL) into a JSON geometry file.

Reads an ESRI shapefile of existing rail lines (KRL, MRT, LRT in Jakarta) and
writes ``backend/data/rail_geometry.json`` mapping each corridor onto the
Commute Data Platform ``operator:code`` keys used by the backend.

Each line is stored as a list of segments (polylines), because real rail
geometry is often fragmented into many separate LineString features.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

import shapefile

# (NAMOBJ, REMARK) -> (operator, line code)
MAPPING = {
    ("Jalur Kereta Rel Listrik", "koridor Lintas Utara (Tanjung Priok Line)"): ("KCI", "TP"),
    ("Jalur Kereta Rel Listrik", "koridor Jalur Lingkar (Loopline Jatinegara - Tanah Abang - Kemayoran)"): ("KCI", "C"),
    ("Jalur Kereta Rel Listrik", "koridor Lintas Barat Daya (Serpong Line)"): ("KCI", "R"),
    ("Jalur Kereta Rel Listrik", "koridor Lintas Tengah (Bogor Line)"): ("KCI", "B"),
    ("Jalur Kereta Rel Listrik", "koridor Lintas Barat (Tangerang Line)"): ("KCI", "T"),
    ("Jalur Kereta Rel Listrik", "koridor Lintas Timur (Cikarang Line)"): ("KCI", "C"),
    ("Jalur MRT", "jalur Lebak Bulus - Bundaran HI (North - South)"): ("MRTJ", "M"),
    ("Jalur LRT", "jalur Kelapa Gading - Velodrome"): ("LRTJ", "S"),
}


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: python convert_rail_geometry.py <shapefile.shp> <out.json>")
        return 2

    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])

    reader = shapefile.Reader(str(src))
    fields = [f[0] for f in reader.fields[1:]]

    # operator:code -> list of polylines
    collected: dict[tuple[str, str], list[list[list[float]]]] = defaultdict(list)

    for record, geom in zip(reader.records(), reader.shapes()):
        rec = dict(zip(fields, record))
        key = (rec["NAMOBJ"], rec["REMARK"])
        if key not in MAPPING:
            continue
        op_code = MAPPING[key]
        parts = geom.parts
        points = geom.points
        # Split the point list into per-part polylines.
        boundaries = list(parts) + [len(points)]
        for start, end in zip(boundaries, boundaries[1:]):
            polyline = [[round(float(x), 6), round(float(y), 6)] for x, y in points[start:end]]
            if len(polyline) >= 2:
                collected[op_code].append(polyline)

    lines = [
        {
            "operator": op,
            "code": code,
            "segments": segments,
        }
        for (op, code), segments in sorted(collected.items())
    ]

    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(
        json.dumps({"source": "ritj-2021", "lines": lines}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"wrote {len(lines)} lines to {dst}")
    for line in lines:
        print(f"  {line['operator']}:{line['code']} -> {len(line['segments'])} segments")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
