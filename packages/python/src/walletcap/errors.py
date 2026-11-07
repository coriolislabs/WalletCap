# SPDX-License-Identifier: Apache-2.0
"""What walletcap raises.

Four exceptions with no common base, so code that retries on one of them never retries a
``PaymentNotRecorded`` and pays twice. None of them is a ``ValueError``. The JavaScript
package has the same four.
"""

from __future__ import annotations

from typing import Literal

RefusalCode = Literal[
    "budget", "per_payment", "max_payments", "frozen", "asset", "timeout", "terms"
]
"""Which limit refused: the ledger's ``budget`` (the rolling cap), ``per_payment``,
``max_payments`` and ``frozen``, or an adapter's ``asset``, ``timeout`` and ``terms``."""

RefusalSource = Literal["budget", "process"]
"""Whose limit refused: the owner's (``budget``) or the paying process's own (``process``)."""


class BudgetUnavailable(Exception):  # noqa: N818 - the same name as in JavaScript
    """The budget can't be read or written.

    There is no budget file or no budget for the wallet, the file isn't a walletcap budget or a
    newer walletcap wrote it, its SQLite is older than 3.37.0, another process held its write
    lock past the busy timeout, or an I/O error. Nothing was paid.
    """


class BudgetRefused(Exception):  # noqa: N818 - the same name as in JavaScript
    """The budget refused a payment, and nothing was paid.

    ``code`` is the ledger's ``"budget"`` (the rolling cap), ``"per_payment"``,
    ``"max_payments"`` or ``"frozen"``, or an adapter's ``"asset"``, ``"timeout"`` or
    ``"terms"``. ``source`` is ``"budget"`` for the owner's limits and ``"process"`` for the
    paying process's own. ``brief`` is what an agent is told: the message without the ids of
    open payments or what their owner can do about them.
    """

    def __init__(
        self,
        code: RefusalCode,
        message: str,
        *,
        brief: str | None = None,
        source: RefusalSource = "budget",
    ) -> None:
        super().__init__(message)
        self.code: RefusalCode = code
        self.brief = message if brief is None else brief
        self.source: RefusalSource = source


class PaymentNotRecorded(Exception):  # noqa: N818 - the same name as in JavaScript
    """A payment that went through, or may have, couldn't be recorded: it still counts as in flight.

    Don't pay again. ``payment_id`` names the payment, and ``cause`` (also ``__cause__``) is
    why it couldn't be recorded.
    """

    def __init__(
        self, payment_id: str, cause: BaseException | None = None, *, settled: bool = True
    ) -> None:
        super().__init__(
            "the payment went through but could not be recorded as settled; "
            f"it still counts as in flight ({payment_id})"
            if settled
            else "what happened to the payment could not be recorded; "
            f"it still counts as in flight ({payment_id})"
        )
        self.payment_id = payment_id
        self.cause = cause


class UsageError(Exception):
    """The call itself is wrong, and nothing was paid.

    A malformed amount, wallet or option, a settle-by time that isn't after now, a move a
    payment's state doesn't allow (voiding a settled payment), a payment that doesn't exist, or
    an id already used for another payment.

    When a hold names an id already in the ledger, ``payment_id`` and ``payment_state`` say which
    payment that is and where it stands; otherwise they are None.
    """

    def __init__(
        self,
        message: str,
        *,
        payment_id: str | None = None,
        payment_state: Literal["held", "settled", "void"] | None = None,
    ) -> None:
        super().__init__(message)
        self.payment_id = payment_id
        self.payment_state = payment_state


class NotSent(Exception):  # noqa: N818 - says what happened, not that something failed
    """Raise inside ``with budget.pay(...)`` to say the payment never left the wallet.

    The payment is voided. Any other exception keeps it counting, because a payment that
    failed halfway may still have moved money.
    """


class BudgetWarning(UserWarning):
    """A limit the code asked for is looser than the budget's, and so does nothing."""


def is_walletcap_error(error: BaseException) -> bool:
    """Whether ``error`` is one walletcap raised about its own state or input."""

    return isinstance(error, BudgetUnavailable | BudgetRefused | UsageError)
