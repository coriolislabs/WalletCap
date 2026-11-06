---
title: Python spending limit for AI agent payments
description: "pip install walletcap: a per-payment cap and rolling 24-hour budget for a Python AI agent's payments, in a SQLite file every process and the npm package share."
---

# Python spending limit for AI agent payments

Your agent is written in Python and pays from a wallet, and you want a per-payment and daily
limit that still holds when the agent restarts or runs as several processes. `walletcap` on PyPI
keeps the count in a SQLite file that every process opens. It is the same file, in the same
format, as the npm package, so Python and JavaScript agents on one machine spend from one budget.

## Add it

```console
$ pip install walletcap      # Python 3.11+, no dependencies
$ walletcap set --wallet 0xYourAgentWallet --per-payment 50 --per-day 150
```

```python
from walletcap import open_budget

budget = open_budget(agent_address, per_payment="$50", per_day="$150")

with budget.pay("$12.50", to=payee) as payment:
    payment.tx = send_usdc(payee, "12.50")
```

- `budget.pay()` reserves the amount on entry and raises `BudgetRefused` if it would pass a
  limit. A clean exit records the payment as settled.
- If the block raises, the payment still counts, because it may have left the wallet. Raise
  `NotSent("card declined")` when you know it didn't, and the amount comes back.
- Use `async with budget.pay(...)` in async code.
- `budget.check("$5")` answers without spending. `budget.status()`, `budget.freeze()`,
  `budget.unfreeze()` and `budget.history()` show and control the budget.
- The `walletcap` command (or `python -m walletcap`) has the same commands as `npx walletcap`:
  `status`, `set`, `freeze`, `unfreeze`, `history` and `release`.
- The x402 guard, the CDP store, the AgentKit guard and the Agentic Wallet wrapper are in the npm
  package. A Python agent can still share their budget: it opens the same file.

## Try it offline: 3 payments of $0.05 pass a $0.15 cap, the 4th is refused

The quickstart uses a fake payee and a temporary file: no wallet, chain, keys or network.

```console
$ git clone https://github.com/coriolislabs/WalletCap && cd WalletCap
$ python3 examples/quickstart/quickstart.py
Budget: 0xd797…ca02: $0.00 spent of $0.15 per 24h, $0.15 left · at most $0.05 a payment

paid     three small payments         $0.05
paid     three small payments         $0.05
paid     three small payments         $0.05
REFUSED  past the per-payment cap     $1.00  (per_payment)
REFUSED  past the rolling cap         $0.05  (budget)

Restart asks for looser limits; stored limits stay: walletcap: 0xd797…ca02 keeps its stored limits ($0.15 per 24h, at most $0.05 a payment); your code asks for $5.00 per 24h, at most $2.50 a payment. A restart can lower a limit but never raise one. …
Count before restart: 150000; after restart: 150000

REFUSED  the same $0.05 after restart $0.05  (budget)

Final: 0xd797…ca02: $0.15 spent of $0.15 per 24h, $0.00 left · at most $0.05 a payment
Result: 150000 of 150000 spent, 0 left.
History: 3 payments; the first is settled.
```

## Python and JavaScript share one $150 budget

The crash test runs the npm package. The Python suite checks that both languages count in one
file: Python pays $50 twice, then a Node process opens the same file, pays $50 and is refused
the next $50, and Python's next $1 is refused too. The history shows one `js` payment and two
`python` ones.

## Links

- [README](https://github.com/coriolislabs/WalletCap#readme) and
  [the owner's controls](https://github.com/coriolislabs/WalletCap#the-owners-controls)
- [The package source](https://github.com/coriolislabs/WalletCap/tree/main/src/walletcap) and
  [its tests](https://github.com/coriolislabs/WalletCap/blob/main/tests/test_budget.py)
- [walletcap on PyPI](https://pypi.org/project/walletcap/) and [all pages](index.md)
- JavaScript stacks: [any x402 client](x402-spending-limit.md),
  [Coinbase CDP x402 spend controls](coinbase-cdp-spend-controls.md),
  [Coinbase AgentKit](coinbase-agentkit-spending-limit.md),
  [Coinbase Agentic Wallet and payments MCP](coinbase-agentic-wallet-budget.md)
