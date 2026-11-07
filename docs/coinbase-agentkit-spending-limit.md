---
title: Coinbase AgentKit spending limit
description: "Limit what a Coinbase AgentKit agent pays over x402. budget.guardAgentKit() checks every payment against a per-payment and 24-hour budget before it is signed."
---

# Coinbase AgentKit spending limit

Your AgentKit agent pays for resources through AgentKit's x402 actions, and you want a limit in
dollars, per payment and per day, on what it can sign. AgentKit's x402 actions build their own
x402 client on every call. `budget.guardAgentKit()` puts the budget on every client the provider
builds, so each payment is checked against the wallet's budget before it is signed, whatever
terms the merchant sends.

## Add it in 3 lines

```console
$ npm install walletcap @coinbase/agentkit
$ npx walletcap set --wallet 0xYourAgentWallet --per-payment 0.02 --per-day 1
```

```js
import { X402ActionProvider } from '@coinbase/agentkit';
import { openBudget } from 'walletcap';

const budget = openBudget({ wallet: '0xYourAgentWallet' }); // the budget `walletcap set` created
const x402 = budget.guardAgentKit(new X402ActionProvider());
// AgentKit.from({ walletProvider, actionProviders: [x402] })
```

- It compiles in TypeScript, where a subclass can't override AgentKit's private
  `createX402Client`. The test suite type-checks this recipe with `tsc`.
- It is tested against the shape of AgentKit 0.10.4, and the crash test runs AgentKit 0.10.4
  itself.
- The budget is the same one every other process and rail spends from: see
  [x402](x402-spending-limit.md) and [Python](python-agent-spending-limit.md).

## Crash test: AgentKit signs $1.00, walletcap at 2¢ a payment signs 1¢

The AgentKit row is opt-in because AgentKit installs about 1.3 GB:

```console
$ npx -p walletcap-crash-test -p @coinbase/agentkit@0.10.4 walletcap-crash-test --agentkit
```

The agent approves the merchant's 1¢ offer on Base Sepolia; the merchant lists $1.00 on Base
mainnet, to another address, first.

| Control | Result |
|---|---|
| AgentKit 0.10.4 | signed $1.00 on Base mainnet to the first-listed address, valid 4 days; reported $0.01 on Base Sepolia |
| walletcap, 2¢ a payment | signed $0.01 on Base Sepolia, the offer the agent approved |

walletcap limits how much AgentKit pays, not which offer it pays. It passes over the $1.00, which
the merchant asks to be valid 4 days: it signs only terms valid an hour or less, and at most 2¢.
The offer left is the 1¢ one the agent approved. A merchant that listed the approved offer valid
two hours, and a 2¢ one valid five minutes, would get the 2¢ one.

CI runs this row on every pull request and checks it. For 0.3.0 the check prints:

```text
AgentKit 0.10.4: signed $1.00 on Base mainnet, reported $0.01 on Base Sepolia; walletcap signed the $0.01 on Base Sepolia.
```

## Links

- [README: Coinbase AgentKit](https://github.com/coriolislabs/WalletCap#coinbase-agentkit)
- Tests: [agentkit.test.mjs](https://github.com/coriolislabs/WalletCap/blob/main/js/tests/agentkit.test.mjs)
  and the type-checked [recipe](https://github.com/coriolislabs/WalletCap/blob/main/js/tests/types/recipe.ts)
- [The crash test](https://github.com/coriolislabs/WalletCap/tree/main/crash-test), which says
  exactly what runs, and [all pages](index.md)
- Other stacks: [any x402 client](x402-spending-limit.md),
  [Coinbase CDP x402 spend controls](coinbase-cdp-spend-controls.md),
  [Coinbase Agentic Wallet and payments MCP](coinbase-agentic-wallet-budget.md)
