# SPDX-License-Identifier: Apache-2.0
"""One Python payer in the race (race.mjs).

It holds, then settles, voids, notes or bounds, over and over, until it is killed. Refusals and
lock waits are expected; anything else is a failure.
"""

import random
import sys
import time
from datetime import timedelta

from walletcap import BudgetRefused, BudgetUnavailable, Micros, open_budget

path, wallet = sys.argv[1:3]
budget = open_budget(wallet, path=path)
while True:
    amount = Micros(random.randint(1, 5) * 1_000_000)  # noqa: S311 - a race, not a secret
    is_open = random.random() < 0.1  # noqa: S311
    within = timedelta(milliseconds=random.randint(200, 1700))  # noqa: S311
    try:
        hold = budget.hold(amount) if is_open else budget.hold(amount, settles_within=within)
    except (BudgetRefused, BudgetUnavailable):
        time.sleep(0.005)
        continue
    try:
        if is_open:
            hold.settles_within(within)
        roll = random.random()  # noqa: S311
        if roll < 0.5:
            hold.settle(tx="0x" + f"{random.randint(0, 0xFFFFFF):064x}")  # noqa: S311
        elif roll < 0.7:
            hold.void(reason="race: not sent")
        elif roll < 0.85:
            hold.note("unknown", "race")
    except BudgetUnavailable:
        continue
