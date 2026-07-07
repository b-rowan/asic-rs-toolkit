from __future__ import annotations

import argparse
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from asic_rs_toolkit.server import run
from asic_rs_toolkit.window import run_window


def main() -> None:
    parser = argparse.ArgumentParser(description="Local pyasic-rs miner scanning and management toolkit.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--browser", action="store_true", help="Open the UI in the default browser instead of an app window.")
    parser.add_argument("--server-only", action="store_true", help="Run only the local backend server.")
    parser.add_argument("--debug-window", action="store_true", help="Enable pywebview debug mode.")
    parser.add_argument("--no-browser", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.server_only or args.no_browser:
        run(args.host, args.port, False)
    elif args.browser:
        run(args.host, args.port, True)
    else:
        run_window(args.host, args.port, args.debug_window)


if __name__ == "__main__":
    main()
