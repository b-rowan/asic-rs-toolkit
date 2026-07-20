from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import time
from collections import deque
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import aiosqlite
from platformdirs import user_data_path

from .miners import AppSettings, HISTORY_SECONDS, HistoryPoint, MinerRecord, trim_history

SQLITE_BUSY_TIMEOUT_MS = 30_000
SQLITE_WRITE_ATTEMPTS = 5
SQLITE_WRITE_RETRY_SECONDS = 0.05


class ToolkitStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or default_database_path()
        self._init_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._initialized = False

    async def initialize(self) -> None:
        if self._initialized:
            return
        async with self._init_lock:
            if self._initialized:
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            async with self._connect() as db:
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
            self._initialized = True

    async def load_settings(self) -> AppSettings:
        async with self._connect() as db:
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
        await self._write(
            lambda db: _save_settings(db, settings),
        )

    async def load_miners(self) -> dict[str, MinerRecord]:
        cutoff = time.time() - HISTORY_SECONDS
        async with self._connect() as db:
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
        await self._write(
            lambda db: _save_miner(db, record),
        )

    async def save_history_point(self, ip: str, point: HistoryPoint) -> None:
        await self.initialize()
        cutoff = time.time() - HISTORY_SECONDS
        await self._write(
            lambda db: _save_history_point(db, ip, point, cutoff),
        )

    async def delete_miners(self, ips: list[str]) -> None:
        if not ips:
            return
        await self.initialize()
        await self._write(
            lambda db: _delete_miners(db, ips),
        )

    def _connect(self) -> aiosqlite.Connection:
        return aiosqlite.connect(self.path, timeout=SQLITE_BUSY_TIMEOUT_MS / 1000)

    async def _write(self, operation: Callable[[aiosqlite.Connection], Awaitable[None]]) -> None:
        async with self._write_lock:
            for attempt in range(SQLITE_WRITE_ATTEMPTS):
                try:
                    async with self._connect() as db:
                        await db.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS}")
                        await operation(db)
                        await db.commit()
                    return
                except sqlite3.OperationalError as exc:
                    if not _is_locked_error(exc) or attempt == SQLITE_WRITE_ATTEMPTS - 1:
                        raise
                    await asyncio.sleep(SQLITE_WRITE_RETRY_SECONDS * (2**attempt))


async def _save_settings(db: aiosqlite.Connection, settings: AppSettings) -> None:
    await db.execute(
        """
        INSERT INTO settings (key, value)
        VALUES ('app', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (settings.model_dump_json(),),
    )


async def _save_miner(db: aiosqlite.Connection, record: MinerRecord) -> None:
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


async def _save_history_point(
    db: aiosqlite.Connection,
    ip: str,
    point: HistoryPoint,
    cutoff: float,
) -> None:
    await db.execute(
        """
        INSERT OR REPLACE INTO miner_history (ip, timestamp, point)
        VALUES (?, ?, ?)
        """,
        (ip, point.timestamp, point.model_dump_json()),
    )
    await db.execute("DELETE FROM miner_history WHERE timestamp < ?", (cutoff,))


async def _delete_miners(db: aiosqlite.Connection, ips: list[str]) -> None:
    placeholders = ",".join("?" for _ in ips)
    await db.execute(f"DELETE FROM miners WHERE ip IN ({placeholders})", ips)
    await db.execute(f"DELETE FROM miner_history WHERE ip IN ({placeholders})", ips)


def _is_locked_error(exc: sqlite3.OperationalError) -> bool:
    message = str(exc).lower()
    return "database is locked" in message or "database table is locked" in message or "database is busy" in message


def default_database_path() -> Path:
    configured = os.environ.get("ASIC_RS_TOOLKIT_DB")
    if configured:
        return Path(configured).expanduser()

    return user_data_path("asic-rs-toolkit", appauthor=False) / "toolkit.sqlite3"


def _loads(value: str, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        loaded = json.loads(value)
    except json.JSONDecodeError:
        return fallback
    return loaded if isinstance(loaded, dict) else fallback


def _dumps(value: Any) -> str:
    return json.dumps(value, default=str, separators=(",", ":"))
