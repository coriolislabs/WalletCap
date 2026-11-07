---
title: Python spending limit for AI agent payments
description: "pip install walletcap: a per-payment cap and rolling 24-hour budget for a Python AI agent's payments, in a SQLite file every process and the npm package share."
---

# Python spending limit for AI agent payments

Your agent is written in Python and pays from a wallet, and you want a per-payment and daily
limit that still holds when the agent restarts or runs as several processes. `walletcap` on PyPI
keeps the count in a SQLite file that every process opens. It is the same file, and the same SQL
rule, as the npm package, so Python and JavaScript agents on one machine spend from one budget.

## Add it

```console
$ pip install walletcap      # Python 3.11+, no dependencies
$ walletcap set --wallet 0xYourAgentWallet --per-payment 50 --per-day 150
```

```python
from walletcap import open_budget

budget = open_budget(agent_address)  # the budget `walletcap set` created

with budget.pay("$12.50", to=payee) as payment:
    payment.tx = send_usdc(payee, "12.50")
```

- `budget.pay()` holds the amount on entry and raises `BudgetRefused` if it would pass a limit;
  its `code` says which and its `brief` is what to tell an agent. A clean exit settles the
  payment, with `payment.tx` as the evidence.
- If the block raises, the payment may still have left the wallet, so it stays held, noted
  unknown: it counts until one window past `settles_by` (a timezone-aware datetime) if you pass
  one, or until its owner voids it. Raise `NotSent("card declined")` when you know it didn't
  leave, and the amount comes back.
- If the payment went through but the budget can't record it, the block raises
  `PaymentNotRecorded`. It shares no base class with `BudgetRefused`, `BudgetUnavailable` or
  `UsageError`, so code that retries on those doesn't pay twice. None of them is a `ValueError`.
- Limits passed to `open_budget` are this process's own: they can tighten the stored ones, for
  this process only. Looser ones change nothing, and warn.
- Amounts are dollars: strings (`"$12.50"`), `Decimal`s, floats and ints (whole dollars). What
  comes back is `Micros`, an `int` in micro-dollars whose arithmetic keeps the unit, and
  `to_micros` reads a `Micros` as micro-dollars, so `budget.check(budget.status().remaining)`
  means what it says.

For more control, hold the payment yourself:

```python
from datetime import timedelta

hold = budget.hold("$5", id=f"order-{order_id}", settles_within=timedelta(minutes=5))
try:
    hold.settle(tx=send_usdc(payee, "5"))
except BroadcastFailed:
    hold.void(reason="never broadcast")
```

- One id is one payment: holding it again returns that payment (`hold.created` is `False`), and
  `pay()` refuses an id already in the ledger. Only the hold that took a payment can move it,
  and a voided id can't be held again: a retry takes a new id.
- `hold.settles_by(when)` and `hold.settles_within(duration)` tell an open hold, once, the last
  moment it could settle. `hold.note("unknown", detail)` records what you know; it counts the same.
- `budget.check("$5")` answers without spending. `budget.status()`, `budget.history()` and
  `budget.holds()` read the count; `holds()` lists the held payments that still count, and why.
- In async code, use `async with budget.pay(...)`, and `acheck`, `ahold`, `astatus`, `aholds`
  and `ahistory`. They wait for another process's lock in a worker thread, through
  `asyncio.to_thread`, so the event loop keeps running.

## The owner's handle

Setting limits, freezing, and reconciling payments with evidence belong to the owner:

```python
from walletcap import open_owner

owner = open_owner()
owner.set_limits(agent_address, per_payment="$50", per_day="$150")
owner.void(payment_id, evidence="authorization unused past its validBefore")
owner.void_unknown(agent_address, older_than="24h")
```

The `walletcap` command (or `python -m walletcap`) is the owner's handle, with the same commands
and output as `npx walletcap`: `status`, `set`, `freeze`, `unfreeze`, `history`, `holds`,
`void <id>`, `void --all-unknown --older-than 24h` and `settle <id> --tx <hash>`.

In the library, the two handles are an API split: any process that can open the file can open
an owner's handle. To keep an agent from raising its own limits, run it as another OS user.

The x402 guard, the CDP store, the AgentKit guard and the Agentic Wallet wrapper are in the npm
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

Restart asks for looser limits; stored limits stay: walletcap: 0xd797…ca02 keeps its stored limits ($0.15 per 24h, at most $0.05 a payment); your code asks for $5.00 per 24h, at most $2.50 a payment. A process can tighten the limits for itself, never loosen them. …
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
- [The package source](https://github.com/coriolislabs/WalletCap/tree/main/packages/python/src/walletcap),
  [its tests](https://github.com/coriolislabs/WalletCap/tree/main/packages/python/tests), and
  [the SQL both packages run](https://github.com/coriolislabs/WalletCap/blob/main/spec/schema.sql)
- [walletcap on PyPI](https://pypi.org/project/walletcap/) and [all pages](index.md)
- JavaScript stacks: [any x402 client](x402-spending-limit.md),
  [Coinbase CDP x402 spend controls](coinbase-cdp-spend-controls.md),
  [Coinbase AgentKit](coinbase-agentkit-spending-limit.md),
  [Coinbase Agentic Wallet and payments MCP](coinbase-agentic-wallet-budget.md)
