# ASIC RS Toolkit

Local miner scanning and management UI backed by `pyasic-rs`.

## Run

```bash
uv run asic-rs-toolkit
```

or:

```bash
python -m asic_rs_toolkit
```

The default launcher opens the FastAPI/Uvicorn-backed local web UI inside its own desktop window. Closing the window stops the backend server. For development, use `--browser` to open the system browser or `--server-only` to run only the local backend at `http://127.0.0.1:8765`.

The desktop window uses `pywebview[qt]`, which installs the Python Qt webview backend dependencies used on Linux. Windows uses the installed Edge WebView2 runtime; most current Windows systems already include it.

## Build Native Executables

Build on the target operating system so `pyasic-rs` and PyInstaller collect the correct native wheels.

```bash
uv sync --extra build
uv run pyinstaller asic-rs-toolkit.spec
```

The executable is written to `dist/asic-rs-toolkit` on Linux and `dist/asic-rs-toolkit.exe` on Windows.

## Features

- Octet range entry using `a-b.c-d.e-f.g-h` expressions.
- Sortable miner table with checkbox selection and error indicators.
- Bottom selection bar with capability-aware actions driven by `supports_*` flags.
- Action dialog showing which selected miners support or do not support the chosen action.
- Optional username/password credentials when applying actions.
- Live scan toggle and manual scan button.
- Static page live reload while the local server is running.
