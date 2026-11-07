# SPDX-License-Identifier: Apache-2.0
"""A ten-second demo with a fake payee: no wallet, chain, key or network.

Production code opens the budget with create=False; the owner creates it once
with walletcap set.
"""

from __future__ import annotations

import sys
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "packages" / "python" / "src"
sys.path.insert(0, str(SOURCE))
# An installed walletcap carries spec/*.sql inside it; a source checkout gets the copies the
# build would make.
for name in ("schema.sql", "upgrade.sql"):
    target = SOURCE / "walletcap" / "spec" / name
    target.parent.mkdir(exist_ok=True)
    target.write_bytes((ROOT / "spec" / name).read_bytes())

from walletcap import BudgetRefused, open_budget

PATH = Path(__file__).with_name("demo.sqlite")
WALLET = "0xd797ead28c38575fdf4fc523866287372340ca02"
TX = "0x" + "ab" * 32

PATH.unlink(missing_ok=True)

budget = open_budget(
    WALLET,
    path=PATH,
    per_payment="$0.05",
    per_day="$0.15",
    create=True,  # demo only
)


def attempt(target: object, label: str, amount: str) -> None:
    try:
        with target.pay(amount) as payment:  # type: ignore[attr-defined]
            payment.tx = TX
        print(f"paid     {label:<28} {amount}")
    except BudgetRefused as error:
        print(f"REFUSED  {label:<28} {amount}  ({error.code})")


print(f"Budget: {budget.status().summary}\n")
for amount in ("$0.05", "$0.05", "$0.05"):
    attempt(budget, "three small payments", amount)
attempt(budget, "past the per-payment cap", "$1.00")
attempt(budget, "past the rolling cap", "$0.05")

before_restart = budget.status().spent
budget.close()

messages: list[str] = []
with warnings.catch_warnings(record=True) as caught:
    warnings.simplefilter("always")
    restarted = open_budget(
        WALLET,
        path=PATH,
        per_payment="$2.50",
        per_day="$5",
    )
    messages = [str(item.message) for item in caught]
print(f"\nRestart asks for looser limits; stored limits stay: {messages[0] if messages else 'no warning'}")
print(f"Count before restart: {before_restart}; after restart: {restarted.status().spent}\n")
attempt(restarted, "the same $0.05 after restart", "$0.05")

final = open_budget(WALLET, path=PATH)
print(f"\nFinal: {final.status().summary}")
print(f"Result: {final.status().spent} of {final.status().cap} spent, {final.status().remaining} left.")
print(f"History: {len(final.history())} payments; the first is {final.history()[0].status}.")
final.close()
restarted.close()
