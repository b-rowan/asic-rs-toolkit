from __future__ import annotations

import json
import os
import time
from collections import deque
from pathlib import Path
from typing import Any

import aiosqlite

from .miners import AppSettings, HISTORY_SECONDS, HistoryPoint, MinerRecord, trim_history


class ToolkitStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or default_database_path()

    async def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self.path) as db:
            await db.execute("PRAGMA journal_mode=WAL")
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS miners (
                    ip TEXT PRIMARY KEY,
                    data TEXT NOT NULL DEFAULT '{}',
                    supports TEXT NOT NULL DEFAULT '{}',
                    error TEXT,
                    last_seen REAL,
                    updated_at REAL NOT NULL
                )
                """
            )
            await db.execute(
                """
                CREATE TABLE IF NOT EXISTS miner_history (
                    ip TEXT NOT NULL,
                    timestamp REAL NOT NULL,
                    point TEXT NOT NULL,
                    PRIMARY KEY (ip, timestamp)
                )
                """
            )
            await db.execute("CREATE INDEX IF NOT EXISTS idx_miner_history_ip_time ON miner_history (ip, timestamp)")
            await db.commit()

    async def load_settings(self) -> AppSettings:
        async with aiosqlite.connect(self.path) as db:
            rows = await db.execute_fetchall("SELECT value FROM settings WHERE key = 'app'")
        if not rows:
            return AppSettings()
        loaded = json.loads(rows[0][0])
        if isinstance(loaded, dict) and "live_updates" in loaded:
            loaded.setdefault("live_scanning", bool(loaded["live_updates"]))
            loaded.setdefault("live_data_updates", bool(loaded["live_updates"]))
        if isinstance(loaded, dict) and "poll_interval" in loaded:
            loaded.setdefault("scan_interval", loaded["poll_interval"])
            loaded.setdefault("data_update_interval", loaded["poll_interval"])
        return AppSettings.model_validate(loaded)

    async def save_settings(self, settings: AppSettings) -> None:
        await self.initialize()
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                INSERT INTO settings (key, value)
                VALUES ('app', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (settings.model_dump_json(),),
            )
            await db.commit()

    async def load_miners(self) -> dict[str, MinerRecord]:
        cutoff = time.time() - HISTORY_SECONDS
        async with aiosqlite.connect(self.path) as db:
            miner_rows = await db.execute_fetchall(
                "SELECT ip, data, supports, error, last_seen FROM miners ORDER BY ip"
            )
            history_rows = await db.execute_fetchall(
                "SELECT ip, point FROM miner_history WHERE timestamp >= ? ORDER BY ip, timestamp",
                (cutoff,),
            )

        history_by_ip: dict[str, deque[HistoryPoint]] = {}
        for ip, point_json in history_rows:
            history_by_ip.setdefault(ip, deque()).append(HistoryPoint.model_validate_json(point_json))

        records: dict[str, MinerRecord] = {}
        for ip, data_json, supports_json, error, last_seen in miner_rows:
            history = history_by_ip.get(ip, deque())
            trim_history(history)
            records[ip] = MinerRecord(
                ip=ip,
                data=_loads(data_json, {}),
                supports=_loads(supports_json, {}),
                error=error,
                last_seen=last_seen,
                history=history,
            )
        return records

    async def save_miner(self, record: MinerRecord) -> None:
        await self.initialize()
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                INSERT INTO miners (ip, data, supports, error, last_seen, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(ip) DO UPDATE SET
                    data = excluded.data,
                    supports = excluded.supports,
                    error = excluded.error,
                    last_seen = excluded.last_seen,
                    updated_at = excluded.updated_at
                """,
                (
                    record.ip,
                    _dumps(record.data),
                    _dumps(record.supports),
                    record.error,
                    record.last_seen,
                    time.time(),
                ),
            )
            await db.commit()

    async def save_history_point(self, ip: str, point: HistoryPoint) -> None:
        await self.initialize()
        cutoff = time.time() - HISTORY_SECONDS
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                INSERT OR REPLACE INTO miner_history (ip, timestamp, point)
                VALUES (?, ?, ?)
                """,
                (ip, point.timestamp, point.model_dump_json()),
            )
            await db.execute("DELETE FROM miner_history WHERE timestamp < ?", (cutoff,))
            await db.commit()

    async def delete_miners(self, ips: list[str]) -> None:
        if not ips:
            return
        await self.initialize()
        placeholders = ",".join("?" for _ in ips)
        async with aiosqlite.connect(self.path) as db:
            await db.execute(f"DELETE FROM miners WHERE ip IN ({placeholders})", ips)
            await db.execute(f"DELETE FROM miner_history WHERE ip IN ({placeholders})", ips)
            await db.commit()


def default_database_path() -> Path:
    configured = os.environ.get("ASIC_RS_TOOLKIT_DB")
    if configured:
        return Path(configured).expanduser()

    if os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        root = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return root / "asic-rs-toolkit" / "toolkit.sqlite3"


def _loads(value: str, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        loaded = json.loads(value)
    except json.JSONDecodeError:
        return fallback
    return loaded if isinstance(loaded, dict) else fallback


def _dumps(value: Any) -> str:
    return json.dumps(value, default=str, separators=(",", ":"))
