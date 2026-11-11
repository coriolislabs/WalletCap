---
title: walletcap
description: "Per-payment and rolling 24-hour spend limits for AI agent wallets that pay in USDC, held across restarts and replicas on one host. Crash test: $0 past a $150 cap."
---

# walletcap: spend limits for AI agent wallets

Spend limits for AI agent wallets that pay in USDC: a per-payment cap and a rolling 24-hour
budget that holds across restarts, replicas on one host and payment rails. walletcap is an npm and PyPI
package under Apache-2.0. It plugs into x402 clients, Coinbase CDP's x402 spend controls,
Coinbase AgentKit, the Coinbase Agentic Wallet CLI and payments MCP server, and Coinbase Spend
Permissions.

## Pages by stack

| You use | Page |
|---|---|
| any x402 client (`@x402/core`, `@x402/fetch`) | [x402 spending limit for AI agents](x402-spending-limit.md) |
| Coinbase CDP's `applySpendControls` | [Coinbase CDP x402 spend controls across replicas and restarts](coinbase-cdp-spend-controls.md) |
| Coinbase AgentKit's x402 actions | [Coinbase AgentKit spending limit](coinbase-agentkit-spending-limit.md) |
| Coinbase's Agentic Wallet (`awal`) or payments MCP server | [Coinbase Agentic Wallet and payments MCP budget](coinbase-agentic-wallet-budget.md) |
| Coinbase Spend Permissions | [One cap across Coinbase Spend Permissions](coinbase-spend-permissions-cap.md) |
| Python | [Python spending limit for AI agent payments](python-agent-spending-limit.md) |

## Crash test: CDP's controls let $1,600–$1,700 past a $150 cap, walletcap lets $0

`npx walletcap-crash-test` puts Coinbase's agent spend controls through four ordinary events (a
restart, 10 replicas, 10 replicas on a shared store, and a payee who asks for EURC), then puts
walletcap through the same events. CDP's x402 controls are set as Coinbase's README shows, then
run again on walletcap's `cdpStore`. Spend Permissions run Coinbase's deployed contract code on
a local EVM. Every agent is held to $50 a payment and $150 in any 24 hours, in USDC on Base. It
runs offline in about 15 seconds and sends nothing.

```console
$ npx walletcap-crash-test
```

| CDP x402 spend controls | CDP's controls | walletcap guard | walletcap cdpStore |
|---|---|---|---|
| restart, then pay again | $300 signed · $150 over | $150 signed · $0 over | $150 signed · $0 over |
| 10 replicas | $1,500 signed · $1,350 over | $150 signed · $0 over | $150 signed · $0 over |
| 10 replicas, shared store 1 ms away | $350 signed · $200 over | $150 signed · $0 over | $150 signed · $0 over |
| payee asks for EURC, not USDC | 1,000 EURC signed, counted as $0 | refused before signing | refused before signing |

| Spend Permissions | SpendPermissionManager | AccountCapSpender |
|---|---|---|
| a second permission | $300 pulled · $150 over | $150 pulled · $0 over |
| across a period boundary, 1 second apart | $300 pulled · $150 over | $150 pulled · $0 over |

Past the $150 cap: $1,700 and 1,000 EURC with CDP's controls, $300 with Spend Permissions; $0
with walletcap's guard, its cdpStore and AccountCapSpender. The shared-store row varies from
run to run: in eight runs on 6 November 2026 it was $100 over five times and $200 over three
times. Those runs used `@coinbase/cdp-sdk` 1.61.0, `@x402/core` 2.30.0, SpendPermissionManager
1.0.0 and walletcap 0.2.3. The crash test in the repository now runs walletcap 0.5.0, and its
suite fails if the guard or the cdpStore lets anything past the cap.

Add `--agentkit` for Coinbase AgentKit's row: the agent approves a 1¢ offer, and AgentKit signs
the merchant's first-listed $1.00 on Base mainnet. walletcap, at 2¢ a payment, limits the amount,
not which offer is paid: it passes over the $1.00, valid 4 days, and the offer left is the 1¢ the
agent approved. [The crash test's README](https://github.com/coriolislabs/WalletCap/tree/main/bench/crash-test)
says exactly what runs.

## Install

```console
$ npm install walletcap     # Node 22.13+, no runtime dependencies
$ pip install walletcap     # Python 3.11+, no dependencies
```

The wallet's owner creates the budget once. Agents open it, and opening never creates one:

```console
$ npx walletcap set --wallet 0xYourAgentWallet --per-payment 50 --per-day 150
```

```js
import { openBudget } from 'walletcap';

const budget = await openBudget({ wallet: account.address });

await budget.pay('$12.50', () => sendUsdc(payee, '12.50')); // refused past $150 in any 24h, restarts included
```

The count lives in a SQLite file that every process on the machine opens. Each payment is held
by one conditional insert inside a write transaction, so replicas racing for the last dollar
can't both win. JavaScript and Python run the same SQL, from
[spec/schema.sql](https://github.com/coriolislabs/WalletCap/blob/main/spec/schema.sql), on the
same file; [spec/ledger.md](https://github.com/coriolislabs/WalletCap/blob/main/spec/ledger.md)
explains the rule.

## Links

- Source, issues and the full README: [github.com/coriolislabs/WalletCap](https://github.com/coriolislabs/WalletCap)
- npm: [walletcap](https://www.npmjs.com/package/walletcap) and [walletcap-crash-test](https://www.npmjs.com/package/walletcap-crash-test)
- PyPI: [walletcap](https://pypi.org/project/walletcap/)
- [Threat model](threat-model.md): what the library stops, what it doesn't, and the deployment patterns that hold
- [Design records](adr/): why the ledger is built the way it is
- [What is public API](https://github.com/coriolislabs/WalletCap/blob/main/STABILITY.md), and how versions change it
- [Security policy](https://github.com/coriolislabs/WalletCap/blob/main/SECURITY.md)
