# SPDX-License-Identifier: Apache-2.0
"""walletcap: one spend budget per wallet, across every process, replica, key and rail.

    from walletcap import open_budget

    # The owner creates the budget once: walletcap set --wallet <address> --per-day 150
    budget = open_budget(agent_address, per_payment="$50", per_day="$150")
    with budget.pay("$12.50", to=payee) as payment:
        payment.tx = send_usdc(payee, "12.50")
"""

from walletcap.budget import (
    Budget,
    Check,
    Paying,
    Payment,
    Reservation,
    Status,
    open_budget,
)
from walletcap.errors import (
    BudgetError,
    BudgetRefused,
    BudgetRevoked,
    BudgetWarning,
    NotSent,
    OverBudget,
    OverPerPayment,
    OverUses,
)
from walletcap.ledger import (
    MAX_AMOUNT,
    SCHEMA_VERSION,
    UNSET,
    BudgetLimits,
    BudgetStatus,
    Ledger,
    Spend,
)
from walletcap.money import (
    default_budget_path,
    format_usd,
    to_micros,
)

__version__ = "0.2.2"

__all__ = [
    "MAX_AMOUNT",
    "SCHEMA_VERSION",
    "UNSET",
    "Budget",
    "BudgetError",
    "BudgetLimits",
    "BudgetRefused",
    "BudgetRevoked",
    "BudgetStatus",
    "BudgetWarning",
    "Check",
    "Ledger",
    "NotSent",
    "OverBudget",
    "OverPerPayment",
    "OverUses",
    "Payment",
    "Paying",
    "Reservation",
    "Spend",
    "Status",
    "__version__",
    "default_budget_path",
    "format_usd",
    "open_budget",
    "to_micros",
]
