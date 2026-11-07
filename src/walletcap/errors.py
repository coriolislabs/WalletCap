# SPDX-License-Identifier: Apache-2.0
"""What the budget raises, and the exception that says a payment never left."""

from __future__ import annotations


class BudgetError(ValueError):
    """A request is malformed, or the ledger file cannot be trusted."""


class BudgetRefused(BudgetError):
    """The budget refused a payment.

    ``reason`` is one of ``"budget"`` (the rolling cap), ``"per_payment"``,
    ``"max_payments"`` and ``"frozen"``, the codes spec/schema.sql gives. ``source`` is
    ``"budget"`` for the owner's limits and ``"process"`` for the paying process's own.
    ``brief`` is the message without the ids of open payments or what their owner can do
    about them: what an agent is told.
    """

    def __init__(
        self, reason: str, message: str, *, brief: str | None = None, source: str = "budget"
    ) -> None:
        super().__init__(message)
        self.reason = reason
        self.brief = message if brief is None else brief
        self.source = source


class BudgetWarning(UserWarning):
    """The budget file kept a limit tighter than the code asked for."""


class PaymentNotRecorded(Exception):
    """The payment went through, but the budget could not record it as settled.

    It still counts as in flight. It is not a ``BudgetError``, so code that
    retries on a ``BudgetError`` does not pay twice. ``reservation_id`` names
    the payment, and ``cause`` (also ``__cause__``) is why it was not recorded.
    """

    def __init__(self, reservation_id: str, cause: BaseException | None = None) -> None:
        super().__init__(
            "the payment went through but could not be recorded as settled; "
            f"it still counts as in flight ({reservation_id})"
        )
        self.reservation_id = reservation_id
        self.cause = cause


class NotSent(Exception):
    """Raise inside ``with budget.pay(...)`` to say the payment never left the wallet.

    Its amount is given back. Any other exception keeps counting, because a
    payment that failed halfway may still have moved money.
    """
