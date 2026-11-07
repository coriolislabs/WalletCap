# SPDX-License-Identifier: Apache-2.0
"""walletcap: one spend budget per wallet, across every process, key and rail on one host.

    from walletcap import open_budget

    # The owner creates the budget once: walletcap set --wallet <address> --per-day 150
    budget = open_budget(agent_address, per_payment="$50", per_day="$150")
    with budget.pay("$12.50", to=payee) as payment:
        payment.tx = send_usdc(payee, "12.50")
"""

from walletcap.budget import (
    UNSET,
    Budget,
    Check,
    Hold,
    Paying,
    Payment,
    Reservation,
    Status,
    open_budget,
)
from walletcap.errors import (
    BudgetError,
    BudgetRefused,
    BudgetWarning,
    NotSent,
    PaymentNotRecorded,
)
from walletcap.ledger import SCHEMA_VERSION, Ledger
from walletcap.money import (
    MAX_AMOUNT,
    default_budget_path,
    format_usd,
    to_micros,
)

__version__ = "0.4.0"

__all__ = [
    "MAX_AMOUNT",
    "SCHEMA_VERSION",
    "UNSET",
    "Budget",
    "BudgetError",
    "BudgetRefused",
    "BudgetWarning",
    "Check",
    "Hold",
    "Ledger",
    "NotSent",
    "Payment",
    "PaymentNotRecorded",
    "Paying",
    "Reservation",
    "Status",
    "__version__",
    "default_budget_path",
    "format_usd",
    "open_budget",
    "to_micros",
]
