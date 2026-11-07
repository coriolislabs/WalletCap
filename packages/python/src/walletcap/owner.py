# SPDX-License-Identifier: Apache-2.0
"""The owner's handle: set and change limits, freeze, and reconcile payments with evidence.

Void a payment that never left, settle one that paid, or void every payment of unknown outcome
that can no longer settle. The ``walletcap`` command is this handle.

In the library this is an API boundary, not a security one: any process that can open the file
can open an owner's handle. A budget the agent can't change runs under another OS user or
behind a service.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from walletcap._ledger import Ledger
from walletcap.budget import (
    UNSET,
    HeldPayment,
    Payment,
    PaymentRecord,
    Status,
    _limits,
    held_payment_of,
    payment_of,
    record_of,
    status_of,
)
from walletcap.errors import UsageError
from walletcap.money import (
    DOLLAR_UNITS,
    Micros,
    default_budget_path,
    expand_home,
    normalize_wallet,
    short_wallet,
    to_window_ms,
)

__all__ = ["BudgetLimits", "Owner", "VoidedPayment", "open_owner"]


@dataclass(frozen=True)
class BudgetLimits:
    """A budget's limits, as its owner set them."""

    wallet: str
    unit: str
    cap: Micros
    window_ms: int
    per_payment: Micros | None
    max_payments: int | None
    frozen: bool


@dataclass(frozen=True)
class VoidedPayment:
    """One payment the bulk release voided."""

    id: str
    amount: Micros


class Owner:
    """The owner's handle on a budget file. Open it with ``open_owner``."""

    def __init__(
        self,
        path: str | Path | None = None,
        *,
        create: bool = False,
        busy_timeout_seconds: float = 30.0,
    ) -> None:
        self._path = expand_home(path if path is not None else default_budget_path()).absolute()
        self._ledger = Ledger(self._path, busy_timeout_seconds=busy_timeout_seconds, create=create)

    @property
    def path(self) -> Path:
        """The budget file."""

        return self._path

    def budgets(self) -> list[BudgetLimits]:
        """Every budget in the file, by name."""

        return [
            BudgetLimits(
                row["wallet"],
                row["unit"],
                Micros(row["cap"]),
                row["window_ms"],
                None if row["per_payment"] is None else Micros(row["per_payment"]),
                row["max_payments"],
                row["frozen_at"] is not None,
            )
            for row in self._ledger.budgets()
        ]

    def status(self, wallet: str) -> Status:
        """What counts against ``wallet``'s budget now."""

        return status_of(self._ledger.status(wallet), self._path)

    def history(self, wallet: str, limit: int = 20) -> list[Payment]:
        """``wallet``'s newest payments first."""

        return [payment_of(row) for row in self._ledger.history(wallet, limit=limit)]

    def holds(self, wallet: str) -> list[HeldPayment]:
        """``wallet``'s held payments that still count, oldest first."""

        return [held_payment_of(row) for row in self._ledger.counting(wallet, held_only=True)]

    def payment(self, payment_id: str) -> PaymentRecord | None:
        """One payment by its id, or None."""

        row = self._ledger.payment(payment_id)
        return None if row is None else record_of(row)

    def set_limits(
        self,
        wallet: str,
        *,
        per_payment: object = UNSET,
        per_hour: object = None,
        per_day: object = None,
        per_week: object = None,
        cap: object = None,
        window: object = None,
        max_payments: object = UNSET,
    ) -> Status:
        """Set ``wallet``'s limits, up or down, creating its budget if it has none.

        A new budget needs a rolling limit. What was spent keeps counting: nothing resets. The
        window changes only while no payment counts.
        """

        name = normalize_wallet(wallet)
        limits = _limits(
            per_payment=per_payment,
            per_hour=per_hour,
            per_day=per_day,
            per_week=per_week,
            cap=cap,
            window=window,
            max_payments=max_payments,
        )
        if not limits:
            raise UsageError("set_limits needs a limit, like per_day='$150'")
        row = self._ledger.budget(name)
        if row is None:
            if "cap" not in limits:
                raise UsageError(
                    f"{short_wallet(name)} has no budget yet: give it a rolling limit too, "
                    "like --per-day 150"
                )
            self._ledger.create_budget(name, **limits)
        else:
            if row["unit"] not in DOLLAR_UNITS:
                raise UsageError(f"{short_wallet(name)}'s budget counts in {row['unit']}, not usd")
            self._ledger.set_limits(name, **limits)
        return self.status(name)

    def freeze(self, wallet: str) -> None:
        """Refuse every payment from ``wallet``, on every rail and in every process."""

        self._ledger.freeze(wallet)

    def unfreeze(self, wallet: str) -> None:
        """Allow payments again, after ``freeze`` or after an upgrade froze the budget."""

        self._ledger.unfreeze(wallet)

    def void(self, payment_id: str, *, evidence: str = "voided by its owner") -> PaymentRecord:
        """Void a held payment: evidence that it never moved money.

        Such as the chain showing its authorization unused past its expiry. It stops counting.
        A settled payment can't be voided.
        """

        return record_of(self._ledger.owner_void(payment_id, evidence=evidence))

    def settle(self, payment_id: str, *, evidence: str = "settled by its owner") -> PaymentRecord:
        """Settle a held or void payment: evidence that it paid, such as its transaction hash.

        It counts through one window from now, or from its settle-by time if that is later.
        """

        return record_of(self._ledger.owner_settle(payment_id, evidence=evidence))

    def void_unknown(self, wallet: str, *, older_than: object) -> list[VoidedPayment]:
        """The bulk release: void every held payment of unknown or refused outcome.

        Only those held at least ``older_than`` ago (``"24h"``, or milliseconds) that can no
        longer settle: their settle-by time has passed, or, with none, they were held for an
        x402 payment and are an hour and a minute old. Any other payment with no settle-by time,
        a transfer say, has no such bound: void it by id, with evidence. Only for payments its
        owner knows never left the wallet.
        """

        age = to_window_ms(older_than, "older_than")
        voided = self._ledger.void_unknown(
            wallet, age, evidence="voided by its owner: unknown or refused outcome"
        )
        return [VoidedPayment(row["payment"], Micros(row["amount"])) for row in voided]

    def close(self) -> None:
        """Nothing to close: the ledger opens a connection per operation."""

    def __enter__(self) -> Owner:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def open_owner(
    path: str | Path | None = None, *, create: bool = False, busy_timeout_seconds: float = 30.0
) -> Owner:
    """Open the budget file as its owner. ``create=True`` creates the file if it is missing."""

    return Owner(path, create=create, busy_timeout_seconds=busy_timeout_seconds)
