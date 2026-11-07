# SPDX-License-Identifier: Apache-2.0
"""Dollars in, micro-dollars out: amounts, rolling windows, wallet names and the default file.

A budget counts in micro-dollars, so one USDC base unit is one budget unit. The
JavaScript package parses and formats the same way, and computes the same
default budget file, so both languages find one budget. spec/vectors/money.json
holds the cases both test suites check.
"""

from __future__ import annotations

import math
import os
import re
import sys
from collections.abc import Mapping
from decimal import Decimal
from pathlib import Path
from typing import Final, NoReturn, SupportsIndex

from walletcap._keccak import keccak256
from walletcap.errors import UsageError


def _refused(operation: str) -> TypeError:
    return TypeError(
        f"{operation} is refused: a Micros is micro-dollars, and walletcap reads a bare int, "
        "float, Decimal or str as dollars, so the result could be read a million times too "
        "large. Add or subtract Micros, multiply or floor-divide by an int count."
    )


class Micros:
    """An amount in micro-dollars: every amount walletcap returns is one.

    ``to_micros`` reads a ``Micros`` as micro-dollars and a bare ``int`` as whole dollars, as
    JavaScript reads a bigint and a number. So no arithmetic on a ``Micros`` gives a bare number
    that would be read back as dollars: each operation returns a ``Micros`` or raises
    ``TypeError``, whichever side the other operand is on. A ``Micros`` is its own type, not an
    ``int``: as an ``int`` subclass, ``1.5 * amount`` or ``Decimal(2) * amount`` would compute as
    plain numbers before ``Micros`` could refuse them.

    - ``Micros + Micros``, ``Micros - Micros``: a ``Micros``. Zero adds as itself, so ``sum()``
      works.
    - ``Micros * int``, ``int * Micros``, ``Micros // int``, ``Micros % int``,
      ``divmod(Micros, int)``, ``round()``, ``abs()``, unary ``-`` and ``+``,
      ``math.floor``/``ceil``/``trunc``: a ``Micros``.
    - Anything else raises ``TypeError``: a bare int, float, Decimal or str added or subtracted
      (it could be dollars); a float or Decimal factor; true division; ``Micros // Micros`` and
      ``Micros % Micros``; powers; bit operations; and ``float(amount)``.

    It compares and hashes like the int of micro-dollars, so ``Micros(5) == 5``.
    ``int(amount)`` and ``str(amount)`` give that number of micro-dollars: walletcap would read
    the int as dollars, so don't pass it back.
    """

    __slots__ = ("_value",)
    _value: int

    def __init__(self, value: object = 0) -> None:
        if isinstance(value, Micros):
            value = value._value
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError(f"Micros takes an int of micro-dollars, not {type(value).__name__}")
        object.__setattr__(self, "_value", int(value))

    def __setattr__(self, name: str, value: object) -> NoReturn:
        raise AttributeError("a Micros can't be changed")

    def __reduce__(self) -> tuple[type[Micros], tuple[int]]:
        return (Micros, (self._value,))

    @staticmethod
    def _amount(other: object, operation: str) -> int:
        # Another Micros, or zero, which is zero in either unit.
        if isinstance(other, Micros):
            return other._value
        if type(other) is int and other == 0:
            return 0
        raise _refused(operation)

    @staticmethod
    def _count(other: object, operation: str) -> int:
        if type(other) is not int:
            raise _refused(operation)
        return other

    def __int__(self) -> int:
        return self._value

    def __bool__(self) -> bool:
        return self._value != 0

    def __hash__(self) -> int:
        return hash(self._value)

    @staticmethod
    def _comparable(other: object) -> int | None:
        if isinstance(other, Micros):
            return other._value
        if isinstance(other, int):
            return int(other)
        return None

    def __eq__(self, other: object) -> bool:
        value = self._comparable(other)
        return NotImplemented if value is None else self._value == value

    # Ordering takes another Micros, or zero, as + and - do. A bare number would be read as
    # micro-dollars here and as dollars by every call that takes an amount, so min(cap, 150)
    # would hand set_limits $150 where the cap was $100: it is refused instead.
    def __lt__(self, other: object) -> bool:
        return self._value < self._amount(other, "comparing a Micros with a number")

    def __le__(self, other: object) -> bool:
        return self._value <= self._amount(other, "comparing a Micros with a number")

    def __gt__(self, other: object) -> bool:
        return self._value > self._amount(other, "comparing a Micros with a number")

    def __ge__(self, other: object) -> bool:
        return self._value >= self._amount(other, "comparing a Micros with a number")

    def __add__(self, other: object) -> Micros:
        return Micros(self._value + self._amount(other, "adding a number to a Micros"))

    def __radd__(self, other: object) -> Micros:
        return Micros(self._amount(other, "adding a Micros to a number") + self._value)

    def __sub__(self, other: object) -> Micros:
        return Micros(self._value - self._amount(other, "subtracting a number from a Micros"))

    def __rsub__(self, other: object) -> Micros:
        return Micros(self._amount(other, "subtracting a Micros from a number") - self._value)

    def __mul__(self, other: object) -> Micros:
        return Micros(self._value * self._count(other, "multiplying a Micros by a non-int"))

    def __rmul__(self, other: object) -> Micros:
        return Micros(self._count(other, "multiplying a Micros by a non-int") * self._value)

    def __floordiv__(self, other: object) -> Micros:
        return Micros(self._value // self._count(other, "floor-dividing a Micros by a non-int"))

    def __rfloordiv__(self, other: object) -> NoReturn:
        raise _refused("dividing by a Micros")

    def __mod__(self, other: object) -> Micros:
        return Micros(self._value % self._count(other, "a Micros modulo a non-int"))

    def __rmod__(self, other: object) -> NoReturn:
        raise _refused("a number modulo a Micros")

    def __divmod__(self, other: object) -> tuple[Micros, Micros]:
        divisor = self._count(other, "divmod of a Micros by a non-int")
        quotient, remainder = divmod(self._value, divisor)
        return Micros(quotient), Micros(remainder)

    def __rdivmod__(self, other: object) -> NoReturn:
        raise _refused("divmod by a Micros")

    def __truediv__(self, other: object) -> NoReturn:
        raise _refused("true division of a Micros")

    def __rtruediv__(self, other: object) -> NoReturn:
        raise _refused("true division by a Micros")

    def __pow__(self, other: object, modulo: object = None) -> NoReturn:
        raise _refused("a power of a Micros")

    def __rpow__(self, other: object, modulo: object = None) -> NoReturn:
        raise _refused("a power with a Micros")

    def __lshift__(self, other: object) -> NoReturn:
        raise _refused("a bit shift of a Micros")

    def __rlshift__(self, other: object) -> NoReturn:
        raise _refused("a bit shift by a Micros")

    def __rshift__(self, other: object) -> NoReturn:
        raise _refused("a bit shift of a Micros")

    def __rrshift__(self, other: object) -> NoReturn:
        raise _refused("a bit shift by a Micros")

    def __and__(self, other: object) -> NoReturn:
        raise _refused("a bit operation on a Micros")

    def __rand__(self, other: object) -> NoReturn:
        raise _refused("a bit operation on a Micros")

    def __or__(self, other: object) -> NoReturn:
        raise _refused("a bit operation on a Micros")

    def __ror__(self, other: object) -> NoReturn:
        raise _refused("a bit operation on a Micros")

    def __xor__(self, other: object) -> NoReturn:
        raise _refused("a bit operation on a Micros")

    def __rxor__(self, other: object) -> NoReturn:
        raise _refused("a bit operation on a Micros")

    def __invert__(self) -> NoReturn:
        raise _refused("inverting the bits of a Micros")

    def __neg__(self) -> Micros:
        return Micros(-self._value)

    def __pos__(self) -> Micros:
        return Micros(self._value)

    def __abs__(self) -> Micros:
        return Micros(abs(self._value))

    def __round__(self, ndigits: SupportsIndex | None = None) -> Micros:
        return Micros(round(self._value, ndigits))

    def __trunc__(self) -> Micros:
        return Micros(self._value)

    def __floor__(self) -> Micros:
        return Micros(self._value)

    def __ceil__(self) -> Micros:
        return Micros(self._value)

    def __float__(self) -> NoReturn:
        raise _refused("float() of a Micros")

    def __format__(self, spec: str) -> str:
        return format(self._value, spec)

    def __repr__(self) -> str:
        return f"Micros({self._value})"

    def __str__(self) -> str:
        return str(self._value)


Dollars = str | int | float | Decimal | Micros
"""An amount: a string ("$12.50", "12.50 USDC"), an int of whole dollars, a float or Decimal of
dollars, or a Micros of micro-dollars."""

Window = str | int
"""A rolling window: "24h", "7d", "30m", "day", or an int of milliseconds."""

MICROS: Final = 1_000_000
MAX_AMOUNT: Final = Micros(10**15)
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

_SPACE: Final = " \t\n\v\f\r"
# Digits in the most an amount, or a time or count, can be. Longer digit strings are refused
# before int() reads them: Python refuses int() of a string over 4,300 digits with ValueError.
_AMOUNT_DIGITS: Final = len(str(MAX_AMOUNT))
_INTEGER_DIGITS: Final = len(str(MAX_INTEGER))
# ASCII only, in both languages: no other digits or spaces, so "١٢" and "12\x85" are refused.
_DOLLARS = re.compile(
    r"\$?[ \t\n\v\f\r]*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]+))?[ \t\n\v\f\r]*"
    r"(?:[Uu][Ss][Dd][Cc]?)?"
)
_DURATION = re.compile(r"([0-9]+)[ \t\n\v\f\r]*(ms|s|m|h|d|w)")
_FLOAT = re.compile(r"([0-9]+)(?:\.([0-9]*))?(?:e([+-]?[0-9]+))?")
_DURATION_MS: Final = {"ms": 1, "s": 1_000, "m": 60_000, "h": HOUR_MS, "d": DAY_MS, "w": WEEK_MS}
_DURATION_WORDS: Final = {"hour": HOUR_MS, "day": DAY_MS, "week": WEEK_MS}
_EVM_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
_CAIP10_EVM = re.compile(r"eip155:[0-9]+:(0x[0-9a-fA-F]{40})")
_CAIP10_SOLANA = re.compile(r"solana:[1-9A-HJ-NP-Za-km-z]+:([1-9A-HJ-NP-Za-km-z]{32,44})")
_IDENTIFIER = re.compile(r"[A-Za-z0-9_.:@/-]{1,128}")
_EXAMPLES = 'dollars, like "$12.50", 12.5 or "12.50 USDC"'


def strip_ascii(text: str) -> str:
    """``text`` without leading or trailing ASCII whitespace; JavaScript trims the same set."""

    return text.strip(_SPACE)


def _pow10(exponent: int) -> int:
    """10 to a nonnegative power, as an int."""

    return int(10**exponent)


def _float_micros(value: float) -> int:
    """A float of dollars as micro-dollars, as the JavaScript package converts a number.

    ``repr()`` is the shortest decimal that reads back as the same float, the same
    digits JavaScript's ``String()`` gives, and it is rounded half up to the
    micro-dollar.
    """

    match = _FLOAT.fullmatch(repr(abs(value)))  # abs: -0.0 is 0, as String(-0) is "0"
    if match is None:
        raise UsageError(f"{value!r} is not a number of dollars")
    fraction = match.group(2) or ""
    coefficient = int(match.group(1) + fraction)
    shift = int(match.group(3) or 0) - len(fraction) + 6
    if shift >= 0:
        return coefficient * _pow10(shift)
    micros, remainder = divmod(coefficient, _pow10(-shift))
    return micros + (1 if 2 * remainder >= _pow10(-shift) else 0)


def _decimal_micros(value: Decimal, label: str) -> int:
    """An exact Decimal of dollars as micro-dollars, refusing anything finer.

    It reads the digits, so no int() is built from more digits than an amount
    can have, however many the Decimal holds.
    """

    _, digits, exponent = value.as_tuple()
    if not isinstance(exponent, int) or not any(digits):
        return 0
    shift = exponent + 6  # the micro-dollars are the digits times 10**shift
    whole = len(digits) + shift  # how many digits the whole micro-dollars take
    if whole > _AMOUNT_DIGITS:
        return int(MAX_AMOUNT) + 1  # more than the most a budget can hold
    if shift >= 0:
        return int("".join(map(str, digits))) * _pow10(shift)
    if any(digits[max(whole, 0) :]):
        raise UsageError(f"{label} is finer than a millionth of a dollar: {value}")
    return int("".join(map(str, digits[:whole]))) if whole > 0 else 0


def to_micros(value: object, label: str = "amount") -> Micros:
    """Dollars as integer micro-dollars.

    Strings and Decimals are exact (``"$12.50"``, ``"12.50 USDC"``, ``"$1,000"``);
    ints are whole dollars; floats are dollars, read as the shortest decimal that
    gives the float back and rounded half up to the micro-dollar, as JavaScript
    reads a number. A ``Micros`` is already micro-dollars.
    """

    if isinstance(value, bool):
        raise UsageError(f"{label} must be {_EXAMPLES}")
    if isinstance(value, Micros):
        micros = int(value)
    elif isinstance(value, int):
        micros = value * MICROS
    elif isinstance(value, float):
        if not math.isfinite(value) or value < 0:
            raise UsageError(f"{label} must be a nonnegative number of dollars")
        micros = _float_micros(value)
    elif isinstance(value, Decimal):
        if not value.is_finite():
            raise UsageError(f"{label} must be {_EXAMPLES}")
        if value < 0:
            raise UsageError(f"{label} must be a nonnegative amount")
        micros = _decimal_micros(value, label)
    elif isinstance(value, str):
        match = _DOLLARS.fullmatch(strip_ascii(value))
        if match is None:
            raise UsageError(f"{label} must be {_EXAMPLES}; got {value!r}")
        fraction = match.group(2) or ""
        if fraction[6:].strip("0"):
            raise UsageError(f"{label} is finer than a millionth of a dollar: {value!r}")
        whole = match.group(1).replace(",", "").lstrip("0") or "0"
        if len(whole) > _AMOUNT_DIGITS:
            micros = int(MAX_AMOUNT) + 1  # more than the most a budget can hold
        else:
            micros = int(whole) * MICROS + int(fraction[:6].ljust(6, "0"))
    else:
        raise UsageError(f"{label} must be {_EXAMPLES}")
    if int(micros) < 0:
        raise UsageError(f"{label} must be a nonnegative amount")
    if int(micros) > int(MAX_AMOUNT):
        raise UsageError(
            f"{label} is more than {format_usd(MAX_AMOUNT)}, the most a budget can hold"
        )
    return Micros(micros)


def format_usd(micros: int | Micros) -> str:
    """``"$1,234.50"`` for 1_234_500_000 micro-dollars; sub-cent amounts keep their digits."""

    value = int(micros)
    sign = "-" if value < 0 else ""
    whole, part = divmod(abs(value), MICROS)
    fraction = f"{part:06d}".rstrip("0").ljust(2, "0")
    return f"{sign}${whole:,}.{fraction}"


def format_amount(amount: int | Micros, unit: str) -> str:
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
        text = strip_ascii(value).lower()
        match = _DURATION.fullmatch(text)
        if match is not None:
            count = match.group(1).lstrip("0") or "0"
            if len(count) <= _INTEGER_DIGITS:
                ms = int(count) * _DURATION_MS[match.group(2)]
        else:
            ms = _DURATION_WORDS.get(text)
    if ms is None or ms <= 0 or ms > MAX_INTEGER:
        raise UsageError(
            f'{label} must be a duration like "24h", "7d" or "30m", '
            "or a positive number of milliseconds"
        )
    return ms


_AGE_PARTS = 2  # "3d 4h", not "3d 4h 12m 5s"
_UPPER_NIBBLE = 8  # EIP-55: a letter is uppercase where the hash's nibble is 8 or more


def format_age(ms: int) -> str:
    """How long ago, roughly: ``"3d 4h"``, ``"4h 12m"``, ``"12m 5s"`` or ``"5s"``."""

    units = (("d", DAY_MS), ("h", HOUR_MS), ("m", 60_000), ("s", 1_000))
    parts: list[str] = []
    left = max(ms, 0)
    for suffix, size in units:
        if not parts and left < size and suffix != "s":
            continue
        parts.append(f"{left // size}{suffix}")
        left %= size
        if len(parts) == _AGE_PARTS:
            break
    return " ".join(parts)


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
        if (int(digest[index], 16) >= _UPPER_NIBBLE) != char.isupper():
            return False
    return True


def normalize_wallet(wallet: object) -> str:
    """The name a wallet's budget is kept under.

    An EVM address, bare or CAIP-10, is lowercased, so a checksummed and a
    lowercase address, or the same address on two chains, share one budget. A
    mixed-case EVM address is checked against EIP-55 first. A Solana CAIP-10 is
    reduced to its address, so it and the bare address share one budget.
    """

    if not isinstance(wallet, str) or not strip_ascii(wallet):
        raise UsageError("wallet is required: the address or account the money leaves from")
    name = strip_ascii(wallet)
    caip = _CAIP10_EVM.fullmatch(name)
    if caip is not None:
        name = caip.group(1)
    else:
        caip = _CAIP10_SOLANA.fullmatch(name)
        if caip is not None:
            name = caip.group(1)
    if _EVM_ADDRESS.fullmatch(name):
        hexpart = name[2:]
        if hexpart != hexpart.lower() and hexpart != hexpart.upper() and not _checksum_ok(name):
            raise UsageError(
                f"wallet {name!r} has an invalid EIP-55 checksum; "
                "copy the address or use all lowercase"
            )
        return name.lower()
    # A mistyped address must not quietly open a second budget.
    if name[:2].lower() == "0x":
        raise UsageError(f"wallet {name!r} looks like an EVM address but is not 40 hex digits")
    if _IDENTIFIER.fullmatch(name) is None:
        raise UsageError(
            "wallet must be an address or a plain name "
            "(letters, digits and _ . : @ / -, at most 128)"
        )
    return name


def stored_wallet_name(name: str) -> str:
    """The canonical name for a budget a 0.2.x file holds under some other spelling.

    ``normalize_wallet``'s rule without its checks: a checksummed, uppercase or
    CAIP-10 EVM address becomes the lowercase address, even with a bad checksum,
    and a Solana CAIP-10 becomes its address, so every spelling merges into one
    budget.
    """

    solana = _CAIP10_SOLANA.fullmatch(name)
    if solana is not None:
        return solana.group(1)
    evm = _CAIP10_EVM.fullmatch(name)
    address = evm.group(1) if evm is not None else name
    return address.lower() if _EVM_ADDRESS.fullmatch(address) else name


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
    cap: int | Micros | None = None,
    window_ms: int | None = None,
    per_payment: int | Micros | None = None,
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
    cap: int | Micros | None = None,
    window_ms: int | None = None,
    per_payment: int | Micros | None = None,
    max_uses: int | None = None,
) -> str:
    """The CLI flags that would set these limits, for messages that tell an owner what to run."""

    def dollars(micros: int | Micros) -> str:
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
