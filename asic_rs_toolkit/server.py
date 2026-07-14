from __future__ import annotations

import asyncio
import contextlib
import json
import math
import socket
import time
import webbrowser
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse

from .miners import (
    AppSettings,
    DEFAULT_SCAN_CONCURRENCY_LIMIT,
    HistoryPoint,
    MinerRecord,
    apply_action,
    collect_data,
    get_miner,
    revalidate_miner,
    summarize_history_point,
    stream_scan_progress_expression,
    trim_history,
)
from .ranges import estimate_range_size, ip_in_any_range, iter_ips
from .storage import ToolkitStore

STATIC_DIR = Path(__file__).with_name("static")
STATUS_STREAM_HEARTBEAT_SECONDS = 1.0
LIVE_RELOAD_HEARTBEAT_SECONDS = 15.0


class MinerOfflineError(RuntimeError):
    pass


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
        self.auto_clear_offline = False
        self.appearance = "system"
        self._next_scan_at: float | None = None
        self._next_data_at: float | None = None
        self._poll_task: asyncio.Task[None] | None = None
        self._scan_task: asyncio.Task[None] | None = None
        self._background_data_tasks: set[asyncio.Task[None]] = set()
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
            for task in (self._scan_task, self._poll_task, *self._background_data_tasks)
            if task and not task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def status(self) -> dict[str, Any]:
        async with self.lock:
            now = time.monotonic()
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
                "miners": [
                    record.snapshot()
                    for record in sorted(self._visible_miner_records_unlocked(), key=lambda item: item.ip)
                ],
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
        sentinel = object()
        queue: asyncio.Queue[Any] = asyncio.Queue()
        data_semaphore = asyncio.Semaphore(16)
        tasks = [
            asyncio.create_task(
                self._enqueue_scan_results(expression, concurrency_limit, queue, sentinel),
                name=f"miner-scan-range-{index}",
            )
            for index, expression in enumerate(ranges)
        ]
        try:
            pending = len(tasks)
            errors: list[str] = []
            while pending:
                item = await queue.get()
                if item is sentinel:
                    pending -= 1
                elif isinstance(item, Exception):
                    errors.append(str(item))
                else:
                    ip, miner = item
                    await self._record_scanned_ip(ip, miner)
                    if miner is not None:
                        record = await self._record_found_miner(miner)
                        self._schedule_scan_data_poll(record, data_semaphore)
                    else:
                        await self._record_missing_miner(ip)
            if errors:
                async with self.lock:
                    self.last_scan_error = "; ".join(errors)
                await self._notify_status()
        except asyncio.CancelledError:
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            raise
        except Exception as exc:
            async with self.lock:
                self.last_scan_error = str(exc)
            await self._notify_status()
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            async with self.lock:
                self.scan_running = False
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

    async def _enqueue_scan_results(
        self,
        expression: str,
        concurrency_limit: int,
        queue: asyncio.Queue[Any],
        sentinel: object,
    ) -> None:
        try:
            async for ip, miner in stream_scan_progress_expression(expression, concurrency_limit):
                await queue.put((ip, miner))
        except Exception as exc:
            await queue.put(exc)
        finally:
            await queue.put(sentinel)

    async def _record_found_miner(self, miner: Any) -> MinerRecord:
        ip = str(miner.ip)
        async with self.lock:
            record = self.miners.get(ip) or MinerRecord(ip=ip)
            record.miner = miner
            record.data = _merge_partial_static_data(record.data, _miner_static_data(miner))
            record.error = None
            record.loading = True
            self.miners[ip] = record
        await self.store.save_miner(record)
        await self._notify_status()
        return record

    async def _record_scanned_ip(self, ip: str, miner: Any | None) -> None:
        async with self.lock:
            self.scan_progress["scanned"] = min(
                self.scan_progress["total"],
                self.scan_progress["scanned"] + 1,
            )
            if miner is not None:
                self.scan_progress["found"] += 1
            self.scan_progress["current_ip"] = ip
        await self._notify_status()

    async def _record_missing_miner(self, ip: str) -> None:
        async with self.lock:
            record = self.miners.get(ip)
            if record is None:
                return
            record.miner = None
            record.data = _current_data_for_offline_record(record.data)
            record.supports = {}
            record.loading = False
            record.error = "No supported miner responded."
        await self.store.save_miner(record)
        await self._notify_status()

    def _schedule_scan_data_poll(self, record: MinerRecord, semaphore: asyncio.Semaphore) -> None:
        task = asyncio.create_task(
            self._poll_scan_record(record, semaphore),
            name=f"miner-scan-data-{record.ip}",
        )
        self._background_data_tasks.add(task)
        task.add_done_callback(self._background_data_tasks.discard)

    async def _poll_scan_record(self, record: MinerRecord, semaphore: asyncio.Semaphore) -> None:
        await self._begin_data_update()
        try:
            await self._poll_record(record, semaphore)
        finally:
            await self._end_data_update()
        async with self.lock:
            auto_clear = self.auto_clear_offline
        if auto_clear:
            await self._clear_offline_miners()

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

    async def _poll_record(self, record: MinerRecord, semaphore: asyncio.Semaphore) -> None:
        if record.miner is None:
            return
        async with semaphore:
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
            auto_clear_offline=self.auto_clear_offline,
            appearance=self.appearance,
        )

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
    async def status() -> dict[str, Any]:
        return await app.state.toolkit.status()

    @app.get("/api/history")
    async def history(ip: str) -> dict[str, Any]:
        try:
            return await app.state.toolkit.history(ip)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Miner not found") from exc

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
        version = -1
        try:
            while True:
                version = await app.state.toolkit.wait_for_status_change(
                    version,
                    timeout=STATUS_STREAM_HEARTBEAT_SECONDS,
                )
                await websocket.send_json(await app.state.toolkit.status())
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
