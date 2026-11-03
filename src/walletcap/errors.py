# SPDX-License-Identifier: Apache-2.0
"""What the budget raises, and the exception that says a payment never left."""

from __future__ import annotations

from typing import ClassVar


class BudgetError(ValueError):
    """A request is malformed, or the ledger file cannot be trusted."""


class BudgetRefused(BudgetError):
    """Granting the reservation would break the budget."""

    reason: ClassVar[str] = "budget"


class OverBudget(BudgetRefused):
    """The rolling window's spend plus this amount would pass the cap."""

    reason: ClassVar[str] = "budget"


class OverPerPayment(BudgetRefused):
    """This one payment is larger than the per-payment max."""

    reason: ClassVar[str] = "per_payment"


class OverUses(BudgetRefused):
    """The rolling window already holds the most payments allowed."""

    reason: ClassVar[str] = "uses"


class BudgetRevoked(BudgetRefused):
    """The instrument's budget was revoked (frozen); nothing more may be reserved."""

    reason: ClassVar[str] = "revoked"


class BudgetWarning(UserWarning):
    """The budget file kept a limit tighter than the code asked for."""


class NotSent(Exception):
    """Raise inside ``with budget.pay(...)`` to say the payment never left the wallet.

    Its amount is given back. Any other exception keeps counting, because a
    payment that failed halfway may still have moved money.
    """
