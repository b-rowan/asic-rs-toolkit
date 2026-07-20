from __future__ import annotations

import asyncio
import contextlib
import json
import math
import random
import socket
import time
import webbrowser
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse

from .miners import (
    AppSettings,
    DEFAULT_BACKGROUND_DATA_CONCURRENCY_LIMIT,
    DEFAULT_SCAN_CONCURRENCY_LIMIT,
    HistoryPoint,
    MinerRecord,
    apply_action,
    collect_data,
    get_miner,
    listen_ip_reports,
    revalidate_miner,
    summarize_history_point,
    stream_scan_progress_expressions,
    trim_history,
)
from .ranges import estimate_range_size, ip_in_any_range, iter_ips
from .storage import ToolkitStore

STATIC_DIR = Path(__file__).with_name("static")
STATUS_STREAM_HEARTBEAT_SECONDS = 1.0
LIVE_RELOAD_HEARTBEAT_SECONDS = 15.0
DEFAULT_BACKGROUND_DATA_CONCURRENCY = DEFAULT_BACKGROUND_DATA_CONCURRENCY_LIMIT
SCAN_STATUS_UPDATE_SECONDS = 0.2


class MinerOfflineError(RuntimeError):
    pass


@dataclass
class DbWrite:
    kind: Literal["save_miner", "persist_record"]
    record: MinerRecord
    point: HistoryPoint | None = None


