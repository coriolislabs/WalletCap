<!-- SPDX-License-Identifier: Apache-2.0 -->
# walletcap

Spend limits for AI agent wallets: a per-payment cap and a rolling budget (say $150 in any 24
hours) per wallet, counted in one SQLite file that every process on the host opens. A restart, a
second replica or another key doesn't start the count again, and the npm package
[walletcap](https://www.npmjs.com/package/walletcap) counts in the same file.

```console
$ pip install walletcap                                         # Python 3.11+, no dependencies
$ walletcap set --wallet 0xYourAgentWallet --per-payment 50 --per-day 150
```

```python
from walletcap import open_budget

budget = open_budget(agent_address)

with budget.pay("$12.50") as payment:   # refused past $150 in any 24 hours
    payment.tx = send_usdc(payee, "12.50")
```

- The owner creates the budget once with `walletcap set`. Opening never creates one unless
  `create=True` is passed, which is for demos.
- If the block raises, the payment may still have left, so it keeps counting, marked unknown,
  until its owner checks the chain and voids it. `raise NotSent(...)` inside the block says it
  never left.
- `async with budget.pay(...)` and the `a`-prefixed methods (`acheck`, `astatus`, …) wait for
  another process's lock in a worker thread, not on the event loop.
- Amounts are dollars: strings (`"$12.50"`), `Decimal`s, ints (whole dollars) and floats. What
  the package returns is micro-dollars.

The ledger's rule is SQL that ships inside the package (`walletcap/spec/schema.sql`), the same
file the npm package runs. Source, docs and the threat model:
https://github.com/coriolislabs/WalletCap

Apache-2.0. Copyright 2026 Coriolis Labs Inc.
