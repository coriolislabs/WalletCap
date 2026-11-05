# walletcap

**Your agent's spending limit forgets. This one doesn't.**

One spend budget per wallet for AI agents: counted across every process, replica,
key, permission and payment rail that pays from it. A restart, a second replica,
one more key or the next calendar period cannot hand the agent a fresh budget.

```js
import { openBudget } from 'walletcap';

const budget = openBudget({ wallet: account.address, perPayment: '$50', perDay: '$150' });

await budget.pay('$12.50', () => sendUsdc(payee, '12.50'));
// refused past $150 in any 24h, restarts included
```

- **Per wallet, not per process.** Every payment from the wallet reserves against one number.
- **Rolling window.** "$150 a day" means any 24 hours; there is no boundary to straddle.
- **Edits never reset the count.** Raising $150 to $200 after spending $150 leaves $50.
- **Fail closed.** If the count can't be read, nothing pays. Unknown outcomes keep counting.
- **One SQLite file, shared by every process and by Python.** Each payment reserves inside
  one write transaction, so replicas racing for the last dollar cannot both win.
- **x402 guard, Coinbase CDP spend store, Agentic Wallet wrapper, AgentKit recipe,
  and an on-chain cap for Spend Permissions.**
- Node 22.13+, zero runtime dependencies, Apache-2.0.

```console
$ npx walletcap status
$ npx walletcap set --wallet 0xYourAgentWallet --per-payment 0.05 --per-day 0.15
$ npx walletcap freeze
```

[Source, Python package and full documentation](https://github.com/coriolislabs/WalletCap)

Apache-2.0. Copyright 2026 Coriolis Labs Inc.