class ToolkitState:
    def __init__(self, store: ToolkitStore | None = None) -> None:
        self.lock = asyncio.Lock()
        self.store = store or ToolkitStore()
        self.miners: dict[str, MinerRecord] = {}
        self.ranges: list[str] = []
        self.range_names: list[str] = []
        self.enabled_ranges: list[bool] = []
        self.live_scanning = False
        self.live_data_updates = False
        self.scan_running = False
        self.scan_progress = self._empty_scan_progress()
        self.data_update_running = False
        self.last_scan_error: str | None = None
        self.scan_interval = 30
        self.scan_concurrency_limit = DEFAULT_SCAN_CONCURRENCY_LIMIT
        self.data_update_interval = 30
        self.background_data_concurrency_limit = DEFAULT_BACKGROUND_DATA_CONCURRENCY
        self.auto_clear_offline = False
        self.appearance = "system"
        self.ip_report_running = False
        self.ip_report_error: str | None = None
        self.ip_reports: dict[str, dict[str, Any]] = {}
        self._next_scan_at: float | None = None
        self._next_data_at: float | None = None
        self._poll_task: asyncio.Task[None] | None = None
        self._scan_task: asyncio.Task[None] | None = None
        self._ip_report_task: asyncio.Task[None] | None = None
        self._background_data_dispatcher: asyncio.Task[None] | None = None
        self._background_data_tasks: set[asyncio.Task[None]] = set()
        self._background_data_queue: asyncio.Queue[MinerRecord] = asyncio.Queue()
        self._background_data_semaphore = asyncio.Semaphore(self.background_data_concurrency_limit)
        self._db_write_task: asyncio.Task[None] | None = None
        self._db_write_queue: asyncio.Queue[DbWrite] = asyncio.Queue()
        self._data_update_count = 0
        self._poll_wakeup = asyncio.Event()
        self._status_condition = asyncio.Condition()
        self._status_version = 0
        self._stopped = False
        self._loaded = False

    def _empty_scan_progress(self) -> dict[str, Any]:
        return {"total": 0, "scanned": 0, "found": 0, "current_ip": None}

    def _initial_scan_progress_unlocked(self, ranges: list[str]) -> dict[str, Any]:
        return {
            "total": sum(estimate_range_size(expression) for expression in ranges),
            "scanned": 0,
            "found": 0,
            "current_ip": None,
        }

    async def start(self) -> None:
        await self._load_persisted_state()
        self._ensure_background_workers()
        if self._poll_task is None or self._poll_task.done():
            self._stopped = False
            self._poll_task = asyncio.create_task(self._poll_loop(), name="miner-poller")
        async with self.lock:
            live = self.live_scanning
            ranges = self._active_ranges_unlocked()
        if live and ranges:
            await self.start_scan()

    async def stop(self) -> None:
        self._stopped = True
        async with self.lock:
            self.live_scanning = False
            self.live_data_updates = False

        tasks = [
            task
            for task in (
                self._scan_task,
                self._ip_report_task,
                self._poll_task,
                self._db_write_task,
                self._background_data_dispatcher,
                *self._background_data_tasks,
            )
            if task and not task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def status(
        self,
        *,
        page: int = 1,
        page_size: int = 10,
        sort_key: str = "ip",
        sort_direction: str = "asc",
    ) -> dict[str, Any]:
        async with self.lock:
            now = time.monotonic()
            page = max(1, int(page))
            page_size = min(100, max(1, int(page_size)))
            sort_direction = "desc" if sort_direction == "desc" else "asc"
            visible_miners = self._visible_miner_records_unlocked()
            sorted_miners = self._sorted_miner_records(visible_miners, sort_key, sort_direction)
            total_miners = len(sorted_miners)
            page_count = max(1, math.ceil(total_miners / page_size))
            page = min(page, page_count)
            page_start = (page - 1) * page_size
            page_records = sorted_miners[page_start:page_start + page_size]
            return jsonable_encoder({
                "ranges": self.ranges,
                "range_names": self._normalized_range_names_unlocked(),
                "enabled_ranges": self._normalized_enabled_ranges_unlocked(),
                "range_hosts": self._range_host_counts_unlocked(),
                "live_scanning": self.live_scanning,
                "live_data_updates": self.live_data_updates,
                "live_updates": self.live_scanning or self.live_data_updates,
                "scan_running": self.scan_running,
                "scan_progress": dict(self.scan_progress),
                "data_update_running": self.data_update_running,
                "next_scan_in": (
                    _seconds_until(self._next_scan_at, now)
                    if self.live_scanning and self._active_ranges_unlocked()
                    else None
                ),
                "next_data_update_in": _seconds_until(self._next_data_at, now) if self.live_data_updates else None,
                "last_scan_error": self.last_scan_error,
                "settings": self._settings_unlocked().model_dump(),
                "miner_summary": self._miner_summary(visible_miners),
                "miner_page": {
                    "page": page,
                    "page_size": page_size,
                    "total": total_miners,
                    "page_count": page_count,
                    "sort_key": sort_key,
                    "sort_direction": sort_direction,
                },
                "miners": [record.snapshot() for record in page_records],
            })

    async def wait_for_status_change(self, version: int, timeout: float = 1.0) -> int:
        async with self._status_condition:
            try:
                await asyncio.wait_for(
                    self._status_condition.wait_for(lambda: self._status_version != version),
                    timeout,
                )
            except TimeoutError:
                pass
            return self._status_version

    async def _notify_status(self) -> None:
        async with self._status_condition:
            self._status_version += 1
            self._status_condition.notify_all()

    async def set_ranges(
        self,
        ranges: list[str],
        enabled_ranges: list[bool] | None = None,
        range_names: list[str] | None = None,
    ) -> dict[str, Any]:
        cleaned: list[str] = []
        cleaned_enabled: list[bool] = []
        cleaned_names: list[str] = []
        for index, item in enumerate(ranges):
            expression = str(item).strip()
            if not expression:
                continue
            cleaned.append(expression)
            cleaned_enabled.append(bool(enabled_ranges[index]) if enabled_ranges and index < len(enabled_ranges) else True)
            cleaned_names.append(str(range_names[index]).strip() if range_names and index < len(range_names) else "")
        for expression in cleaned:
            estimate_range_size(expression)
        async with self.lock:
            self.ranges = cleaned
            self.range_names = cleaned_names
            self.enabled_ranges = cleaned_enabled
            settings = self._settings_unlocked()
        self._wake_poll_loop()
        await self.store.save_settings(settings)
        await self._notify_status()
        return {
            "ranges": cleaned,
            "range_names": cleaned_names,
            "enabled_ranges": cleaned_enabled,
            "range_hosts": self._range_host_counts(cleaned),
            "estimated_hosts": sum(estimate_range_size(item) for item in self._active_ranges(cleaned, cleaned_enabled)),
        }

    async def toggle_live(
        self,
        *,
        scanning: bool | None = None,
        data_updates: bool | None = None,
    ) -> dict[str, Any]:
        async with self.lock:
            if scanning is not None:
                self.live_scanning = scanning
            if data_updates is not None:
                self.live_data_updates = data_updates
            settings = self._settings_unlocked()
        self._wake_poll_loop()
        await self.store.save_settings(settings)
        await self._notify_status()
        if data_updates:
            await self.refresh_all_miner_connections()
        if scanning:
            await self.start_scan()
        return {
            "live_scanning": settings.live_scanning,
            "live_data_updates": settings.live_data_updates,
            "live_updates": settings.live_scanning or settings.live_data_updates,
        }

    async def update_settings(self, payload: dict[str, Any]) -> dict[str, Any]:
        async with self.lock:
            if "scan_interval" in payload:
                self.scan_interval = _coerce_interval(payload["scan_interval"], "scan_interval")
            if "scan_concurrency_limit" in payload:
                self.scan_concurrency_limit = _coerce_scan_concurrency_limit(payload["scan_concurrency_limit"])
            if "data_update_interval" in payload:
                self.data_update_interval = _coerce_interval(payload["data_update_interval"], "data_update_interval")
            if "background_data_concurrency_limit" in payload:
                self._set_background_data_concurrency_limit(
                    _coerce_background_data_concurrency_limit(payload["background_data_concurrency_limit"])
                )
            if "auto_clear_offline" in payload:
                self.auto_clear_offline = bool(payload["auto_clear_offline"])
            if "appearance" in payload:
                self.appearance = _coerce_appearance(payload["appearance"])
            settings = self._settings_unlocked()
        self._wake_poll_loop()
        await self.store.save_settings(settings)
        await self._notify_status()
        if settings.auto_clear_offline:
            await self._clear_offline_miners()
        return {"settings": settings.model_dump()}

    async def start_scan(self) -> None:
        async with self.lock:
            if self.scan_running:
                return
            ranges = self._active_ranges_unlocked()
            concurrency_limit = self.scan_concurrency_limit
            self.scan_running = True
            self.scan_progress = self._initial_scan_progress_unlocked(ranges)
            self.last_scan_error = None
            self._scan_task = asyncio.create_task(
                self._run_started_scan(ranges, concurrency_limit),
                name="miner-scan",
            )
        await self._notify_status()

    async def refresh_miners(self, ips: list[str]) -> dict[str, Any]:
        records: list[MinerRecord] = []
        for ip in ips:
            record = await self._record_for_ip(ip)
            if record.miner is None:
                try:
                    miner = await get_miner(ip)
                    if miner is None:
                        raise LookupError("No supported miner responded.")
                except Exception as exc:
                    async with self.lock:
                        record.miner = None
                        record.data = _current_data_for_offline_record(record.data)
                        record.supports = {}
                        record.error = str(exc)
                    await self.store.save_miner(record)
                    continue
                async with self.lock:
                    record.miner = miner
                    record.data = _merge_partial_static_data(record.data, _miner_static_data(miner))
            records.append(record)

        await self._poll_records(records)
        async with self.lock:
            auto_clear = self.auto_clear_offline
        if auto_clear:
            await self._clear_offline_miners()
        await self._notify_status()
        return {"updated": len(records)}

    async def refresh_all_miner_connections(self) -> dict[str, Any]:
        async with self.lock:
            records = list(self.miners.values())
        await self._ensure_miner_connections(records)
        await self._notify_status()
        return {"updated": len(records)}

    async def apply_to_ips(self, ips: list[str], action: str, payload: dict[str, Any]) -> dict[str, Any]:
        results: list[dict[str, Any]] = []
        for ip in ips:
            record = await self._record_for_ip(ip)
            if record.miner is None:
                try:
                    miner = await get_miner(record.ip)
                    if miner is None:
                        raise LookupError("No supported miner responded.")
                except Exception as exc:
                    async with self.lock:
                        record.miner = None
                        record.data = _current_data_for_offline_record(record.data)
                        record.supports = {}
                        record.error = str(exc)
                    await self.store.save_miner(record)
                    results.append({"ip": record.ip, "ok": False, "error": str(exc)})
                    continue
                async with self.lock:
                    record.miner = miner
                    record.data = _merge_partial_static_data(record.data, _miner_static_data(miner))

            try:
                if not await revalidate_miner(record.miner):
                    raise MinerOfflineError("Miner did not respond to revalidation.")
                message = await apply_action(record.miner, action, payload)
                data, supports = await collect_data(record.miner)
                async with self.lock:
                    data = _merge_partial_static_data(data, _static_data_from_data(record.data))
                    record.data = data
                    record.supports = supports
                    record.error = None
                    record.last_seen = time.time()
                    point = summarize_history_point(data)
                    record.history.append(point)
                    trim_history(record.history)
                await self._persist_record(record, point)
                results.append({"ip": record.ip, "ok": True, "message": message})
            except Exception as exc:
                async with self.lock:
                    record.miner = None
                    record.data = _current_data_for_offline_record(record.data)
                    record.supports = {}
                    record.error = str(exc)
                await self.store.save_miner(record)
                results.append({"ip": record.ip, "ok": False, "error": str(exc)})
        async with self.lock:
            auto_clear = self.auto_clear_offline
        if auto_clear:
            await self._clear_offline_miners()
        await self._notify_status()
        return {"results": results}

    async def ip_report_status(self) -> dict[str, Any]:
        async with self.lock:
            return jsonable_encoder({
                "running": self.ip_report_running,
                "error": self.ip_report_error,
                "miners": list(self.ip_reports.values()),
            })

    async def toggle_ip_report_listener(self, running: bool) -> dict[str, Any]:
        if running:
            await self.start_ip_report_listener()
        else:
            await self.stop_ip_report_listener()
        return await self.ip_report_status()

    async def start_ip_report_listener(self) -> None:
        async with self.lock:
            if self.ip_report_running:
                return
            self.ip_report_running = True
            self.ip_report_error = None
            self._ip_report_task = asyncio.create_task(
                self._run_ip_report_listener(),
                name="ip-report-listener",
            )
        await self._notify_status()

    async def stop_ip_report_listener(self) -> None:
        async with self.lock:
            task = self._ip_report_task
            self.ip_report_running = False
            self._ip_report_task = None
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self._notify_status()

    async def _run_ip_report_listener(self) -> None:
        current_task = asyncio.current_task()
        try:
            async for ip in listen_ip_reports():
                await self._record_ip_report(ip)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            async with self.lock:
                self.ip_report_error = str(exc)
        finally:
            async with self.lock:
                if self._ip_report_task is current_task:
                    self._ip_report_task = None
                self.ip_report_running = False
            await self._notify_status()

    async def _record_ip_report(self, ip: str) -> None:
        ip = str(ip)
        async with self.lock:
            self.ip_reports[ip] = {**self.ip_reports.get(ip, {}), "ip": ip}
        await self._notify_status()

        try:
            miner = await get_miner(ip)
            if miner is None:
                raise LookupError("No supported miner responded.")
            row = _ip_report_row(ip, miner)
        except Exception as exc:
            row = {"ip": ip, "make": "-", "model": "-", "firmware": "-", "error": str(exc)}

        async with self.lock:
            self.ip_reports[ip] = row
        await self._notify_status()

    async def history(self, ip: str) -> dict[str, Any]:
        async with self.lock:
            record = self.miners.get(ip)
            if record is None:
                raise KeyError(ip)
            return {
                "ip": ip,
                "miner": record.snapshot(),
                "points": [point.model_dump() for point in record.history],
            }

    def range_preview(self, expression: str) -> dict[str, Any]:
        size = estimate_range_size(expression)
        return {"estimated_hosts": size, "preview": iter_ips(expression, 16)}

    async def _record_for_ip(self, ip: str) -> MinerRecord:
        async with self.lock:
            record = self.miners.get(ip)
            if record is None:
                record = MinerRecord(ip=ip)
                self.miners[ip] = record
            return record

    async def _scan_worker(self, ranges: list[str], concurrency_limit: int) -> None:
        self._ensure_background_workers()
        status_stop = asyncio.Event()
        status_task = asyncio.create_task(
            self._scan_status_notifier(status_stop),
            name="miner-scan-status",
        )
        scanned = 0
        found = 0
        try:
            async for ip, miner in stream_scan_progress_expressions(ranges, concurrency_limit):
                scanned += 1
                if miner is None:
                    record = self._record_missing_miner(ip)
                    if record is not None:
                        self._queue_miner_save(record)
                else:
                    found += 1
                    record = self._record_found_miner(miner)
                    self._queue_background_data_update(record)
                self._record_scan_progress(scanned, found, ip)
            self._record_scan_progress(scanned, found, None)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            async with self.lock:
                self.last_scan_error = str(exc)
            await self._notify_status()
        finally:
            status_stop.set()
            status_task.cancel()
            await asyncio.gather(status_task, return_exceptions=True)
            async with self.lock:
                self.scan_running = False
            await self._notify_status()

    async def _scan_status_notifier(self, stop_event: asyncio.Event) -> None:
        try:
            while not stop_event.is_set():
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=SCAN_STATUS_UPDATE_SECONDS)
                except TimeoutError:
                    await self._notify_status()
        except asyncio.CancelledError:
            raise

    def _record_scan_progress(self, scanned: int, found: int, current_ip: str | None) -> None:
        self.scan_progress["scanned"] = min(self.scan_progress["total"], scanned)
        self.scan_progress["found"] = found
        self.scan_progress["current_ip"] = current_ip

    def _record_found_miner(self, miner: Any) -> MinerRecord:
        ip = str(miner.ip)
        record = self.miners.get(ip) or MinerRecord(ip=ip)
        record.miner = miner
        record.data = _merge_partial_static_data(record.data, _miner_static_data(miner))
        record.error = None
        record.loading = True
        self.miners[ip] = record
        return record

    def _record_missing_miner(self, ip: str) -> MinerRecord | None:
        record = self.miners.get(ip)
        if record is None:
            return None
        if self._mark_missing_miner(record):
            return record
        return None

    def _mark_missing_miner(self, record: MinerRecord) -> bool:
        if record.loading:
            return False
        record.miner = None
        record.data = _current_data_for_offline_record(record.data)
        record.supports = {}
        record.loading = False
        record.error = "No supported miner responded."
        return True

    def _queue_background_data_update(self, record: MinerRecord) -> None:
        self._ensure_background_workers()
        self._data_update_count += 1
        self.data_update_running = True
        self._background_data_queue.put_nowait(record)

    def _queue_miner_save(self, record: MinerRecord) -> None:
        self._ensure_background_workers()
        self._db_write_queue.put_nowait(DbWrite(kind="save_miner", record=record))

    def _queue_record_persist(self, record: MinerRecord, point: HistoryPoint) -> None:
        self._ensure_background_workers()
        self._db_write_queue.put_nowait(DbWrite(kind="persist_record", record=record, point=point))

    def _ensure_background_workers(self) -> None:
        self._background_data_tasks = {
            task for task in self._background_data_tasks if not task.done()
        }
        if self._background_data_dispatcher is None or self._background_data_dispatcher.done():
            self._background_data_dispatcher = asyncio.create_task(
                self._background_data_worker(),
                name="miner-data-dispatcher",
            )
        if self._db_write_task is None or self._db_write_task.done():
            self._db_write_task = asyncio.create_task(self._db_write_worker(), name="miner-db-writer")

    async def _background_data_worker(self) -> None:
        try:
            while True:
                record = await self._background_data_queue.get()
                task = asyncio.create_task(
                    self._run_background_data_update(record),
                    name=f"miner-data-{record.ip}",
                )
                self._background_data_tasks.add(task)
                task.add_done_callback(self._background_data_tasks.discard)
        except asyncio.CancelledError:
            raise

    async def _run_background_data_update(self, record: MinerRecord) -> None:
        try:
            async with self._background_data_semaphore:
                await self._poll_record(record, background_persist=True)
                async with self.lock:
                    auto_clear = self.auto_clear_offline
                if auto_clear:
                    await self._clear_offline_miners()
        except Exception as exc:
            await self._record_background_data_error(exc)
        finally:
            self._background_data_queue.task_done()
            await self._end_data_update()

    async def _db_write_worker(self) -> None:
        try:
            while True:
                write = await self._db_write_queue.get()
                try:
                    if write.kind == "save_miner":
                        await self.store.save_miner(write.record)
                    elif write.kind == "persist_record":
                        if write.point is None:
                            raise ValueError("persist_record writes require a history point.")
                        await self._persist_record(write.record, write.point)
                    await self._notify_status()
                except Exception as exc:
                    await self._record_background_data_error(exc)
                finally:
                    self._db_write_queue.task_done()
        except asyncio.CancelledError:
            raise

    async def _record_background_data_error(self, error: BaseException) -> None:
        async with self.lock:
            self.last_scan_error = str(error)
        await self._notify_status()

    async def _run_scan(self, ranges: list[str], concurrency_limit: int) -> bool:
        current_task = asyncio.current_task()
        async with self.lock:
            if self.scan_running:
                running_task = self._scan_task
            else:
                running_task = None
                self.scan_running = True
                self.scan_progress = self._initial_scan_progress_unlocked(ranges)
                self.last_scan_error = None
                if current_task is not None:
                    self._scan_task = current_task

        if running_task is not None:
            if running_task is not current_task:
                await asyncio.shield(running_task)
            return False

        await self._notify_status()
        try:
            await self._scan_worker(ranges, concurrency_limit)
            return True
        finally:
            async with self.lock:
                if self._scan_task is current_task:
                    self._scan_task = None

    async def _run_started_scan(self, ranges: list[str], concurrency_limit: int) -> None:
        current_task = asyncio.current_task()
        try:
            await self._scan_worker(ranges, concurrency_limit)
        finally:
            async with self.lock:
                if self._scan_task is current_task:
                    self._scan_task = None

    async def _poll_loop(self) -> None:
        try:
            now = time.monotonic()
            async with self.lock:
                next_scan_at = now + self.scan_interval
                next_data_at = now if self.live_data_updates and self.miners else now + self.data_update_interval
                previous_scan_interval = self.scan_interval
                previous_data_update_interval = self.data_update_interval
                self._next_scan_at = next_scan_at
                self._next_data_at = next_data_at
            while not self._stopped:
                async with self.lock:
                    live_scanning = self.live_scanning
                    live_data_updates = self.live_data_updates
                    scan_interval = self.scan_interval
                    scan_concurrency_limit = self.scan_concurrency_limit
                    data_update_interval = self.data_update_interval
                    ranges = self._active_ranges_unlocked()
                    records = list(self.miners.values())
                now = time.monotonic()
                if scan_interval != previous_scan_interval:
                    next_scan_at = now + scan_interval
                    previous_scan_interval = scan_interval
                if data_update_interval != previous_data_update_interval:
                    next_data_at = now + data_update_interval
                    previous_data_update_interval = data_update_interval
                if live_scanning and ranges and now >= next_scan_at:
                    await self._run_scan(ranges, scan_concurrency_limit)
                    next_scan_at = time.monotonic() + scan_interval
                elif not live_scanning or not ranges:
                    next_scan_at = now + scan_interval
                if live_data_updates and records and now >= next_data_at:
                    await self._poll_records(records)
                    next_data_at = time.monotonic() + data_update_interval
                elif not live_data_updates or not records:
                    next_data_at = now + data_update_interval
                async with self.lock:
                    self._next_scan_at = next_scan_at
                    self._next_data_at = next_data_at
                await self._notify_status()
                sleep_for = max(1, min(next_scan_at, next_data_at) - time.monotonic())
                try:
                    await asyncio.wait_for(self._poll_wakeup.wait(), timeout=sleep_for)
                    self._poll_wakeup.clear()
                except TimeoutError:
                    pass
        except asyncio.CancelledError:
            pass

    async def _poll_records(self, records: Iterable[MinerRecord], limit: int = 16) -> None:
        records = list(records)
        await self._begin_data_update()
        try:
            await self._poll_records_unlocked(records, limit)
        finally:
            await self._end_data_update()
        async with self.lock:
            auto_clear = self.auto_clear_offline
        if auto_clear:
            await self._clear_offline_miners()
        await self._notify_status()

    async def _poll_records_unlocked(self, records: list[MinerRecord], limit: int) -> None:
        await self._ensure_miner_connections(records, limit)
        semaphore = asyncio.Semaphore(limit)
        await asyncio.gather(*(self._poll_record(record, semaphore) for record in records))

    async def _poll_record(
        self,
        record: MinerRecord,
        semaphore: asyncio.Semaphore | None = None,
        *,
        background_persist: bool = False,
    ) -> None:
        if record.miner is None:
            return
        if semaphore is None:
            await self._poll_record_unlocked(record, background_persist=background_persist)
            return
        async with semaphore:
            await self._poll_record_unlocked(record, background_persist=background_persist)

    async def _poll_record_unlocked(self, record: MinerRecord, *, background_persist: bool = False) -> None:
        try:
            if not await revalidate_miner(record.miner):
                raise MinerOfflineError("Miner did not respond to revalidation.")
            data, supports = await collect_data(record.miner)
        except Exception as exc:
            async with self.lock:
                record.miner = None
                record.data = _current_data_for_offline_record(record.data)
                record.supports = {}
                record.error = str(exc)
                record.loading = False
            if background_persist:
                self._queue_miner_save(record)
            else:
                await self.store.save_miner(record)
            return
        async with self.lock:
            data = _merge_partial_static_data(data, _static_data_from_data(record.data))
            point = summarize_history_point(data)
            record.data = data
            record.supports = supports
            record.error = None
            record.loading = False
            record.last_seen = time.time()
            record.history.append(point)
            trim_history(record.history)
        if background_persist:
            self._queue_record_persist(record, point)
        else:
            await self._persist_record(record, point)

    async def _begin_data_update(self) -> None:
        async with self.lock:
            self._data_update_count += 1
            self.data_update_running = True
        await self._notify_status()

    async def _end_data_update(self) -> None:
        async with self.lock:
            self._data_update_count = max(0, self._data_update_count - 1)
            self.data_update_running = self._data_update_count > 0
        await self._notify_status()

    async def _ensure_miner_connections(self, records: Iterable[MinerRecord], limit: int = 16) -> None:
        semaphore = asyncio.Semaphore(limit)

        async def connect(record: MinerRecord) -> None:
            if record.miner is not None:
                return
            async with semaphore:
                try:
                    miner = await get_miner(record.ip)
                    if miner is None:
                        raise LookupError("No supported miner responded.")
                except Exception as exc:
                    async with self.lock:
                        record.error = str(exc)
                    await self.store.save_miner(record)
                    return
                async with self.lock:
                    record.miner = miner
                    record.data = _merge_partial_static_data(record.data, _miner_static_data(miner))
                    record.error = None

        await asyncio.gather(*(connect(record) for record in records))

    async def _load_persisted_state(self) -> None:
        if self._loaded:
            return
        await self.store.initialize()
        settings = await self.store.load_settings()
        miners = await self.store.load_miners()
        async with self.lock:
            self.ranges = settings.ranges
            self.range_names = self._normalized_range_names(settings.ranges, settings.range_names)
            self.enabled_ranges = self._normalized_enabled_ranges(settings.ranges, settings.enabled_ranges)
            self.live_scanning = settings.live_scanning
            self.live_data_updates = settings.live_data_updates
            self.scan_interval = settings.scan_interval
            self.scan_concurrency_limit = settings.scan_concurrency_limit
            self.data_update_interval = settings.data_update_interval
            self._set_background_data_concurrency_limit(settings.background_data_concurrency_limit)
            self.auto_clear_offline = settings.auto_clear_offline
            self.appearance = settings.appearance
            self.miners = miners
            self._loaded = True

    async def _persist_record(self, record: MinerRecord, point: HistoryPoint) -> None:
        await self.store.save_miner(record)
        await self.store.save_history_point(record.ip, point)

    async def _clear_offline_miners(self) -> None:
        async with self.lock:
            ips = [
                ip for ip, record in self.miners.items()
                if not record.loading and (record.error or not record.data or not record.last_seen)
            ]
            for ip in ips:
                self.miners.pop(ip, None)
        await self.store.delete_miners(ips)

    def _settings_unlocked(self) -> AppSettings:
        return AppSettings(
            ranges=list(self.ranges),
            range_names=self._normalized_range_names_unlocked(),
            enabled_ranges=self._normalized_enabled_ranges_unlocked(),
            live_scanning=self.live_scanning,
            live_data_updates=self.live_data_updates,
            scan_interval=self.scan_interval,
            scan_concurrency_limit=self.scan_concurrency_limit,
            data_update_interval=self.data_update_interval,
            background_data_concurrency_limit=self.background_data_concurrency_limit,
            auto_clear_offline=self.auto_clear_offline,
            appearance=self.appearance,
        )

    def _set_background_data_concurrency_limit(self, limit: int) -> None:
        if limit == self.background_data_concurrency_limit:
            return
        self.background_data_concurrency_limit = limit
        self._background_data_semaphore = asyncio.Semaphore(limit)

    def _wake_poll_loop(self) -> None:
        self._poll_wakeup.set()

    def _active_ranges_unlocked(self) -> list[str]:
        return self._active_ranges(self.ranges, self.enabled_ranges)

    def _normalized_enabled_ranges_unlocked(self) -> list[bool]:
        return self._normalized_enabled_ranges(self.ranges, self.enabled_ranges)

    def _normalized_range_names_unlocked(self) -> list[str]:
        return self._normalized_range_names(self.ranges, self.range_names)

    def _range_host_counts_unlocked(self) -> list[int]:
        return self._range_host_counts(self.ranges)

    def _visible_miner_records_unlocked(self) -> list[MinerRecord]:
        if not self.ranges:
            return list(self.miners.values())
        active_ranges = self._active_ranges_unlocked()
        return [
            record for record in self.miners.values()
            if active_ranges and ip_in_any_range(record.ip, active_ranges)
        ]

    @staticmethod
    def _sorted_miner_records(records: list[MinerRecord], sort_key: str, sort_direction: str) -> list[MinerRecord]:
        return sorted(
            records,
            key=lambda record: _miner_sort_value(record, sort_key),
            reverse=sort_direction == "desc",
        )

    @staticmethod
    def _miner_summary(records: list[MinerRecord]) -> dict[str, Any]:
        current = [record for record in records if _has_current_miner_data(record)]
        watts = [_numeric(record.data.get("wattage")) for record in current]
        temperatures = [_numeric(record.data.get("average_temperature")) for record in current]
        hashrates = [_numeric((record.data.get("hashrate") or {}).get("value")) for record in current]
        unit = next(
            (
                (record.data.get("hashrate") or {}).get("unit")
                for record in current
                if (record.data.get("hashrate") or {}).get("unit")
            ),
            "",
        )
        temperatures = [value for value in temperatures if value > 0]
        hashrates = [value for value in hashrates if value > 0]
        return {
            "total": len(records),
            "mining": sum(1 for record in current if record.data.get("is_mining")),
            "issues": sum(1 for record in records if _miner_error_count(record) > 0),
            "hashrate_value": sum(hashrates),
            "hashrate_unit": unit,
            "wattage": sum(watts),
            "average_temperature": (sum(temperatures) / len(temperatures)) if temperatures else None,
        }

    @staticmethod
    def _active_ranges(ranges: list[str], enabled_ranges: list[bool]) -> list[str]:
        enabled = ToolkitState._normalized_enabled_ranges(ranges, enabled_ranges)
        return [expression for expression, is_enabled in zip(ranges, enabled, strict=False) if is_enabled]

    @staticmethod
    def _normalized_range_names(ranges: list[str], range_names: list[str]) -> list[str]:
        return [
            str(range_names[index]).strip() if index < len(range_names) else ""
            for index, _ in enumerate(ranges)
        ]

    @staticmethod
    def _normalized_enabled_ranges(ranges: list[str], enabled_ranges: list[bool]) -> list[bool]:
        return [
            bool(enabled_ranges[index]) if index < len(enabled_ranges) else True
            for index, _ in enumerate(ranges)
        ]

    @staticmethod
    def _range_host_counts(ranges: list[str]) -> list[int]:
        return [estimate_range_size(expression) for expression in ranges]


