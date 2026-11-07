<!-- SPDX-License-Identifier: Apache-2.0 -->
# walletcap

Spend limits for AI agent wallets: a per-payment cap and a rolling budget (say $150 in any 24
hours) per wallet, counted in one SQLite file that every process on the host opens. A restart, a
second replica or another key doesn't start the count again, and the npm package
[walletcap](https://www.npmjs.com/package/walletcap) counts in the same file, by the same SQL.

```console
$ pip install walletcap                                         # Python 3.11+, no dependencies
$ walletcap set --wallet 0xYourAgentWallet --per-payment 50 --per-day 150
```

```python
from walletcap import open_budget

budget = open_budget(agent_address)

with budget.pay("$12.50") as payment:  # refused past $150 in any 24 hours
    payment.tx = send_usdc(payee, "12.50")
```

- The owner creates the budget once with `walletcap set`, or `open_owner().set_limits(...)`.
  Opening never creates one unless `create=True` is passed, which is for demos.
- If the block raises, the payment may still have left, so it stays held, noted unknown, until
  its owner checks the chain and voids it. `raise NotSent(...)` inside the block says it never
  left.
- `budget.hold(amount, id=..., settles_within=timedelta(minutes=5))` returns a `Hold` to
  `settle(tx=...)`, `void()` or `note()` yourself. One id is one payment.
- Errors: `BudgetRefused` (`code`, `brief`), `BudgetUnavailable`, `UsageError`, and
  `PaymentNotRecorded`, which shares no base with the others: don't pay again. None is a
  `ValueError`.
- `async with budget.pay(...)` and `acheck`, `ahold`, `astatus`, `aholds` and `ahistory` wait for
  another process's lock in a worker thread, not on the event loop.
- Amounts are dollars: strings (`"$12.50"`), `Decimal`s, floats and ints (whole dollars). What
  comes back is `Micros`, an `int` in micro-dollars that `to_micros` reads as micro-dollars.
- The owner's command, `walletcap` or `python -m walletcap`: `status`, `set`, `freeze`,
  `unfreeze`, `history`, `holds`, `void <id>`, `void --all-unknown --older-than 24h` and
  `settle <id> --tx <hash>`.

The ledger's rule is SQL that ships inside the package (`walletcap/spec/schema.sql`), the same
file the npm package runs. Source, docs and the threat model:
https://github.com/coriolislabs/WalletCap

Apache-2.0. Copyright 2026 Coriolis Labs Inc.
