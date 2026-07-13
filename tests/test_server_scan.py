import asyncio
import json
import tempfile
from datetime import timedelta
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

from asic_rs_toolkit.miners import AppSettings, MinerRecord
from asic_rs_toolkit.server import ManagedToolkitServer, ToolkitState, _seconds_until
from asic_rs_toolkit.storage import ToolkitStore


class FakeMiner:
    def __init__(self, ip: str) -> None:
        self.ip = ip
        self.supports_restart = True


async def fake_stream_scan(expression: str, concurrency_limit: int = 1000):
    await asyncio.sleep(0)
    yield "10.0.0.1", None
    await asyncio.sleep(0)
    yield "10.0.0.2", FakeMiner("10.0.0.2")
    await asyncio.sleep(0)
    yield "10.0.0.3", FakeMiner("10.0.0.3")


async def fake_expression_miner_stream(expression: str, concurrency_limit: int = 1000):
    await asyncio.sleep(0)
    ip = {
        "10.0.0.1": "10.0.0.2",
        "10.0.1.1-2": "10.0.1.2",
    }[expression]
    yield ip, FakeMiner(ip)


async def fake_collect_data(miner: FakeMiner):
    return (
        {
            "ip": str(miner.ip),
            "hashrate": {"value": 1, "unit": "TH/s"},
            "messages": [],
            "is_mining": True,
        },
        {"supports_restart": True},
    )


async def fake_get_miner(ip: str):
    await asyncio.sleep(0)
    return FakeMiner(ip)


async def slow_collect_data(miner: FakeMiner):
    await asyncio.sleep(0.05)
    return await fake_collect_data(miner)


