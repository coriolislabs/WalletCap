# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import json
import random
import shutil
import subprocess
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from walletcap.errors import BudgetError  # noqa: E402
from walletcap.money import DAY_MS, normalize_wallet, to_micros, to_window_ms  # noqa: E402

# The cases the JavaScript suite checks too (js/tests/money.test.mjs).
VECTORS: dict[str, Any] = json.loads(
    (ROOT / "spec" / "vectors" / "money.json").read_text(encoding="utf-8")
)
NODE = shutil.which("node")


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda case: repr(case["input"])[:40])
def test_dollars_convert_as_the_shared_vectors_say(case: dict[str, Any]) -> None:
    if case.get("error"):
        with pytest.raises(BudgetError):
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
    result = subprocess.run(  # noqa: S603 - fixed local Node script
        [NODE, "--input-type=module", "-e", script, str(ROOT / "js" / "dist" / "money.js")],
        input=json.dumps(values),
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    javascript = [int(micros) for micros in json.loads(result.stdout)]
    differ = [(v, p, j) for v, p, j in zip(values, map(to_micros, values), javascript) if p != j]
    assert differ == []


def test_inputs_of_thousands_of_digits_are_budget_errors() -> None:
    # Python refuses int() of a string over 4,300 digits with ValueError; 0.3.0 let it through.
    for window in ("9" * 5000 + "ms", "1" * 4400 + "h"):
        with pytest.raises(BudgetError):
            to_window_ms(window)
    assert to_window_ms("0" * 5000 + "5ms") == 5
    with pytest.raises(BudgetError, match="more than"):
        to_micros(Decimal("1" * 5000))
    with pytest.raises(BudgetError, match="finer than a millionth"):
        to_micros(Decimal("1" * 5000 + "E-4995"))
    assert to_micros(Decimal("1" + "0" * 4999 + "E-4999")) == 1_000_000


def test_a_decimal_finer_than_a_micro_dollar_is_refused_at_any_precision() -> None:
    assert to_micros(Decimal("12.500000")) == 12_500_000
    assert to_micros(Decimal("1E+3")) == 1_000_000_000
    # 0.2.x multiplied at 28 digits, so this one rounded to exactly $1.
    for value in (Decimal("1.0000000000000000000000000001"), Decimal("1E-999999")):
        with pytest.raises(BudgetError, match="finer than a millionth"):
            to_micros(value)
    with pytest.raises(BudgetError, match="more than"):
        to_micros(Decimal("1E+999999"))


def test_a_mixed_case_evm_address_must_pass_eip55() -> None:
    assert normalize_wallet("0xd797ead28C38575FDf4fC523866287372340Ca02") == (
        "0xd797ead28c38575fdf4fc523866287372340ca02"
    )
    with pytest.raises(BudgetError, match="EIP-55"):
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
