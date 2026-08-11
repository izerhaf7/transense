from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_ORIGIN = "http://localhost:8000"
FRONTEND_ORIGINS = ",".join(
    (
        "http://localhost:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
    )
)


def main() -> int:
    environment = os.environ.copy()
    environment.update(
        {
            "TRANSENSE_ENVIRONMENT": "local-replay",
            "TRANSENSE_ALLOWED_ORIGINS": FRONTEND_ORIGINS,
            "TRANSENSE_DATABASE_PATH": str(ROOT / "backend" / "transense-replay.sqlite3"),
            "VITE_API_BASE_URL": BACKEND_ORIGIN,
        }
    )

    processes: list[subprocess.Popen[bytes]] = []
    try:
        processes.append(
            subprocess.Popen(
                [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", "8000"],
                cwd=ROOT,
                env=environment,
            )
        )
        npm = "npm.cmd" if os.name == "nt" else "npm"
        processes.append(
            subprocess.Popen(
                [npm, "run", "dev", "--", "--host", "127.0.0.1"],
                cwd=ROOT / "frontend",
                env=environment,
            )
        )
        print(f"Local replay started. Backend: {BACKEND_ORIGIN}; frontend origins: {FRONTEND_ORIGINS}")
        print("Press Ctrl+C to stop both processes.")
        return_code = processes[-1].wait()
    except KeyboardInterrupt:
        return_code = 0
    finally:
        for process in processes:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
        for process in processes:
            process.wait()
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
