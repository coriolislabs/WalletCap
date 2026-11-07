# SPDX-License-Identifier: Apache-2.0
"""walletcap: one spend budget per wallet, across every process, key and rail on one host.

    from walletcap import open_budget

    # The owner creates the budget once: walletcap set --wallet <address> --per-day 150
    budget = open_budget(agent_address)
    with budget.pay("$12.50", to=payee) as payment:
        payment.tx = send_usdc(payee, "12.50")

The payer's handle (``open_budget``) checks, holds and pays; the owner's (``open_owner``) sets
limits, freezes, and voids or settles payments with evidence.
"""

from walletcap._ledger import MIN_SQLITE_VERSION, SCHEMA_VERSION
from walletcap.budget import (
    Budget,
    Check,
    HeldPayment,
    Hold,
    Outcome,
    Paying,
    Payment,
    PaymentRecord,
    PaymentState,
    Status,
    open_budget,
)
from walletcap.errors import (
    BudgetRefused,
    BudgetUnavailable,
    BudgetWarning,
    NotSent,
    PaymentNotRecorded,
    RefusalCode,
    RefusalSource,
    UsageError,
)
from walletcap.money import (
    MAX_AMOUNT,
    Dollars,
    Micros,
    Window,
    default_budget_path,
    format_usd,
    to_micros,
)
from walletcap.owner import BudgetLimits, Owner, VoidedPayment, open_owner

__version__ = "0.4.0"

__all__ = [
    "MAX_AMOUNT",
    "MIN_SQLITE_VERSION",
    "SCHEMA_VERSION",
    "Budget",
    "BudgetLimits",
    "BudgetRefused",
    "BudgetUnavailable",
    "BudgetWarning",
    "Check",
    "Dollars",
    "HeldPayment",
    "Hold",
    "Micros",
    "NotSent",
    "Outcome",
    "Owner",
    "Paying",
    "Payment",
    "PaymentNotRecorded",
    "PaymentRecord",
    "PaymentState",
    "RefusalCode",
    "RefusalSource",
    "Status",
    "UsageError",
    "VoidedPayment",
    "Window",
    "__version__",
    "default_budget_path",
    "format_usd",
    "open_budget",
    "open_owner",
    "to_micros",
]
