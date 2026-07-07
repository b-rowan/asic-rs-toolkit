from __future__ import annotations

from dataclasses import dataclass
from itertools import product


@dataclass(frozen=True)
class OctetRange:
    start: int
    end: int

    @classmethod
    def parse(cls, value: str) -> "OctetRange":
        value = value.strip()
        if not value:
            raise ValueError("Octets cannot be empty.")
        if "-" in value:
            left, right = value.split("-", 1)
            start = _parse_octet(left)
            end = _parse_octet(right)
        else:
            start = end = _parse_octet(value)
        if start > end:
            raise ValueError(f"Invalid octet range {value!r}: start is greater than end.")
        return cls(start, end)

    def expand(self) -> range:
        return range(self.start, self.end + 1)

    def as_pyasic_arg(self) -> str:
        if self.start == self.end:
            return str(self.start)
        return f"{self.start}-{self.end}"


def _parse_octet(value: str) -> int:
    value = value.strip()
    if not value.isdigit():
        raise ValueError(f"Invalid octet {value!r}; use numbers from 0 to 255.")
    octet = int(value)
    if octet < 0 or octet > 255:
        raise ValueError(f"Invalid octet {value!r}; use numbers from 0 to 255.")
    return octet


def parse_range_expression(expression: str) -> tuple[OctetRange, OctetRange, OctetRange, OctetRange]:
    parts = expression.strip().split(".")
    if len(parts) != 4:
        raise ValueError("Use four dot-separated octets, for example 192.168.1-2.1-254.")
    return tuple(OctetRange.parse(part) for part in parts)  # type: ignore[return-value]


def estimate_range_size(expression: str) -> int:
    octets = parse_range_expression(expression)
    total = 1
    for octet in octets:
        total *= octet.end - octet.start + 1
    return total


def iter_ips(expression: str, limit: int | None = None) -> list[str]:
    octets = parse_range_expression(expression)
    ips: list[str] = []
    for values in product(*(octet.expand() for octet in octets)):
        ips.append(".".join(str(value) for value in values))
        if limit is not None and len(ips) >= limit:
            break
    return ips