class StaticChangeTracker:
    def __init__(self, root: Path) -> None:
        self.root = root

    def version(self) -> float:
        latest = 0.0
        for path in self.root.rglob("*"):
            if path.is_file():
                latest = max(latest, path.stat().st_mtime)
        return latest


def create_app(state: ToolkitState | None = None) -> FastAPI:
    app = FastAPI(title="ASIC RS Toolkit", docs_url=None, redoc_url=None)
    app.state.toolkit = state or ToolkitState()
    app.state.static_changes = StaticChangeTracker(STATIC_DIR)

    @app.on_event("startup")
    async def startup_state() -> None:
        await app.state.toolkit.start()

    @app.on_event("shutdown")
    async def shutdown_state() -> None:
        await app.state.toolkit.stop()

    @app.get("/api/status")
    async def status(
        page: int = 1,
        page_size: int = 10,
        sort_key: str = "ip",
        sort_direction: str = "asc",
    ) -> dict[str, Any]:
        return await app.state.toolkit.status(
            page=page,
            page_size=page_size,
            sort_key=sort_key,
            sort_direction=sort_direction,
        )

    @app.get("/api/history")
    async def history(ip: str) -> dict[str, Any]:
        try:
            return await app.state.toolkit.history(ip)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Miner not found") from exc

    @app.get("/api/ip-reports")
    async def ip_reports() -> dict[str, Any]:
        return await app.state.toolkit.ip_report_status()

    @app.post("/api/ip-reports")
    async def toggle_ip_reports(request: Request) -> dict[str, Any]:
        payload = await request.json()
        return await app.state.toolkit.toggle_ip_report_listener(bool(payload.get("running")))

    @app.get("/api/range-preview")
    async def range_preview(range: str) -> dict[str, Any]:
        try:
            return app.state.toolkit.range_preview(range)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/ranges")
    async def set_ranges(request: Request) -> dict[str, Any]:
        payload = await request.json()
        try:
            return await app.state.toolkit.set_ranges(
                payload.get("ranges", []),
                payload.get("enabled_ranges"),
                payload.get("range_names"),
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/scan")
    async def scan() -> dict[str, Any]:
        await app.state.toolkit.start_scan()
        return {"scan_running": True}

    @app.post("/api/live")
    async def live(request: Request) -> dict[str, Any]:
        payload = await request.json()
        enabled = payload.get("enabled")
        return await app.state.toolkit.toggle_live(
            scanning=bool(enabled) if enabled is not None else _optional_bool(payload.get("scanning")),
            data_updates=bool(enabled) if enabled is not None else _optional_bool(payload.get("data_updates")),
        )

    @app.post("/api/settings")
    async def settings(request: Request) -> dict[str, Any]:
        payload = await request.json()
        try:
            return await app.state.toolkit.update_settings(payload)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/refresh")
    async def refresh(request: Request) -> dict[str, Any]:
        payload = await request.json()
        return await app.state.toolkit.refresh_miners(payload.get("ips", []))

    @app.post("/api/config")
    async def config(request: Request) -> dict[str, Any]:
        payload = await request.json()
        try:
            return await app.state.toolkit.apply_to_ips(
                payload.get("ips", []),
                str(payload.get("action", "")),
                payload.get("payload", {}),
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/client-error")
    async def client_error(request: Request) -> dict[str, bool]:
        payload = await request.json()
        print("Client JavaScript error:")
        print(json.dumps(payload, indent=2, default=str))
        return {"ok": True}

    @app.websocket("/api/status-stream")
    async def status_stream(websocket: WebSocket) -> None:
        await websocket.accept()
        page = _query_int(websocket, "page", 1)
        page_size = _query_int(websocket, "page_size", 10)
        sort_key = websocket.query_params.get("sort_key", "ip")
        sort_direction = websocket.query_params.get("sort_direction", "asc")
        version = -1
        try:
            while True:
                version = await app.state.toolkit.wait_for_status_change(
                    version,
                    timeout=STATUS_STREAM_HEARTBEAT_SECONDS,
                )
                await websocket.send_json(await app.state.toolkit.status(
                    page=page,
                    page_size=page_size,
                    sort_key=sort_key,
                    sort_direction=sort_direction,
                ))
        except asyncio.CancelledError:
            return
        except (WebSocketDisconnect, OSError, RuntimeError):
            return

    @app.websocket("/api/live-reload")
    async def live_reload(websocket: WebSocket) -> None:
        await websocket.accept()
        version = app.state.static_changes.version()
        try:
            while True:
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(websocket.receive_text(), timeout=LIVE_RELOAD_HEARTBEAT_SECONDS)
                current = app.state.static_changes.version()
                if current > version:
                    version = current
                    await websocket.send_text("reload")
                else:
                    await websocket.send_text("heartbeat")
        except asyncio.CancelledError:
            return
        except (WebSocketDisconnect, OSError, RuntimeError):
            return

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.head("/")
    async def index_head() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/{path:path}")
    async def static_or_index(path: str) -> FileResponse:
        static_path = (STATIC_DIR / path).resolve()
        if static_path.is_file() and STATIC_DIR.resolve() in static_path.parents:
            return FileResponse(static_path)
        return FileResponse(STATIC_DIR / "index.html")

    return app


class ManagedToolkitServer:
    def __init__(self, host: str = "127.0.0.1", port: int = 8765) -> None:
        self.state = ToolkitState()
        self.app = create_app(self.state)
        self._socket = _bind_socket(host, port)
        actual_host, actual_port = self._socket.getsockname()[:2]
        self.url = f"http://{actual_host}:{actual_port}"
        self.config = uvicorn.Config(
            self.app,
            host=actual_host,
            port=actual_port,
            log_level="warning",
            access_log=False,
            lifespan="on",
            ws_ping_interval=None,
        )
        self.server = uvicorn.Server(self.config)
        self._stopped = False

    async def serve_forever(self) -> None:
        try:
            await self.server.serve(sockets=[self._socket])
        finally:
            await self.stop()

    async def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        self.server.should_exit = True
        await self.state.stop()

    def request_stop(self) -> None:
        self.server.should_exit = True


def run(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = True) -> None:
    asyncio.run(_run(host, port, open_browser))


async def _run(host: str, port: int, open_browser: bool) -> None:
    managed = ManagedToolkitServer(host, port)
    if open_browser:
        asyncio.create_task(_open_browser_later(managed.url))
    print(f"ASIC RS Toolkit running at {managed.url}")
    try:
        await managed.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        await managed.stop()


async def _open_browser_later(url: str) -> None:
    await asyncio.sleep(0.5)
    webbrowser.open(url)


def _bind_socket(host: str, port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(socket.SOMAXCONN)
    sock.set_inheritable(False)
    return sock


def _optional_bool(value: Any) -> bool | None:
    if value is None:
        return None
    return bool(value)


def _query_int(websocket: WebSocket, key: str, default: int) -> int:
    try:
        return int(websocket.query_params.get(key, default))
    except (TypeError, ValueError):
        return default


def _coerce_interval(value: Any, name: str) -> int:
    interval = int(value)
    if interval < 5:
        raise ValueError(f"{name} must be at least 5 seconds")
    return interval


def _coerce_scan_concurrency_limit(value: Any) -> int:
    limit = int(value)
    if limit < 1:
        raise ValueError("scan_concurrency_limit must be at least 1")
    return limit


def _coerce_background_data_concurrency_limit(value: Any) -> int:
    limit = int(value)
    if limit < 1:
        raise ValueError("background_data_concurrency_limit must be at least 1")
    return limit


def _coerce_appearance(value: Any) -> str:
    appearance = str(value)
    if appearance not in {"system", "light", "dark"}:
        raise ValueError("appearance must be system, light, or dark")
    return appearance


def _miner_static_data(miner: Any) -> dict[str, Any]:
    device_info = {
        key: value
        for key, value in {
            "make": _static_value(getattr(miner, "make", None)),
            "model": _static_value(getattr(miner, "model", None)),
            "firmware": _static_value(getattr(miner, "firmware", None)),
        }.items()
        if value not in (None, "")
    }
    return {"device_info": device_info} if device_info else {}


def _ip_report_row(ip: str, miner: Any) -> dict[str, str]:
    return {
        "ip": ip,
        "make": _static_value(getattr(miner, "make", None)) or "-",
        "model": _static_value(getattr(miner, "model", None)) or "-",
        "firmware": _static_value(getattr(miner, "firmware", None)) or "-",
    }


def _merge_partial_static_data(current: dict[str, Any], partial: dict[str, Any]) -> dict[str, Any]:
    if not partial:
        return current
    merged = dict(current)
    if isinstance(partial.get("device_info"), dict):
        existing = merged.get("device_info") if isinstance(merged.get("device_info"), dict) else {}
        merged["device_info"] = {**partial["device_info"], **existing}
    return merged


def _static_data_from_data(data: dict[str, Any]) -> dict[str, Any]:
    device_info = data.get("device_info")
    return {"device_info": device_info} if isinstance(device_info, dict) else {}


def _current_data_for_offline_record(data: dict[str, Any]) -> dict[str, Any]:
    return _static_data_from_data(data)


def _miner_sort_value(record: MinerRecord, sort_key: str) -> tuple[int, Any, str]:
    data = record.data
    device = data.get("device_info") if isinstance(data.get("device_info"), dict) else {}
    values = {
        "ip": record.ip,
        "make": device.get("make", ""),
        "model": device.get("model", ""),
        "hostname": data.get("hostname", ""),
        "firmware": device.get("firmware", ""),
        "hashrate": _numeric((data.get("hashrate") or {}).get("value")),
        "expected_hashrate": _numeric((data.get("expected_hashrate") or {}).get("value")),
        "wattage": _numeric(data.get("wattage")),
        "temperature": _numeric(data.get("average_temperature")),
        "efficiency": _numeric((data.get("efficiency") or {}).get("value") if isinstance(data.get("efficiency"), dict) else data.get("efficiency")),
        "uptime": _numeric_duration(data.get("uptime")),
        "chips": _numeric(data.get("working_chips")),
        "boards": len(data.get("hashboards") or []),
        "tuning": _numeric(data.get("tuning_percent")),
        "fans": len(data.get("fans") or []),
        "pool": _pool_url(data),
        "pool_user": _pool_user(data),
        "state": _miner_state_order(record),
    }
    value = values.get(sort_key, record.ip)
    missing = 1 if value in (None, "") else 0
    return (missing, value, record.ip)


def _has_current_miner_data(record: MinerRecord) -> bool:
    return bool(record.data) and not record.error and not record.loading


def _miner_error_count(record: MinerRecord) -> int:
    if record.error:
        return 1
    messages = record.data.get("messages") or []
    return sum(1 for message in messages if message.get("severity") in {"Error", "Warning"})


def _miner_state_order(record: MinerRecord) -> int:
    if record.loading:
        return 1
    if record.error:
        return 2
    if record.data.get("is_mining") is True:
        return 0
    if record.data.get("is_mining") is False:
        return 3
    return 4


def _numeric(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) else 0.0


def _numeric_duration(value: Any) -> float:
    if isinstance(value, int | float):
        return _numeric(value)
    if hasattr(value, "total_seconds"):
        return _numeric(value.total_seconds())
    return 0.0


def _pool_url(data: dict[str, Any]) -> str:
    pools = data.get("pools") or []
    if not pools:
        return ""
    active = next((pool for pool in pools if pool.get("active") or pool.get("is_active") or pool.get("current") or pool.get("selected")), pools[0])
    return str(active.get("url") or active.get("pool") or "")


def _pool_user(data: dict[str, Any]) -> str:
    pools = data.get("pools") or []
    if not pools:
        return ""
    active = next((pool for pool in pools if pool.get("active") or pool.get("is_active") or pool.get("current") or pool.get("selected")), pools[0])
    return str(active.get("username") or active.get("user") or active.get("worker") or "")


def _static_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str | int | float | bool):
        return value
    if hasattr(value, "value") and isinstance(value.value, str | int | float | bool):
        return value.value
    if hasattr(value, "name"):
        return str(value.name)
    return str(value)


def _seconds_until(deadline: float | None, now: float) -> int | None:
    if deadline is None:
        return None
    return max(0, math.ceil(deadline - now))
