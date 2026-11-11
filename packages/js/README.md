<!-- SPDX-License-Identifier: Apache-2.0 -->
# walletcap

**Spend limits for AI agent wallets that pay in USDC: a per-payment cap and a rolling 24-hour
budget that holds across restarts, replicas on one host and payment rails.**

One budget per wallet, counted in one SQLite file that every process on the host opens. A
restart, a second replica, one more key or the next calendar period can't hand the agent a fresh
budget. The rule is SQL, `spec/schema.sql`, built into the package as written (`dist/spec/` has a
copy to read), the same file the PyPI package runs.

`npx walletcap-crash-test` puts Coinbase's agent spend controls through a restart, 10 replicas,
a shared store and a payee who asks for EURC, then puts walletcap through the same events,
offline. In eight runs, CDP's controls let $1,600–$1,700 and 1,000 EURC past a $150 cap;
walletcap let $0.

The owner creates the budget once; opening it never creates one:

```console
$ npm install walletcap     # Node 22.13+, no runtime dependencies
$ npx walletcap set --wallet 0xYourAgentWallet --per-payment 50 --per-day 150
```

```js
import { openBudget } from 'walletcap';

const budget = await openBudget({ wallet: account.address });

await budget.pay('$12.50', () => sendUsdc(payee, '12.50')); // refused past $150 in any 24h
```

- If the payment function throws, the payment may still have left, so it stays held, noted
  unknown, until its owner voids it: an error never settles a payment. `throw notSent(error)`
  says it never left.
- `budget.hold(amount, { id, settlesWithin })` returns a `Hold` to `settle({ tx })`,
  `void()` or `note()` yourself. One id is one payment, and only the hold that took it can move
  it; a voided id can't be held again.
- Errors: `BudgetRefused` (`code`, `brief`), `BudgetUnavailable`, `UsageError`, and
  `PaymentNotRecorded`, which shares no base with the others: don't pay again.
- Every method is async. A wait for another process's lock happens on the event loop between
  tries; each try can hold the loop for up to about 10 ms, SQLite's own wait.

| Integration | Import | Use |
|---|---|---|
| Any x402 client (`@x402/core`, `@x402/fetch`) | `walletcap/x402` | `guard(client, budget)` |
| Coinbase CDP x402 spend controls | `walletcap/cdp` | `store: cdpStore(budget, { asset: USDC })` in `applySpendControls` |
| Coinbase AgentKit | `walletcap/agentkit` | `guardAgentKit(new X402ActionProvider(), budget)` |
| Coinbase Agentic Wallet CLI | `walletcap/agentic`, or the CLI | `npx walletcap awal x402 pay <url>` |
| Coinbase payments MCP server | the `walletcap-mcp` package | `npx walletcap-mcp --wallet 0x…` |

The owner's handle is `openOwner()`, and the `walletcap` command: `status`, `set`, `freeze`,
`unfreeze`, `history`, `holds`, `void <id>`, `void --all-unknown --older-than 24h` and
`settle <id> --tx <hash>`. Two more only read: `check <dollars>` says whether a payment would be
paid right now, and `doctor` checks the budget file before you rely on it.

Docs, the threat model and the full README: https://github.com/coriolislabs/WalletCap

Apache-2.0. Copyright 2026 Coriolis Labs Inc.
