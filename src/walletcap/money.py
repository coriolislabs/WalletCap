# SPDX-License-Identifier: Apache-2.0
"""Dollars in, micro-dollars out: amounts, rolling windows, wallet names and the default file.

A budget counts in micro-dollars, so one USDC base unit is one budget unit. The
JavaScript package parses and formats the same way, and computes the same
default budget file, so both languages find one budget.
"""

from __future__ import annotations

import math
import os
import re
import sys
from collections.abc import Mapping
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Final

from walletcap._keccak import keccak256
from walletcap.errors import BudgetError

MICROS: Final = 1_000_000
MAX_AMOUNT: Final = 10**15
"""The most a budget, a limit or one payment can be, in the budget's own unit.

10^15 is a billion dollars in micro-dollars, far below 2^63, so no sum of payments
can overflow SQLite's 64-bit integers.
"""
MAX_INTEGER: Final = 2**63 - 1
"""Times and counts only have to fit in SQLite's 64-bit integers."""
DOLLAR_UNITS: Final = frozenset({"usd", "usdc"})
HOUR_MS: Final = 3_600_000
DAY_MS: Final = 86_400_000
WEEK_MS: Final = 604_800_000

_DOLLARS = re.compile(r"^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(?:usdc?)?$", re.IGNORECASE)
_DURATION = re.compile(r"^(\d+)\s*(ms|s|m|h|d|w)$")
_DURATION_MS: Final = {"ms": 1, "s": 1_000, "m": 60_000, "h": HOUR_MS, "d": DAY_MS, "w": WEEK_MS}
_DURATION_WORDS: Final = {"hour": HOUR_MS, "day": DAY_MS, "week": WEEK_MS}
_EVM_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
_CAIP10_EVM = re.compile(r"^eip155:\d+:(0x[0-9a-fA-F]{40})$")
_CAIP10_SOLANA = re.compile(r"^solana:[1-9A-HJ-NP-Za-km-z]+:([1-9A-HJ-NP-Za-km-z]{32,44})$")
_IDENTIFIER = re.compile(r"^[A-Za-z0-9_.:@/-]{1,128}$")
_EXAMPLES = 'dollars, like "$12.50", 12.5 or "12.50 USDC"'


def to_micros(value: object, label: str = "amount") -> int:
    """Dollars as integer micro-dollars.

    Strings and Decimals are exact (``"$12.50"``, ``"12.50 USDC"``, ``"$1,000"``);
    ints are whole dollars; floats are dollars rounded to the nearest micro-dollar.
    """

    if isinstance(value, bool):
        raise BudgetError(f"{label} must be {_EXAMPLES}")
    if isinstance(value, int):
        micros = value * MICROS
    elif isinstance(value, float):
        if not math.isfinite(value) or value < 0:
            raise BudgetError(f"{label} must be a nonnegative number of dollars")
        rounded = Decimal(repr(value)).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
        micros = int(rounded * MICROS)
    elif isinstance(value, Decimal):
        if not value.is_finite():
            raise BudgetError(f"{label} must be {_EXAMPLES}")
        scaled = value * MICROS
        if scaled != scaled.to_integral_value():
            raise BudgetError(f"{label} is finer than a millionth of a dollar: {value}")
        micros = int(scaled)
    elif isinstance(value, str):
        match = _DOLLARS.match(value.strip())
        if match is None:
            raise BudgetError(f"{label} must be {_EXAMPLES}; got {value!r}")
        fraction = match.group(2) or ""
        if fraction[6:].strip("0"):
            raise BudgetError(f"{label} is finer than a millionth of a dollar: {value!r}")
        micros = int(match.group(1).replace(",", "")) * MICROS + int(fraction[:6].ljust(6, "0"))
    else:
        raise BudgetError(f"{label} must be {_EXAMPLES}")
    if micros < 0:
        raise BudgetError(f"{label} must be a nonnegative amount")
    if micros > MAX_AMOUNT:
        raise BudgetError(
            f"{label} is more than {format_usd(MAX_AMOUNT)}, the most a budget can hold"
        )
    return micros


def format_usd(micros: int) -> str:
    """``"$1,234.50"`` for 1_234_500_000 micro-dollars; sub-cent amounts keep their digits."""

    sign = "-" if micros < 0 else ""
    whole, part = divmod(abs(micros), MICROS)
    fraction = f"{part:06d}".rstrip("0").ljust(2, "0")
    return f"{sign}${whole:,}.{fraction}"


def format_amount(amount: int, unit: str) -> str:
    """An amount in a budget's own unit: dollars for usd and usdc, raw units otherwise."""

    return format_usd(amount) if unit in DOLLAR_UNITS else f"{amount} {unit}"


def to_window_ms(value: object, label: str = "window") -> int:
    """A rolling window as milliseconds: "24h", "7d", "30m", "day", or int milliseconds."""

    ms: int | None = None
    if isinstance(value, bool):
        ms = None
    elif isinstance(value, int):
        ms = value
    elif isinstance(value, str):
        text = value.strip().lower()
        match = _DURATION.match(text)
        if match is not None:
            ms = int(match.group(1)) * _DURATION_MS[match.group(2)]
        else:
            ms = _DURATION_WORDS.get(text)
    if ms is None or ms <= 0 or ms > MAX_INTEGER:
        raise BudgetError(
            f'{label} must be a duration like "24h", "7d" or "30m", or a positive number of milliseconds'
        )
    return ms


