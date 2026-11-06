<!-- SPDX-License-Identifier: Apache-2.0 -->
# walletcap crash test

This puts Coinbase's agent spend controls through the events that hand an AI agent a fresh budget, runs walletcap through the same events, and counts what gets past the cap.

| Control | Events |
|---|---|
| CDP's x402 controls, on their own store and on walletcap's | a restart, replicas, a shared store, a payee who switches assets |
| Spend Permissions | a second permission, a period boundary |
| AgentKit (`--agentkit`) | a merchant who lists a bigger offer first |

It runs offline in under fifteen seconds and sends nothing.

```console
$ npx walletcap-crash-test

walletcap crash test: Coinbase's agent spend controls
@coinbase/cdp-sdk 1.61.0 · @x402/core 2.30.0 · SpendPermissionManager 1.0.0 · walletcap 0.2.3
Every agent is held to $50 a payment and $150 in any 24 hours, in USDC on Base.

CDP x402 spend controls                      CDP's controls                     walletcap guard          walletcap cdpStore
  restart, then pay again                    $300 signed · $150 over            $150 signed · $0 over    $150 signed · $0 over
  10 replicas                                $1,500 signed · $1,350 over        $150 signed · $0 over    $150 signed · $0 over
  10 replicas, shared store 1 ms away        $350 signed · $200 over            $150 signed · $0 over    $150 signed · $0 over
  payee asks for EURC, not USDC              1,000 EURC signed, counted as $0   refused before signing   refused before signing

Spend Permissions                            SpendPermissionManager             AccountCapSpender
  a second permission                        $300 pulled · $150 over            $150 pulled · $0 over
  across a period boundary, 1 second apart   $300 pulled · $150 over            $150 pulled · $0 over

Past the $150 cap: $1,700 and 1,000 EURC with CDP's controls, $300 with Spend Permissions;
$0 with walletcap's guard and AccountCapSpender; $0 with CDP's controls on walletcap's cdpStore.
```

It needs Node 22.13 or later. Add `--json` for machine-readable results; each event's `cdp`, `walletcap` and `cdpStore` hold the three columns. The process exits 1 if walletcap's guard, CDP's controls on walletcap's cdpStore, or any other walletcap control lets anything past the cap.

To run it from this repository instead: `cd crash-test && npm install && npm start`.

## What runs

Every agent is a separate Node process with its own throwaway key. It builds an `@x402/core` client with the exact EVM scheme and tries its payments.