class ToolkitScanTests(IsolatedAsyncioTestCase):
    def test_managed_server_disables_protocol_websocket_ping_timeout(self) -> None:
        managed = ManagedToolkitServer(port=0)
        try:
            self.assertIsNone(managed.config.ws_ping_interval)
        finally:
            managed._socket.close()

    def test_seconds_until_rounds_future_deadlines_up(self) -> None:
        self.assertEqual(_seconds_until(10.1, 10), 1)
        self.assertEqual(_seconds_until(10, 10), 0)

    async def test_scan_worker_records_streamed_miners(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = ToolkitState(ToolkitStore(Path(directory) / "toolkit.sqlite3"))
            await state.start()
            await state.set_ranges(["10.0.0.1-3"])

            with (
                patch("asic_rs_toolkit.server.stream_scan_progress_expression", fake_stream_scan),
                patch("asic_rs_toolkit.server.collect_data", fake_collect_data),
            ):
                await state.start_scan()
                for _ in range(50):
                    status = await state.status()
                    if not status["scan_running"]:
                        break
                    await asyncio.sleep(0.01)

            status = await state.status()
            await state.stop()

            self.assertIsNone(status["last_scan_error"])
            self.assertEqual(status["scan_progress"]["total"], 3)
            self.assertEqual(status["scan_progress"]["scanned"], 3)
            self.assertEqual(status["scan_progress"]["found"], 2)
            self.assertEqual([miner["ip"] for miner in status["miners"]], ["10.0.0.2", "10.0.0.3"])
            self.assertIsNotNone(status["miners"][0]["latest_history"])

    async def test_scan_uses_only_enabled_ranges(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = ToolkitState(ToolkitStore(Path(directory) / "toolkit.sqlite3"))
            await state.start()
            await state.set_ranges(["10.0.0.1", "10.0.1.1-2"], [False, True])

            with (
                patch("asic_rs_toolkit.server.stream_scan_progress_expression", fake_expression_miner_stream),
                patch("asic_rs_toolkit.server.collect_data", fake_collect_data),
            ):
                await state.start_scan()
                for _ in range(50):
                    status = await state.status()
                    if not status["scan_running"]:
                        break
                    await asyncio.sleep(0.01)

            status = await state.status()
            await state.stop()

            self.assertEqual(status["ranges"], ["10.0.0.1", "10.0.1.1-2"])
            self.assertEqual(status["enabled_ranges"], [False, True])
            self.assertEqual(status["range_hosts"], [1, 2])
            self.assertEqual([miner["ip"] for miner in status["miners"]], ["10.0.1.2"])

    async def test_scan_uses_configured_concurrency_limit(self) -> None:
        seen_limits: list[int] = []

        async def fake_limited_stream(expression: str, concurrency_limit: int = 1000):
            seen_limits.append(concurrency_limit)
            await asyncio.sleep(0)
            yield "10.0.0.2", FakeMiner("10.0.0.2")

        with tempfile.TemporaryDirectory() as directory:
            state = ToolkitState(ToolkitStore(Path(directory) / "toolkit.sqlite3"))
            await state.start()
            await state.set_ranges(["10.0.0.1-2"])
            await state.update_settings({"scan_concurrency_limit": 7})

            with (
                patch("asic_rs_toolkit.server.stream_scan_progress_expression", fake_limited_stream),
                patch("asic_rs_toolkit.server.collect_data", fake_collect_data),
            ):
                await state.start_scan()
                for _ in range(50):
                    status = await state.status()
                    if not status["scan_running"]:
                        break
                    await asyncio.sleep(0.01)

            status = await state.status()
            await state.stop()

            self.assertEqual(status["settings"]["scan_concurrency_limit"], 7)
            self.assertEqual(seen_limits, [7])

    async def test_status_serializes_timedelta_miner_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = ToolkitState(ToolkitStore(Path(directory) / "toolkit.sqlite3"))
            await state.start()
            record = await state._record_for_ip("10.0.0.2")
            record.data = {"uptime": timedelta(seconds=65)}

            status = await state.status()
            await state.stop()

            json.dumps(status)
            self.assertIn("uptime", status["miners"][0]["data"])

    async def test_status_hides_miners_outside_enabled_ranges(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = ToolkitState(ToolkitStore(Path(directory) / "toolkit.sqlite3"))
            await state.start()
            await state.set_ranges(["10.0.0.1-2", "10.0.1.1-2"], [True, False])
            await state._record_for_ip("10.0.0.2")
            await state._record_for_ip("10.0.1.2")
            await state._record_for_ip("10.0.2.2")

            status = await state.status()
            await state.stop()

            self.assertEqual([miner["ip"] for miner in status["miners"]], ["10.0.0.2"])

    async def test_live_data_updates_reconnect_persisted_miners_on_startup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = ToolkitStore(Path(directory) / "toolkit.sqlite3")
            await store.initialize()
            await store.save_settings(AppSettings(live_data_updates=True, data_update_interval=5))
            await store.save_miner(MinerRecord(ip="10.0.0.2", data={"is_mining": False}))

            state = ToolkitState(store)
            with (
                patch("asic_rs_toolkit.server.get_miner", fake_get_miner),
                patch("asic_rs_toolkit.server.collect_data", fake_collect_data),
            ):
                await state.start()
                for _ in range(50):
                    status = await state.status()
                    miner = status["miners"][0]
                    if miner["data"].get("hashrate", {}).get("value") == 1:
                        break
                    await asyncio.sleep(0.01)

            status = await state.status()
            await state.stop()

            self.assertEqual(status["miners"][0]["data"]["hashrate"]["value"], 1)
            self.assertIsNone(status["miners"][0]["error"])

    async def test_status_reports_data_update_running_during_poll(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = ToolkitState(ToolkitStore(Path(directory) / "toolkit.sqlite3"))
            await state.start()

            with (
                patch("asic_rs_toolkit.server.get_miner", fake_get_miner),
                patch("asic_rs_toolkit.server.collect_data", fake_collect_data),
            ):
                await state.refresh_miners(["10.0.0.2"])

            with patch("asic_rs_toolkit.server.collect_data", slow_collect_data):
                task = asyncio.create_task(state.refresh_miners(["10.0.0.2"]))
                for _ in range(50):
                    status = await state.status()
                    if status["data_update_running"]:
                        break
                    await asyncio.sleep(0.001)
                await task

            final_status = await state.status()
            await state.stop()

            self.assertTrue(status["data_update_running"])
            self.assertFalse(final_status["data_update_running"])
