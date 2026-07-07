from __future__ import annotations

import asyncio

from .server import ManagedToolkitServer


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
        webview.start(lambda: asyncio.run(server.serve_forever()), debug=debug)
    finally:
        server.request_stop()
