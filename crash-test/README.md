<!-- SPDX-License-Identifier: Apache-2.0 -->
# walletcap crash test

This puts Coinbase CDP's x402 spend controls through the events that hand an AI agent a fresh budget: a restart, replicas, a shared store, and a payee who switches assets. It then runs walletcap through the same events and counts what gets past the cap.

It runs offline in under ten seconds and sends nothing.

```console
$ npx walletcap-crash-test

walletcap crash test: Coinbase CDP x402 spend controls
@coinbase/cdp-sdk 1.61.0 · @x402/core 2.30.0 · walletcap 0.2.3
Every agent is held to $50 a payment and $150 in any 24 hours, in USDC on Base.

                                      CDP's controls                     walletcap
restart, then pay again               $300 signed · $150 over            $150 signed · $0 over
10 replicas                           $1,500 signed · $1,350 over        $150 signed · $0 over
10 replicas, shared store 1 ms away   $350 signed · $200 over            $150 signed · $0 over
payee asks for EURC, not USDC         1,000 EURC signed, counted as $0   refused before signing

Past the $150 cap: $1,700 and 1,000 EURC with CDP's controls; $0 with walletcap.
```

It needs Node 22.13 or later. Add `--json` for machine-readable results. The process exits 1 if walletcap lets anything past the cap.

To run it from this repository instead: `cd crash-test && npm install && npm start`.

## What runs

Every agent is a separate Node process with its own throwaway key. It builds an `@x402/core` client with the exact EVM scheme and tries its payments.

The two controls:
- **CDP's controls:** `applySpendControls` from `@coinbase/cdp-sdk/x402`, the same guardrails `CdpX402Client` uses. The settings follow Coinbase's README example: per-payment and cumulative caps in USDC, Base only, and no asset allowlist. Like `CdpX402Client`, the agent turns off x402's own default cap.
- **walletcap:** `budget.guard()` on the same client. The owner sets the budget once, and every agent opens the same file.

The events, each from a fresh start:

| Event | What happens |
|---|---|
| Restart | One process pays until it is refused. A second process, the restart, pays again. |
| 10 replicas | Ten processes start together and pay. |
| 10 replicas, shared store | The same, with CDP's ledger in one shared store built to its `SpendStore` interface. |
| EURC instead of USDC | The payee asks for 1,000 EURC. |

The shared store is what Coinbase's docs advise for replicas: "implement this interface against a shared durable backend (Redis, Postgres, DynamoDB, etc.)". The store in `spend-store.mjs` does exactly what the interface says, and answers each call after 1 ms, as a network database does.

The interface has no single step that both checks the cap and records the payment. CDP reads the total, decides, then appends, and its lock covers one process. Replicas can read the same total before any of them appends. How many overlap varies from run to run.

## What "signed" means

Nothing is sent. Each payment is an x402 authorization (EIP-3009) signed with a key that holds nothing. A payee holding one could settle it on Base until it expires, so signing is the moment the money is committed. The crash test counts what each control lets the agent sign.

## What it doesn't cover

- **Settlement.** It measures the client-side control, not what lands on chain.
- **More than one machine.** The replicas share one machine, and walletcap's budget file is single-host.
- **Other vendors' controls.** Only Coinbase's CDP x402 controls are covered so far. Spend Permissions, the Agentic Wallet, AgentKit, Safe, MetaMask, Tempo and AP2 come next.

## Releasing

To release a new version:
1. Bump `version` in `crash-test/package.json` and merge the change.
2. Publish a GitHub Release tagged `crash-test-v<version>`. Untick "Set as the latest release", so walletcap's own release stays the latest.

The Publish workflow then runs the crash test against the walletcap on npm and publishes with provenance. Releases tagged `v<version>` publish walletcap only.

To have the same measurement run against your own agent, inside your walls, with every control on and a signed result, [ask for a ShadowPath report](mailto:paul@coriolislabs.ca).
