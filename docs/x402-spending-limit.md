---
title: x402 spending limit for AI agents
description: "A per-payment and 24-hour USDC spending limit for any x402 client: budget.guard() checks each payment before it is signed, across every process and restart."
---

# x402 spending limit for AI agents

Your agent pays for APIs over x402, and you want it to stop at, say, 50¢ a payment and $5 a
day. A count kept in one process's memory starts again when that process restarts, and each
replica keeps its own. `budget.guard()` puts one budget, kept in a file every process opens, in
front of any x402 v2 client from `@x402/core`, including under `@x402/fetch`.

## Add it in 3 lines

```console
$ npm install walletcap @x402/core @x402/evm @x402/fetch viem
$ npx walletcap set --wallet 0xYourAgentWallet --per-payment 0.50 --per-day 5
```

```js
import { openBudget } from 'walletcap';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.AGENT_KEY);
const budget = openBudget({ wallet: account.address }); // the budget `walletcap set` created

const client = budget.guard(new x402Client().register('eip155:8453', new ExactEvmScheme(account)));
const fetchPaid = wrapFetchWithPayment(fetch, client);

const response = await fetchPaid('https://api.example.com/paid');
```

- Each payment is checked before it is signed, and reserved once its payload exists and every
  other control has passed.
- It counts as spent when the server confirms settlement, and at least until its authorization
  expires, plus one window: the confirmation is the payee's own word, and a payee that answers
  "payment failed" still holds the signed authorization too.
- A payee may ask for an authorization valid up to an hour, as Coinbase's CDP spend controls
  allow. Longer terms are passed over for shorter ones on offer; when none are, the payment is
  refused before signing.
- USDC on Base, Ethereum, Polygon, Arbitrum, Optimism, Avalanche and Solana is priced out of the
  box, plus Base Sepolia, Arbitrum Sepolia and Solana devnet. Add another USD stablecoin with
  `budget.guard(client, { assets: [{ network, asset, decimals }] })`. List only USD-pegged
  stablecoins: each counts at $1 a token. Decimals are an integer from 0 to 18, and a built-in
  asset's decimals can't be changed. Anything else is refused before signing.
- `@x402/fetch` rewraps errors from payment creation, so a refusal reaches you as an `Error`
  whose message starts `Failed to create payment payload:` and carries the budget's reason.
- `@x402/core` also caps each payment at $1 by default, on top of the budget;
  `client.setSpendControls()` changes that cap.
- If the client also has Coinbase CDP's spend controls, use one counter: see
  [CDP x402 spend controls](coinbase-cdp-spend-controls.md). `budget.guard()` refuses a client
  that already has them.

## Crash test: $1,350 over a $150 cap with 10 replicas under CDP's controls, $0 under the guard

Each agent in `npx walletcap-crash-test` is a separate Node process that builds an `@x402/core`
client with the exact EVM scheme and tries its payments. Every agent is held to $50 a payment
and $150 in any 24 hours, in USDC on Base. Results from 6 November 2026:

| Event | CDP's controls | walletcap guard |
|---|---|---|
| restart, then pay again | $300 signed · $150 over | $150 signed · $0 over |
| 10 replicas | $1,500 signed · $1,350 over | $150 signed · $0 over |
| 10 replicas, shared store 1 ms away | $350 signed · $200 over | $150 signed · $0 over |
| payee asks for EURC, not USDC | 1,000 EURC signed, counted as $0 | refused before signing |

The shared-store row varies from run to run: in eight runs it was $100 over five times and
$200 over three times. The guard column was $0 over in every run.

## Links

- [README: x402](https://github.com/coriolislabs/WalletCap#x402) and
  [the guard's source](https://github.com/coriolislabs/WalletCap/blob/main/js/x402.mjs)
- Tests: [x402.test.mjs](https://github.com/coriolislabs/WalletCap/blob/main/js/tests/x402.test.mjs)
  and [x402-fetch.test.mjs](https://github.com/coriolislabs/WalletCap/blob/main/js/tests/x402-fetch.test.mjs),
  which runs `@x402/fetch` against a local server that answers 402
- [The crash test](https://github.com/coriolislabs/WalletCap/tree/main/crash-test) and
  [all pages](index.md)
- Other stacks: [Coinbase AgentKit](coinbase-agentkit-spending-limit.md),
  [Coinbase Agentic Wallet and payments MCP](coinbase-agentic-wallet-budget.md),
  [Python](python-agent-spending-limit.md)
