"""Transense one-shot setup script.

Run from the repository root:

    python scripts/setup.py

It prepares the environment for both frontend and backend so a teammate can
clone and run the demo quickly:

1. Installs backend Python dependencies.
2. Creates ``backend/.env.local`` from ``backend/.env.example`` if missing.
3. Pre-downloads and caches the TransJakarta GTFS feed.
4. Installs frontend npm dependencies.
5. Prints the commands to run both servers.

GTFS and API keys are never committed; they are fetched/configured locally.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
ENV_EXAMPLE = BACKEND / ".env.example"
ENV_LOCAL = BACKEND / ".env.local"
REQUIREMENTS = BACKEND / "requirements.txt"


def run(cmd: list[str], cwd: Path | None = None) -> int:
    print(f"\n> {' '.join(cmd)}")
    return subprocess.run(cmd, cwd=cwd or ROOT).returncode


def ensure_env_local() -> None:
    if ENV_LOCAL.exists():
        print(f"[ok] {ENV_LOCAL.relative_to(ROOT)} already exists, keeping it.")
        return
    if not ENV_EXAMPLE.exists():
        print("[skip] backend/.env.example not found; skipping env file creation.")
        return
    shutil.copyfile(ENV_EXAMPLE, ENV_LOCAL)
    print(f"[ok] created {ENV_LOCAL.relative_to(ROOT)} from .env.example")
    print("     Open it and add your ELEVENLABS_API_KEY if you want live transcription.")


def ensure_gtfs() -> None:
    sys.path.insert(0, str(ROOT))
    from backend.gtfs_loader import download_gtfs, parse_gtfs

    try:
        zip_path = download_gtfs(cache_path=str(BACKEND / "gtfs_cache.zip"), refresh_hours=0)
    except Exception as exc:
        print(f"[warn] GTFS download failed: {exc}")
        return
    feed = parse_gtfs(zip_path)
    print(
        f"[ok] GTFS cached ({zip_path.name}): "
        f"{len(feed.stops)} stops, {len(feed.routes)} routes, {len(feed.shapes)} shapes"
    )


def main() -> int:
    print("=" * 60)
    print("Transense setup")
    print("=" * 60)

    code = run([sys.executable, "-m", "pip", "install", "-r", str(REQUIREMENTS)])
    if code != 0:
        print("[error] backend dependencies failed")
        return code

    ensure_env_local()
    ensure_gtfs()

    if (FRONTEND / "package.json").exists():
        code = run(["npm", "install"], cwd=FRONTEND)
        if code != 0:
            print("[error] frontend dependencies failed")
            return code

    print("\n" + "=" * 60)
    print("Setup complete. Run the app:")
    print("=" * 60)
    print()
    print("Terminal 1 (backend):")
    print("  python -m uvicorn backend.main:app --reload")
    print()
    print("Terminal 2 (frontend):")
    print("  cd frontend && npm run dev")
    print()
    print("Open http://localhost:5173 in a browser.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
