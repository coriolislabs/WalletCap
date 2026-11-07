# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import json
import math
import operator
import random
import shutil
import subprocess
import sys
from collections.abc import Callable
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
sys.path.insert(0, str(ROOT / "src"))

from walletcap.errors import UsageError  # noqa: E402
from walletcap.money import (  # noqa: E402
    DAY_MS,
    MAX_AMOUNT,
    Micros,
    normalize_wallet,
    to_micros,
    to_window_ms,
)

# The cases the JavaScript suite checks too (js/tests/money.test.mjs).
VECTORS: dict[str, Any] = json.loads(
    (REPO / "spec" / "vectors" / "money.json").read_text(encoding="utf-8")
)
NODE = shutil.which("node")


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda case: repr(case["input"])[:40])
def test_dollars_convert_as_the_shared_vectors_say(case: dict[str, Any]) -> None:
    if case.get("error"):
        with pytest.raises(UsageError):
            to_micros(case["input"])
    else:
        assert to_micros(case["input"]) == int(case["micros"])


@pytest.mark.skipif(NODE is None, reason="requires_node")
def test_both_languages_convert_the_same_floats() -> None:
    assert NODE is not None
    generator = random.Random(7)
    values = [generator.uniform(0, 1_000_000) for _ in range(5_000)]
    for digits in range(10):
        for _ in range(1_000):
            whole = generator.randint(0, 10**digits)
            values.append(float(f"{whole}.{generator.randint(0, 999_999) * 10 + 5:07d}"))
    script = (
        "const { toMicros } = await import(process.argv[1]); let text = '';"
        "process.stdin.on('data', chunk => { text += chunk; }).on('end', () => "
        "console.log(JSON.stringify(JSON.parse(text).map(value => String(toMicros(value))))));"
    )
    result = subprocess.run(
        [
            NODE,
            "--input-type=module",
            "-e",
            script,
            (REPO / "packages" / "js" / "dist" / "core" / "money.js").as_uri(),
        ],
        input=json.dumps(values),
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    javascript = [int(micros) for micros in json.loads(result.stdout)]
    python = [to_micros(value) for value in values]
    differ = [(v, p, j) for v, p, j in zip(values, python, javascript, strict=True) if p != j]
    assert differ == []


def test_inputs_of_thousands_of_digits_are_budget_errors() -> None:
    # Python refuses int() of a string over 4,300 digits with ValueError; 0.3.0 let it through.
    for window in ("9" * 5000 + "ms", "1" * 4400 + "h"):
        with pytest.raises(UsageError):
            to_window_ms(window)
    assert to_window_ms("0" * 5000 + "5ms") == 5
    with pytest.raises(UsageError, match="more than"):
        to_micros(Decimal("1" * 5000))
    with pytest.raises(UsageError, match="finer than a millionth"):
        to_micros(Decimal("1" * 5000 + "E-4995"))
    assert to_micros(Decimal("1" + "0" * 4999 + "E-4999")) == 1_000_000


def test_a_decimal_finer_than_a_micro_dollar_is_refused_at_any_precision() -> None:
    assert to_micros(Decimal("12.500000")) == 12_500_000
    assert to_micros(Decimal("1E+3")) == 1_000_000_000
    # 0.2.x multiplied at 28 digits, so this one rounded to exactly $1.
    for value in (Decimal("1.0000000000000000000000000001"), Decimal("1E-999999")):
        with pytest.raises(UsageError, match="finer than a millionth"):
            to_micros(value)
    with pytest.raises(UsageError, match="more than"):
        to_micros(Decimal("1E+999999"))


def test_a_mixed_case_evm_address_must_pass_eip55() -> None:
    assert normalize_wallet("0xd797ead28C38575FDf4fC523866287372340Ca02") == (
        "0xd797ead28c38575fdf4fc523866287372340ca02"
    )
    with pytest.raises(UsageError, match="EIP-55"):
        normalize_wallet("0xD797ead28C38575FDf4fC523866287372340Ca02")
    # All-uppercase hex has no checksum to verify and is still accepted.
    assert normalize_wallet("0xD797EAD28C38575FDF4FC523866287372340CA02") == (
        "0xd797ead28c38575fdf4fc523866287372340ca02"
    )


def test_solana_caip10_and_the_bare_address_are_one_wallet() -> None:
    address = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    assert normalize_wallet(address) == address
    assert normalize_wallet(f"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:{address}") == address


def test_window_numbers_are_milliseconds_in_both_languages() -> None:
    assert to_window_ms(DAY_MS) == DAY_MS
    assert to_window_ms("24h") == DAY_MS
    assert to_window_ms(90_000) == 90_000


# Arithmetic on an amount never comes back as a number walletcap would read as dollars: every
# operator returns a Micros, read as micro-dollars, or raises TypeError.


def test_the_reviewed_cases_fail_safe(tmp_path: Path) -> None:
    from walletcap import open_budget

    budget = open_budget(
        "0xd797ead28c38575fdf4fc523866287372340ca02",
        path=tmp_path / "b.sqlite",
        per_day="$150",
        create=True,
    )
    cap = budget.status().cap
    # 0.4's first Micros returned a bare int from //, read as dollars: $150 // 2 was $75,000,000.
    half = cap // 2
    assert isinstance(half, Micros)
    assert to_micros(half) == 75_000_000
    assert budget.check(half).ok
    assert not budget.check(half * 3).ok
    # It read 1.5 as 1 and "3" as 3.
    refusals: list[Callable[[], object]] = [
        lambda: cap * 1.5,
        lambda: cap + "3",
        lambda: cap + 1,
        lambda: 1 + cap,
    ]
    for refused in refusals:
        with pytest.raises(TypeError, match="refused"):
            refused()


_OPERATORS: dict[str, Callable[[Any, Any], Any]] = {
    "+": operator.add,
    "-": operator.sub,
    "*": operator.mul,
    "/": operator.truediv,
    "//": operator.floordiv,
    "%": operator.mod,
    "**": operator.pow,
    "<<": operator.lshift,
    ">>": operator.rshift,
    "&": operator.and_,
    "|": operator.or_,
    "^": operator.xor,
    "divmod": divmod,
}
_UNARY: dict[str, Callable[[Any], Any]] = {
    "-x": operator.neg,
    "+x": operator.pos,
    "abs": abs,
    "round": round,
    "round(-3)": lambda value: round(value, -3),
    "floor": math.floor,
    "ceil": math.ceil,
    "trunc": math.trunc,
    "~": operator.invert,
    "float": float,
}


def _operands() -> st.SearchStrategy[object]:
    return st.one_of(
        st.integers(0, 10**12).map(Micros),
        st.integers(-(10**6), 10**6),
        st.floats(allow_nan=False, allow_infinity=False, min_value=-1e6, max_value=1e6),
        st.decimals(
            allow_nan=False, allow_infinity=False, places=3, min_value=-1000, max_value=1000
        ),
        st.text(alphabet="0123456789", min_size=1, max_size=4),
        st.booleans(),
    )


def _expected(result: object) -> int | tuple[int, int]:
    if isinstance(result, tuple):
        return (int(result[0]), int(result[1]))
    assert isinstance(result, Micros), f"{result!r} is a {type(result).__name__}, not a Micros"
    return int(result)


@settings(max_examples=400, deadline=None)
@given(
    amount=st.integers(0, 10**12).map(Micros),
    other=_operands(),
    name=st.sampled_from(sorted(_OPERATORS)),
    swap=st.booleans(),
)
def test_every_operator_returns_a_micros_or_raises(
    amount: Micros, other: object, name: str, swap: bool
) -> None:
    left, right = (other, amount) if swap else (amount, other)
    try:
        result = _OPERATORS[name](left, right)
    except (TypeError, ZeroDivisionError):
        return
    # What the same arithmetic gives on the micro-dollars themselves: the result must be exactly
    # that, read as micro-dollars, and never a bare number read as dollars.
    plain = _OPERATORS[name](
        int(left) if isinstance(left, Micros) else left,
        int(right) if isinstance(right, Micros) else right,
    )
    if isinstance(result, tuple):
        assert all(isinstance(part, Micros) for part in result)
    else:
        assert isinstance(result, Micros), f"{name} gave {type(result).__name__}"
    assert _expected(result) == plain
    if isinstance(result, Micros) and 0 <= result <= MAX_AMOUNT:
        assert to_micros(result) == int(result)


@settings(max_examples=200, deadline=None)
@given(amount=st.integers(0, 10**12).map(Micros), name=st.sampled_from(sorted(_UNARY)))
def test_every_unary_operation_returns_a_micros_or_raises(amount: Micros, name: str) -> None:
    try:
        result = _UNARY[name](amount)
    except TypeError:
        return
    assert isinstance(result, Micros), f"{name} gave {type(result).__name__}"
    assert int(result) == _UNARY[name](int(amount))


def test_zero_adds_as_itself_so_sums_work() -> None:
    assert sum([Micros(5), Micros(7)]) == Micros(12)
    assert isinstance(sum([Micros(5), Micros(7)]), Micros)
    assert Micros(5) + 0 == Micros(5)
    with pytest.raises(TypeError):
        Micros(1.5)
    with pytest.raises(TypeError):
        Micros(True)
