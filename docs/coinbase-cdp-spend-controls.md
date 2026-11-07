---
title: Coinbase CDP x402 spend controls across replicas and restarts
description: "Back Coinbase CDP's applySpendControls with cdpStore() from walletcap/cdp, one count every replica and restart shares. Crash test: $1,350 over with 10 replicas, $0 on it."
---

# Coinbase CDP x402 spend controls across replicas and restarts

You cap what an agent pays over x402 with `applySpendControls` from `@coinbase/cdp-sdk/x402`,
and the agent restarts or runs as several replicas. CDP keeps its running total in a
`SpendStore`, and the default store is in memory, in one process. `cdpStore()` from
`walletcap/cdp` is walletcap's SQLite ledger behind CDP's `SpendStore` interface, so CDP's total
lives in one budget file that every replica and every restart opens.

## Add it: one `store` line in `applySpendControls`

```console
$ npm install walletcap @coinbase/cdp-sdk @x402/core @x402/evm viem
$ npx walletcap set --wallet 0xYourAgentWallet --per-payment 50 --per-day 150
```

```js
import { openBudget } from 'walletcap';
import { cdpStore } from 'walletcap/cdp';
import { applySpendControls } from '@coinbase/cdp-sdk/x402';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base

const account = privateKeyToAccount(process.env.AGENT_KEY);
const budget = await openBudget({ wallet: account.address }); // the budget `walletcap set` created
const client = new x402Client().register('eip155:8453', new ExactEvmScheme(account));
// As CdpX402Client does: CDP's caps below replace x402's own $1-per-payment default.
client.setSpendControls(false);

applySpendControls(client, {
  maxAmountPerPayment: { atomic: 50_000_000n, asset: USDC },
  maxCumulativeSpend: { atomic: 150_000_000n, asset: USDC },
  maxCumulativeSpendWindow: '24h',
  allowedAssets: [USDC],
  store: cdpStore(budget, { asset: USDC }),
});
```

- Set `maxCumulativeSpend`: CDP only records through its store when a cumulative cap is set.
- Set `allowedAssets`: CDP never consults its store for a token outside the cap.
- In TypeScript with `node16` or `nodenext` module resolution, `applySpendControls(client, …)`
  fails to compile with `@coinbase/cdp-sdk` 1.60 and 1.61, with or without walletcap (TS2345):
  the SDK's declarations, read as CommonJS, take `@x402/core`'s CommonJS `x402Client`. At run
  time both are the ESM build. Pass `client as unknown as Parameters<typeof applySpendControls>[0]`,
  or compile with `"moduleResolution": "bundler"`.
- `append()` holds each payment through the ledger's own admission, inside one write
  transaction, so replicas on one host sharing the file can't both take the last dollar. The
  file serves one host: SQLite's locks aren't reliable over NFS, SMB or Docker Desktop bind
  mounts.
- Use one counter per client: this store or [`guard()`](x402-spending-limit.md). Each records
  the payment, so with both the budget would count it twice. `guard()` refuses a client that
  already has CDP controls, and a client guarded first refuses CDP controls before signing.
- A payment is held from the ledger's own time until an hour and a minute after CDP records it,
  and counts for one window after that: CDP signs it after recording it, and lets a payee ask for
  an authorization it can redeem for up to an hour. CDP's record isn't evidence that the payment
  settled, so `budget.status()` shows it as in flight.
- A payment CDP removes from its store keeps counting for the same time, noted refused. Once
  you've checked the chain, `npx walletcap void <id>` ends it sooner, and so does
  `npx walletcap void --all-unknown --older-than 24h` once that hour and a minute has passed.
  `npx walletcap holds` and a refusal's message mark each payment the store holds: CDP signed
  it, and its payee can redeem it until that hour and a minute has passed, so void it only if
  the chain shows it was never redeemed.
- A refusal the store passes to CDP, and so to the agent, is a `BudgetRefused` whose message is
  its `brief`: why, without which payments are open. An entry in another asset is refused with
  the code `asset`.
- Use CDP 1.60.0 or later: its published source refuses a `maxTimeoutSeconds` over 3600, which
  the store's hour relies on. The test suite drives the published `@coinbase/cdp-sdk` 1.60.0
  through the store, and the crash test runs 1.61.0.

## Crash test: $1,600–$1,700 past a $150 cap with CDP's controls, $0 on `cdpStore`

`npx walletcap-crash-test` runs CDP's controls set as Coinbase's README shows, then runs them
again set as above, with `store: cdpStore(budget, …)`. Every agent is a separate Node process,
held to $50 a payment and $150 in any 24 hours, in USDC on Base. Results from 6 November 2026:

| Event | CDP's controls | CDP's controls on walletcap cdpStore |
|---|---|---|
| restart, then pay again | $300 signed · $150 over | $150 signed · $0 over |
| 10 replicas | $1,500 signed · $1,350 over | $150 signed · $0 over |
| 10 replicas, shared store 1 ms away | $350 signed · $200 over | $150 signed · $0 over |
| payee asks for EURC, not USDC | 1,000 EURC signed, counted as $0 | refused before signing |

The shared-store row varies from run to run: in eight runs it was $100 over five times and
$200 over three times. The cdpStore column was $0 over in every run. In the shared-store row,
walletcap's store also answers each call after 1 ms. The crash test in the repository now runs
walletcap 0.4.0, and its suite fails if the cdpStore lets anything past the cap.

## Links

- [README: Coinbase CDP spend controls](https://github.com/coriolislabs/WalletCap#coinbase-cdp-spend-controls)
  and [the store's source](https://github.com/coriolislabs/WalletCap/blob/main/packages/js/src/adapters/cdp.ts)
- Tests: [cdp-sdk.test.mjs](https://github.com/coriolislabs/WalletCap/blob/main/packages/js/test/cdp-sdk.test.mjs),
  against the published CDP SDK, and [cdp.test.mjs](https://github.com/coriolislabs/WalletCap/blob/main/packages/js/test/cdp.test.mjs)
- [The crash test](https://github.com/coriolislabs/WalletCap/tree/main/bench/crash-test), which says
  exactly what runs, and [all pages](index.md)
- Other stacks: [any x402 client](x402-spending-limit.md),
  [Coinbase AgentKit](coinbase-agentkit-spending-limit.md),
  [Coinbase Spend Permissions](coinbase-spend-permissions-cap.md)
