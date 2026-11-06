# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from walletcap.errors import BudgetError
from walletcap.money import DAY_MS, normalize_wallet, to_window_ms


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
