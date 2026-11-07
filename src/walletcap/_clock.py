# SPDX-License-Identifier: Apache-2.0
"""The ledger's clock: the system clock, in whole milliseconds.

No option changes it, so every process that opens a budget counts with the same
time. walletcap's own tests replace ``source`` here; this module is private and
not exported.
"""

from __future__ import annotations

import time
from collections.abc import Callable

source: Callable[[], float] = time.time
"""Seconds since the epoch. Only walletcap's tests replace it."""


def now_ms() -> int:
    """Milliseconds since the epoch."""

    return int(source() * 1000)
