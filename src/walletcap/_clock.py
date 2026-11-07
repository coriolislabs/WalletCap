# SPDX-License-Identifier: Apache-2.0
"""The ledger reads its clock in SQL (spec/schema.sql, ``wc_clock``): SQLite's julianday('now').

No option changes it. walletcap's own tests move it by setting ``source`` here, which this
private module keeps for them: every connection the ledger opens while ``source`` is set
answers julianday('now') from it, and no other connection does.
"""

from __future__ import annotations

import sqlite3
import time
from collections.abc import Callable

source: Callable[[], float] | None = None
"""Seconds since the epoch. Only walletcap's tests set it."""


def install(connection: sqlite3.Connection) -> None:
    """Internal: give a new connection the test clock, when a test set one.

    The ledger opens a connection per transaction, and SQLite keeps 'now' fixed for a whole
    statement, so the test clock is read once per connection: a moving one can't give one
    statement two times.
    """

    if source is None:
        return
    read: list[float] = []

    def julianday(*args: object) -> float:
        if args != ("now",):
            raise ValueError("walletcap's test clock answers julianday('now') only")
        if not read:
            read.append(time.time() if source is None else source())
        return read[0] * 1000 / 86_400_000 + 2_440_587.5

    connection.create_function("julianday", -1, julianday, deterministic=False)
