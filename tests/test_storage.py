import tempfile
import time
from pathlib import Path
from unittest import IsolatedAsyncioTestCase

import aiosqlite

from asic_rs_toolkit.miners import AppSettings, HistoryPoint, MinerRecord
from asic_rs_toolkit.storage import ToolkitStore


class ToolkitStoreTests(IsolatedAsyncioTestCase):
    async def test_settings_and_miner_data_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = ToolkitStore(Path(directory) / "toolkit.sqlite3")
            await store.initialize()

            await store.save_settings(
                AppSettings(
                    ranges=["10.0.0.1-2"],
                    live_scanning=True,
                    live_data_updates=True,
                    scan_interval=15,
                    data_update_interval=20,
                    auto_clear_offline=True,
                    appearance="dark",
                )
            )
            timestamp = time.time()
            point = HistoryPoint(timestamp=timestamp, hashrate_value=10, hashrate_unit="TH/s")
            record = MinerRecord(
                ip="10.0.0.2",
                data={"is_mining": True},
                supports={"supports_restart": True},
                last_seen=timestamp,
            )
            record.history.append(point)

            await store.save_miner(record)
            await store.save_history_point(record.ip, point)

            settings = await store.load_settings()
            miners = await store.load_miners()

            self.assertEqual(settings.ranges, ["10.0.0.1-2"])
            self.assertTrue(settings.live_scanning)
            self.assertTrue(settings.live_data_updates)
            self.assertEqual(settings.scan_interval, 15)
            self.assertEqual(settings.data_update_interval, 20)
            self.assertTrue(settings.auto_clear_offline)
            self.assertEqual(settings.appearance, "dark")
            self.assertEqual(miners["10.0.0.2"].data["is_mining"], True)
            self.assertEqual(miners["10.0.0.2"].supports["supports_restart"], True)
            self.assertEqual(miners["10.0.0.2"].history[0].hashrate_value, 10)

    async def test_legacy_live_updates_setting_loads_as_both_live_modes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = ToolkitStore(Path(directory) / "toolkit.sqlite3")
            await store.initialize()
            async with aiosqlite.connect(store.path) as db:
                await db.execute(
                    "INSERT INTO settings (key, value) VALUES ('app', ?)",
                    ('{"ranges":["10.0.0.1"],"live_updates":true,"poll_interval":15}',),
                )
                await db.commit()

            settings = await store.load_settings()

            self.assertTrue(settings.live_scanning)
            self.assertTrue(settings.live_data_updates)
            self.assertEqual(settings.scan_interval, 15)
            self.assertEqual(settings.data_update_interval, 15)
