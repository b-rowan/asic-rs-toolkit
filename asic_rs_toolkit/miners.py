from __future__ import annotations

import time
from collections import deque
from collections.abc import AsyncIterator
from inspect import isawaitable
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pyasic_rs import FanConfig, Miner, MinerFactory, Pool, PoolGroup, ScalingConfig, TuningConfig
from pyasic_rs.data import DataField

from .ranges import parse_range_expression

HISTORY_SECONDS = 30 * 60
DEFAULT_SCAN_CONCURRENCY_LIMIT = 1000
DEFAULT_BACKGROUND_DATA_CONCURRENCY_LIMIT = 250
SUPPORT_FLAGS = (
    "supports_restart",
    "supports_pause",
    "supports_resume",
    "supports_fan_config",
    "supports_pools_config",
    "supports_set_power_limit",
    "supports_tuning_config",
    "supports_scaling_config",
    "supports_set_tuning_percent",
    "supports_set_fault_light",
    "supports_read_logs",
    "supports_change_password",
    "supports_factory_reset",
    "supports_upgrade_firmware",
    "supports_temperature_config",
)


class AppSettings(BaseModel):
    ranges: list[str] = Field(default_factory=list)
    range_names: list[str] = Field(default_factory=list)
    enabled_ranges: list[bool] = Field(default_factory=list)
    live_scanning: bool = False
    live_data_updates: bool = False
    scan_interval: int = 30
    scan_concurrency_limit: int = Field(default=DEFAULT_SCAN_CONCURRENCY_LIMIT, ge=1)
    data_update_interval: int = 30
    background_data_concurrency_limit: int = Field(default=DEFAULT_BACKGROUND_DATA_CONCURRENCY_LIMIT, ge=1)
    auto_clear_offline: bool = False
    appearance: Literal["system", "light", "dark"] = "system"


class HistoryPoint(BaseModel):
    timestamp: float
    hashrate_value: Any = None
    hashrate_unit: str | None = None
    wattage: Any = None
    temperature: Any = None
    efficiency: Any = None
    errors: int = 0
    warnings: int = 0
    is_mining: Any = None


