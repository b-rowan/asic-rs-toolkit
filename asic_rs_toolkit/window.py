from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from .server import ManagedToolkitServer

APP_ICON = Path(__file__).with_name("static") / "assets" / "logo-mark-light.svg"


def _window_icon() -> str | None:
    if not APP_ICON.exists():
        return None
    if sys.platform == "win32" and APP_ICON.suffix.lower() == ".svg":
        return None
    return str(APP_ICON)


def run_window(host: str = "127.0.0.1", port: int = 8765, debug: bool = False) -> None:
    try:
        import webview
    except ImportError as exc:
        raise RuntimeError("The desktop window requires pywebview. Run `uv sync` and try again.") from exc

    server = ManagedToolkitServer(host, port)
    print(f"ASIC RS Toolkit running at {server.url}")

    window = webview.create_window(
        "ASIC RS Toolkit",
        server.url,
        width=1320,
        height=900,
        min_size=(960, 640),
    )

    try:
        if hasattr(window, "events"):
            window.events.closed += server.request_stop
        webview.start(
            lambda: asyncio.run(server.serve_forever()),
            debug=debug,
            icon=_window_icon(),
        )
    finally:
        server.request_stop()