def format_window(ms: int) -> str:
    """``"24h"`` for a day (it rolls), then ``"7d"``, ``"30m"``, ``"90s"`` or ``"1500ms"``."""

    if ms == DAY_MS:
        return "24h"
    for suffix in ("d", "h", "m", "s"):
        if ms % _DURATION_MS[suffix] == 0:
            return f"{ms // _DURATION_MS[suffix]}{suffix}"
    return f"{ms}ms"


def _checksum_ok(address: str) -> bool:
    """Whether *address* has a valid EIP-55 mixed-case checksum."""

    hexpart = address[2:]
    digest = keccak256(hexpart.lower().encode("ascii")).hex()
    for index, char in enumerate(hexpart):
        if char.isdigit():
            continue
        if (int(digest[index], 16) >= 8) != char.isupper():
            return False
    return True


def normalize_wallet(wallet: object) -> str:
    """The name a wallet's budget is kept under.

    An EVM address, bare or CAIP-10, is lowercased, so a checksummed and a
    lowercase address, or the same address on two chains, share one budget. A
    mixed-case EVM address is checked against EIP-55 first. A Solana CAIP-10 is
    reduced to its address, so it and the bare address share one budget.
    """

    if not isinstance(wallet, str) or not wallet.strip():
        raise BudgetError("wallet is required: the address or account the money leaves from")
    name = wallet.strip()
    caip = _CAIP10_EVM.match(name)
    if caip is not None:
        name = caip.group(1)
    else:
        caip = _CAIP10_SOLANA.match(name)
        if caip is not None:
            name = caip.group(1)
    if _EVM_ADDRESS.match(name):
        hexpart = name[2:]
        if (
            hexpart != hexpart.lower()
            and hexpart != hexpart.upper()
            and not _checksum_ok(name)
        ):
            raise BudgetError(
                f"wallet {name!r} has an invalid EIP-55 checksum; "
                "copy the address or use all lowercase"
            )
        return name.lower()
    # A mistyped address must not quietly open a second budget.
    if name[:2].lower() == "0x":
        raise BudgetError(f"wallet {name!r} looks like an EVM address but is not 40 hex digits")
    if _IDENTIFIER.match(name) is None:
        raise BudgetError(
            "wallet must be an address or a plain name "
            "(letters, digits and _ . : @ / -, at most 128)"
        )
    return name


def short_wallet(wallet: str) -> str:
    """``0xd797…ca02`` for an EVM address; anything else as it is."""

    if re.fullmatch(r"0x[0-9a-f]{40}", wallet):
        return f"{wallet[:6]}…{wallet[-4:]}"
    return wallet


def default_budget_path(
    env: Mapping[str, str] | None = None,
    platform: str | None = None,
    home: Path | None = None,
) -> Path:
    """The budget file every process on this machine shares unless told otherwise.

    ``$WALLETCAP_PATH``, else the per-user state directory: the same
    path the JavaScript package computes.
    """

    env = os.environ if env is None else env
    platform = sys.platform if platform is None else platform
    home = Path.home() if home is None else home
    configured = env.get("WALLETCAP_PATH")
    if configured:
        return expand_home(configured, home)
    if platform == "win32":
        local = env.get("LOCALAPPDATA")
        base = Path(local) if local else home / "AppData" / "Local"
        return base / "walletcap" / "budget.sqlite"
    if platform == "darwin":
        return home / "Library" / "Application Support" / "walletcap" / "budget.sqlite"
    state = env.get("XDG_STATE_HOME")
    base = Path(state) if state and Path(state).is_absolute() else home / ".local" / "state"
    return base / "walletcap" / "budget.sqlite"


def expand_home(path: str | Path, home: Path | None = None) -> Path:
    text = str(path)
    if text == "~" or text.startswith("~/"):
        return (Path.home() if home is None else home) / text[2:]
    return Path(text)


def describe_limits(
    *,
    cap: int | None = None,
    window_ms: int | None = None,
    per_payment: int | None = None,
    max_uses: int | None = None,
) -> str:
    """``"$150.00 per 24h, at most $50.00 a payment, 20 payments per 24h"`` for the set fields."""

    parts = []
    if cap is not None and window_ms is not None:
        parts.append(f"{format_usd(cap)} per {format_window(window_ms)}")
    if per_payment is not None:
        parts.append(f"at most {format_usd(per_payment)} a payment")
    if max_uses is not None and window_ms is not None:
        parts.append(f"{max_uses} payments per {format_window(window_ms)}")
    return ", ".join(parts)


def limit_flags(
    *,
    cap: int | None = None,
    window_ms: int | None = None,
    per_payment: int | None = None,
    max_uses: int | None = None,
) -> str:
    """The CLI flags that would set these limits, for messages that tell an owner what to run."""

    def dollars(micros: int) -> str:
        return format_usd(micros)[1:].replace(",", "").removesuffix(".00")

    flags = []
    if cap is not None and window_ms is not None:
        named = {HOUR_MS: "--per-hour", DAY_MS: "--per-day", WEEK_MS: "--per-week"}.get(window_ms)
        if named:
            flags.append(f"{named} {dollars(cap)}")
        else:
            flags.append(f"--cap {dollars(cap)} --window {format_window(window_ms)}")
    if per_payment is not None:
        flags.append(f"--per-payment {dollars(per_payment)}")
    if max_uses is not None:
        flags.append(f"--max-payments {max_uses}")
    return " ".join(flags)