class MinerRecord(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    ip: str
    miner: Miner | None = Field(default=None, exclude=True)
    data: dict[str, Any] = Field(default_factory=dict)
    supports: dict[str, bool] = Field(default_factory=dict)
    error: str | None = None
    loading: bool = False
    last_seen: float | None = None
    history: deque[HistoryPoint] = Field(default_factory=deque)

    def snapshot(self) -> dict[str, Any]:
        return {
            "ip": self.ip,
            "data": self.data,
            "supports": self.supports,
            "error": self.error,
            "loading": self.loading,
            "last_seen": self.last_seen,
            "history_count": len(self.history),
            "latest_history": self.history[-1].model_dump() if self.history else None,
        }


def factory_for_expression(
    expression: str,
    concurrency_limit: int = DEFAULT_SCAN_CONCURRENCY_LIMIT,
) -> MinerFactory:
    return factory_for_expressions([expression], concurrency_limit)


def factory_for_expressions(
    expressions: list[str],
    concurrency_limit: int = DEFAULT_SCAN_CONCURRENCY_LIMIT,
) -> MinerFactory:
    factory = MinerFactory()
    for expression in expressions:
        octets = parse_range_expression(expression)
        factory.with_octets(*(octet.as_pyasic_arg() for octet in octets))
    return factory.with_concurrent_limit(concurrency_limit)


async def stream_scan_expression(
    expression: str,
    concurrency_limit: int = DEFAULT_SCAN_CONCURRENCY_LIMIT,
) -> AsyncIterator[Miner]:
    async for miner in factory_for_expression(expression, concurrency_limit).scan_stream():
        yield miner


async def stream_scan_progress_expression(
    expression: str,
    concurrency_limit: int = DEFAULT_SCAN_CONCURRENCY_LIMIT,
) -> AsyncIterator[tuple[str, Miner | None]]:
    async for ip, miner in factory_for_expression(expression, concurrency_limit).scan_stream_with_ip():
        yield str(ip), miner


async def stream_scan_progress_expressions(
    expressions: list[str],
    concurrency_limit: int = DEFAULT_SCAN_CONCURRENCY_LIMIT,
) -> AsyncIterator[tuple[str, Miner | None]]:
    async for ip, miner in factory_for_expressions(expressions, concurrency_limit).scan_stream_with_ip():
        yield str(ip), miner


async def get_miner(ip: str) -> Miner | None:
    return await MinerFactory().get_miner(ip)


async def revalidate_miner(miner: Miner) -> bool:
    revalidate = getattr(miner, "revalidate", None)
    if revalidate is None:
        return True
    result = revalidate()
    if isawaitable(result):
        result = await result
    return bool(result)


async def collect_data(miner: Miner) -> tuple[dict[str, Any], dict[str, bool]]:
    data_obj = await miner.get_data(exclude=[DataField.Chips])
    if hasattr(data_obj, "model_dump"):
        data = data_obj.model_dump()
    elif isinstance(data_obj, dict):
        data = data_obj
    else:
        data = {"raw": str(data_obj)}

    supports = {flag: bool(getattr(miner, flag, False)) for flag in SUPPORT_FLAGS}
    return data, supports


def summarize_history_point(data: dict[str, Any]) -> HistoryPoint:
    hashrate = data.get("hashrate") or {}
    messages = data.get("messages") or []
    return HistoryPoint(
        timestamp=time.time(),
        hashrate_value=hashrate.get("value"),
        hashrate_unit=hashrate.get("unit"),
        wattage=data.get("wattage"),
        temperature=data.get("average_temperature"),
        efficiency=data.get("efficiency"),
        errors=sum(1 for message in messages if message.get("severity") == "Error"),
        warnings=sum(1 for message in messages if message.get("severity") == "Warning"),
        is_mining=data.get("is_mining"),
    )


def trim_history(history: deque[HistoryPoint]) -> None:
    cutoff = time.time() - HISTORY_SECONDS
    while history and history[0].timestamp < cutoff:
        history.popleft()


async def apply_action(miner: Miner, action: str, payload: dict[str, Any]) -> str:
    username = payload.get("username")
    password = payload.get("password")
    if username or password:
        await miner.set_auth(username or "", password or "")

    match action:
        case "restart":
            _require(miner, "supports_restart")
            await miner.restart()
        case "pause":
            _require(miner, "supports_pause")
            await miner.pause()
        case "resume":
            _require(miner, "supports_resume")
            await miner.resume()
        case "fault_light":
            _require(miner, "supports_set_fault_light")
            await miner.set_fault_light(bool(payload.get("enabled")))
        case "power_limit":
            _require(miner, "supports_set_power_limit")
            await miner.set_power_limit(int(payload["watts"]))
        case "tuning_percent":
            _require(miner, "supports_set_tuning_percent")
            await miner.set_tuning_percent(int(payload["percent"]))
        case "fan_manual":
            _require(miner, "supports_fan_config")
            await miner.set_fan_config(FanConfig.manual(int(payload["speed"])))
        case "fan_auto":
            _require(miner, "supports_fan_config")
            idle_speed = payload.get("idle_speed")
            await miner.set_fan_config(
                FanConfig.auto(
                    float(payload["target_temp"]),
                    None if idle_speed in (None, "") else int(idle_speed),
                )
            )
        case "tuning_power":
            _require(miner, "supports_tuning_config")
            await miner.set_tuning_config(TuningConfig.power(float(payload["watts"])))
        case "tuning_hashrate":
            _require(miner, "supports_tuning_config")
            await miner.set_tuning_config(TuningConfig.hashrate(float(payload["hashrate"])))
        case "tuning_mode":
            _require(miner, "supports_tuning_config")
            await miner.set_tuning_config(TuningConfig.mode(str(payload["mode"])))
        case "scaling":
            _require(miner, "supports_scaling_config")
            await miner.set_scaling_config(
                ScalingConfig(
                    int(payload["step"]),
                    int(payload["minimum"]),
                    payload.get("shutdown"),
                    _optional_float(payload.get("shutdown_duration")),
                )
            )
        case "pools":
            _require(miner, "supports_pools_config")
            groups = [
                PoolGroup(
                    name=group.get("name") or "default",
                    quota=int(group.get("quota") or 1),
                    pools=[
                        Pool(
                            url=pool["url"],
                            username=pool.get("username", ""),
                            password=pool.get("password", ""),
                        )
                        for pool in group.get("pools", [])
                        if pool.get("url")
                    ],
                )
                for group in payload.get("groups", [])
            ]
            await miner.set_pools_config(groups)
        case _:
            raise ValueError(f"Unsupported action {action!r}.")
    return f"{action} applied"


def _require(miner: Miner, flag: str) -> None:
    if not getattr(miner, flag, False):
        raise ValueError(f"This miner does not expose {flag}.")


def _optional_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    return float(value)