The three controls:
- **CDP's controls:** `applySpendControls` from `@coinbase/cdp-sdk/x402`, the same guardrails `CdpX402Client` uses. The settings follow Coinbase's README example: per-payment and cumulative caps in USDC, Base only, and no asset allowlist. Like `CdpX402Client`, the agent turns off x402's own default cap.
- **walletcap guard:** `budget.guard()` on the same client. The owner sets the budget once, and every agent opens the same file.
- **walletcap cdpStore:** CDP's own `applySpendControls` again, set exactly as [walletcap's README](https://github.com/coriolislabs/WalletCap#coinbase-cdp-spend-controls) shows: the same caps, `allowedAssets: [USDC]`, and `store: budget.cdpStore({ asset: USDC })`. The owner sets the budget once, and every agent, replica or restart opens the same file, so CDP's ledger is that file.

The events, each from a fresh start, once per control:

| Event | What happens |
|---|---|
| Restart | One process pays until it is refused. A second process, the restart, pays again. |
| 10 replicas | Ten processes start together and pay. |
| 10 replicas, shared store | The same, with CDP's ledger in one shared store built to its `SpendStore` interface. In the cdpStore column, walletcap's store answers each call after the same 1 ms. |
| EURC instead of USDC | The payee asks for 1,000 EURC. |

The shared store is what Coinbase's docs advise for replicas: "implement this interface against a shared durable backend (Redis, Postgres, DynamoDB, etc.)". The store in `spend-store.mjs` does exactly what the interface says, and answers each call after 1 ms, as a network database does.

The interface has no single step that both checks the cap and records the payment. CDP reads the total, decides, then appends, and its lock covers one process. Replicas can read the same total before any of them appends. How many overlap varies from run to run.

walletcap's cdpStore sits behind the same interface, so CDP still reads, decides, then appends. Its `append` re-checks the cap inside one SQLite write transaction and throws if the payment would go past it. CDP appends before it signs, so a payment the store refuses is never signed. In the replica rows, the re-check usually refuses a few payments that CDP's own check had passed (`budget_budget` in `--json`); how many varies from run to run. In the EURC row, CDP's `allowedAssets`, which walletcap's README sets, refuses before the store is asked.

## Coinbase Spend Permissions

Coinbase's `SpendPermissionManager` v1.0.0 and Smart Wallet run on an in-process EVM. Their code is the exact runtime code deployed on Base mainnet, read once with `eth_getCode` and shipped in `contracts/coinbase-base-mainnet.json` with each code hash, so the crash test needs no network.

A Smart Wallet holds $1,000 of a test token that stands in for USDC, and grants the agent permissions of $150 a day.

| Event | What happens |
|---|---|
| A second permission | The wallet grants two permissions with different salts, and the agent pulls $150 from each. |
| A period boundary | The agent pulls $150 in the last second of one day and $150 in the first second of the next. |

The manager counts each permission, and each period, on its own, so both events pull $300. Within one permission and one period it holds: the test suite checks that a fourth $50 is refused with `ExceededSpendPermission`.

walletcap's side: the wallet grants the same permissions to `AccountCapSpender`, walletcap's on-chain spender. It counts every permission against one rolling $150 cap and refuses the second $150 with `OverBudget`. `AccountCapSpender` is unaudited.

`node contracts/build.mjs --check` checks two things: that each piece of Coinbase code still matches its recorded hash, and that the shipped `AccountCapSpender` still compiles from `solidity/`. `--fetch` re-reads Coinbase's code from Base mainnet.

## Coinbase AgentKit (`--agentkit`)

```console
$ npx -p walletcap-crash-test -p @coinbase/agentkit@0.10.4 walletcap-crash-test --agentkit

Coinbase AgentKit 0.10.4: the agent approves the merchant's 1¢ offer on Base Sepolia; the merchant
lists $1.00 on Base mainnet, to another address, first.

AgentKit                         signed $1.00 on Base mainnet to the first-listed address, valid 4 days; reported $0.01 on Base Sepolia
walletcap, 2¢ a payment          signed $0.01 on Base Sepolia to the merchant
```

The AgentKit row runs AgentKit's own `retry_http_request_with_x402` action against a merchant on `127.0.0.1`. The agent hands it the 1¢ offer it approved, which is how AgentKit's flow works.

What AgentKit does with it:
- It checks only that the approved offer's network is one the wallet supports.
- It then builds a fresh x402 client, which pays whatever the merchant listed first.
- Its answer reports the approved offer, not the one it signed.

walletcap's `budget.guardAgentKit()`, at 2¢ a payment, passes over the $1.00, which the merchant asks to be valid 4 days: walletcap signs only terms valid an hour or less. It pays the 1¢ offer the agent approved.

AgentKit is opt-in because it installs about 1.3 GB. Its wallet providers also send an analytics event with the wallet's address when they start. The crash test turns that off and blocks every request except the one to the local merchant.

## What "signed" means

Nothing is sent. Each payment is an x402 authorization (EIP-3009) signed with a key that holds nothing. A payee holding one could settle it on Base until it expires, so signing is the moment the money is committed. The crash test counts what each control lets the agent sign.

## What it doesn't cover

- **Settlement of x402 payments.** For x402 it measures what the client-side control lets the agent sign, not what lands on chain. The Spend Permissions rows do move tokens on the local EVM.
- **More than one machine.** The replicas share one machine, and walletcap's budget file, behind both its guard and its cdpStore, is single-host.
- **A revoke in the same block.** A revoke that lands after the agent's payment in the same block doesn't stop that payment, with either control. Neither control can make a revoke retroactive.
- **Other vendors' controls.** Coinbase's CDP x402 controls, Spend Permissions and AgentKit are covered so far. The Agentic Wallet, Safe, MetaMask, Tempo and AP2 come next.

Coinbase's contract code in `contracts/coinbase-base-mainnet.json` comes from [coinbase/spend-permissions](https://github.com/coinbase/spend-permissions) and [coinbase/smart-wallet](https://github.com/coinbase/smart-wallet), both under the MIT license.

## Releasing

To release a new version:
1. Bump `version` in `crash-test/package.json` and merge the change.
2. Publish a GitHub Release tagged `crash-test-v<version>`. Untick "Set as the latest release", so walletcap's own release stays the latest.

The Publish workflow then runs the crash test against the walletcap on npm and publishes with provenance. Releases tagged `v<version>` publish walletcap only.

To have the same measurement run against your own agent, inside your walls, with every control on and a signed result, [ask for a ShadowPath report](mailto:paul@coriolislabs.ca).
