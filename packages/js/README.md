# walletcap

**Spend limits for AI agent wallets that pay in USDC: a per-payment cap and a rolling 24-hour
budget that holds across restarts, replicas on one host and payment rails.**

One spend budget per wallet for AI agents: counted across every process, replica,
key, permission and payment rail on one host that pays from it. A restart, a second replica,
one more key or the next calendar period cannot hand the agent a fresh budget.

`npx walletcap-crash-test` puts Coinbase's agent spend controls through a restart, 10 replicas,
a shared store and a payee who asks for EURC, then puts walletcap through the same events,
offline. In eight runs, CDP's controls let $1,600–$1,700 and 1,000 EURC past a $150 cap;
walletcap let $0.

The owner creates the budget once; opening it never creates one:

```console
$ npx walletcap set --wallet 0xYourAgentWallet --per-payment 50 --per-day 150
```

```js
import { openBudget } from 'walletcap';

const budget = openBudget({ wallet: account.address, perPayment: '$50', perDay: '$150' });

await budget.pay('$12.50', () => sendUsdc(payee, '12.50'));
// refused past $150 in any 24h, restarts included
```

- **Per wallet, not per process.** Every payment from the wallet reserves against one number.
- **Rolling window.** "$150 a day" means any 24 hours; there is no boundary to straddle.
- **Edits never reset the count.** Raising $150 to $200 after spending $150 leaves $50.
- **Fail closed.** If the count can't be read, nothing pays; a missing file is not a new budget. Unknown outcomes keep counting.
- **One SQLite file on one host, shared by every process there and by Python.** Each payment
  reserves inside one write transaction, so replicas racing for the last dollar cannot both
  win. Not over NFS, SMB or Docker Desktop bind mounts, where SQLite's locks aren't reliable.
- **x402 guard, Coinbase CDP spend store, Agentic Wallet wrapper, AgentKit recipe,
  and an on-chain cap for Spend Permissions.**
- Node 22.13+, zero runtime dependencies, Apache-2.0.

```console
$ npx walletcap status
$ npx walletcap set --wallet 0xYourAgentWallet --per-payment 0.05 --per-day 0.15
$ npx walletcap freeze
```

Security: [policy](https://github.com/coriolislabs/WalletCap/blob/main/SECURITY.md) ·
[threat model](https://github.com/coriolislabs/WalletCap/blob/main/docs/threat-model.md).
`AccountCapSpender` is unaudited; testnet only until an independent audit.

[Source, Python package and full documentation](https://github.com/coriolislabs/WalletCap)
· docs for [x402](https://github.com/coriolislabs/WalletCap/blob/main/docs/x402-spending-limit.md),
[Coinbase CDP spend controls](https://github.com/coriolislabs/WalletCap/blob/main/docs/coinbase-cdp-spend-controls.md),
[AgentKit](https://github.com/coriolislabs/WalletCap/blob/main/docs/coinbase-agentkit-spending-limit.md),
[the Agentic Wallet and payments MCP](https://github.com/coriolislabs/WalletCap/blob/main/docs/coinbase-agentic-wallet-budget.md)
and [Spend Permissions](https://github.com/coriolislabs/WalletCap/blob/main/docs/coinbase-spend-permissions-cap.md)

Apache-2.0. Copyright 2026 Coriolis Labs Inc.
