<!-- SPDX-License-Identifier: Apache-2.0 -->
# walletcap: spend limits for AI agent wallets

[![npm](https://img.shields.io/npm/v/walletcap?label=npm)](https://www.npmjs.com/package/walletcap)
[![PyPI](https://img.shields.io/pypi/v/walletcap?label=PyPI)](https://pypi.org/project/walletcap/)
[![CI](https://github.com/coriolislabs/WalletCap/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/coriolislabs/WalletCap/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/coriolislabs/WalletCap/blob/main/LICENSE)

**Spend limits for AI agent wallets that pay in USDC: a per-payment cap and a rolling 24-hour
budget that holds across restarts, replicas on one host and payment rails.** walletcap plugs into x402
clients, Coinbase CDP's x402 spend controls, Coinbase AgentKit, the Coinbase Agentic Wallet CLI
and payments MCP server, and Coinbase Spend Permissions. By ShadowPath.

## Crash test: CDP's controls let $1,600–$1,700 past a $150 cap, walletcap lets $0

`npx walletcap-crash-test` puts Coinbase's agent spend controls through four ordinary events (a
restart, 10 replicas, 10 replicas on a shared store, and a payee who asks for EURC), then puts
walletcap through the same events. CDP's x402 controls are set as Coinbase's README shows, then
run again on walletcap's `cdpStore` as this README shows. Spend Permissions run Coinbase's
deployed contract code on a local EVM. Every agent is held to $50 a payment and $150 in any 24
hours, in USDC on Base. It runs offline in about 15 seconds and sends nothing.

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
1.0.0 and walletcap 0.2.3.

Add `--agentkit` for Coinbase AgentKit's row: the agent approves a 1¢ offer, and AgentKit signs
the merchant's first-listed $1.00 on Base mainnet. walletcap, at 2¢ a payment, refuses it before
signing. [The crash test's README](https://github.com/coriolislabs/WalletCap/tree/main/crash-test)
says exactly what runs.

## Install and use

```console
$ npm install walletcap     # Node 22.13+, no dependencies
$ pip install walletcap     # Python 3.11+, no dependencies
```

The owner creates the budget once. Opening it never creates one; pass `create: true` only for a
demo or first-run setup:

```console
$ npx walletcap set --wallet 0xYourAgentWallet --per-payment 50 --per-day 150
```

```js
import { openBudget } from 'walletcap';

const budget = openBudget({ wallet: account.address, perPayment: '$50', perDay: '$150' });

await budget.pay('$12.50', () => sendUsdc(payee, '12.50')); // refused past $150 in any 24h, restarts included
```

```python
from walletcap import open_budget

budget = open_budget(agent_address, per_payment="$50", per_day="$150")

with budget.pay("$12.50"):
    send_usdc(payee, "12.50")
```

| Integration | Install | Use |
|---|---|---|
| [Any x402 client](https://github.com/coriolislabs/WalletCap/blob/main/docs/x402-spending-limit.md) (`@x402/core`, `@x402/fetch`) | `npm install walletcap` | `budget.guard(client)` |
| [Coinbase CDP x402 spend controls](https://github.com/coriolislabs/WalletCap/blob/main/docs/coinbase-cdp-spend-controls.md) | `npm install walletcap @coinbase/cdp-sdk` | `store: budget.cdpStore({ asset: USDC })` in `applySpendControls` |
| [Coinbase AgentKit](https://github.com/coriolislabs/WalletCap/blob/main/docs/coinbase-agentkit-spending-limit.md) | `npm install walletcap @coinbase/agentkit` | `budget.guardAgentKit(new X402ActionProvider())` |
| [Coinbase Agentic Wallet CLI](https://github.com/coriolislabs/WalletCap/blob/main/docs/coinbase-agentic-wallet-budget.md) | `npm install walletcap awal` | `npx walletcap awal x402 pay <url>` |
| [Coinbase payments MCP server](https://github.com/coriolislabs/WalletCap/blob/main/docs/coinbase-agentic-wallet-budget.md#the-mcp-server-one-entry-in-the-clients-config) | `npx @coinbase/payments-mcp install --client other --no-auto-config` | MCP server command: `npx walletcap awal-mcp --wallet 0x…` |
| [Coinbase Spend Permissions](https://github.com/coriolislabs/WalletCap/blob/main/docs/coinbase-spend-permissions-cap.md) | deploy `solidity/src/AccountCapSpender.sol` (testnet only, unaudited) | the agent calls `pay(permission, amount, payee)` |
| [Python](https://github.com/coriolislabs/WalletCap/blob/main/docs/python-agent-spending-limit.md) | `pip install walletcap` | `with budget.pay("$12.50"):` |

Each link opens a page with a full snippet. The [Use it](#use-it) section below covers every
integration too.

## Try it without a wallet

Two runnable demos use a fake payee and a temporary file: no wallet, chain, keys or
network.

```console
$ node examples/quickstart/quickstart.mjs
$ python3 examples/quickstart/quickstart.py
```

They show three `$0.05` payments against a `$0.15` rolling cap, a `$1.00` refusal, a
fourth `$0.05` refusal, and a restart that cannot raise the limits. The demo uses
`create: true`; a production agent opens with the default `create: false` after the
owner runs `walletcap set`.

## Why a per-wallet count

Most agent spend controls keep "spent so far" next to something temporary or repeatable: a
process, a browser window, an API key, a delegate, one permission, or a fixed calendar period.
The money, though, sits in one wallet. When the count and the wallet don't match, ordinary
events (a restart, a second replica, another key or permission, the next period) can hand the
agent a fresh budget against the same money.

ShadowPath measures spend controls against that pattern, on owned test chains with the vendors'
own code. Findings go to the vendors first; this package is the fix, not the findings.

## The fix: four rules

1. **Count per wallet.** The budget belongs to the account the money leaves from, not to a
   process, key, permission or delegate. Every payment from that wallet reserves against one
   number. Checksummed, lowercase and CAIP-10 forms of an address are one wallet, so they
   can't split it.
2. **Count over a rolling window.** "$150 a day" means any 24 hours: there is no period
   boundary to straddle.
3. **Changing a limit never resets the count.** Raising $150 to $200 after spending $150
   leaves $50, not $200. A restart can lower a limit but never raise one: if the code comes
   back asking for looser limits (a kit's defaults, say), the stored limits stay and you get a
   warning with the command that raises them on purpose.
4. **Fail closed.** If the count can't be read, nothing pays; a missing file is not a new
   budget. A payment whose outcome is unknown keeps counting, because a payment that failed
   halfway may still have moved money. An error never settles a payment.

The count lives in a SQLite file that every process on one host shares, and each payment is
reserved inside one write transaction, so replicas on that host racing for the last dollar
can't both win. JavaScript and Python read and write the same file.

## Use it

### Any payment, any rail

`pay()` reserves the amount, runs your payment, and records it as settled.

```js
const tx = await budget.pay('$5', async reservation => {
  return wallet.sendTransaction(request); // reservation.id makes a good idempotency key
}, { to: payee, note: 'weather API' });
```

If the payment throws, it may still have left the wallet, so it stays in flight, marked
unknown in the history. It counts until one window past `settlesBy`, the last moment it could
still settle (after now), if you pass one; otherwise until you check the chain and run
`npx walletcap release <id>`. If you know it didn't leave, say so and the amount comes back:

```js
import { notSent } from 'walletcap';

throw notSent(error); // inside the payment function
```

In Python, `raise NotSent("card declined")` inside the `with` block, and pass `settles_by` (a
timezone-aware datetime) to `pay()`. Set `payment.tx` in the block to keep the transaction hash
in the history, and use `async with` in async code.

If the payment went through but the budget can't record it, `pay()` throws
`PaymentNotRecorded`. It is not a `BudgetError`, so code that retries on a `BudgetError` won't
pay twice. The payment still counts as in flight.

`budget.check('$5')` answers `{ ok, reason, remaining }` without spending. `budget.reserve()`
gives you a reservation to `commit()` or `release()` yourself.

### x402

`guard()` puts the budget in front of any x402 v2 client from `@x402/core`, so it works under
`@x402/fetch`. Use it as the one counter when the client has no CDP spend store.

```js
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';

const client = budget.guard(new x402Client().register('eip155:8453', new ExactEvmScheme(account)));
const fetchPaid = wrapFetchWithPayment(fetch, client);
```

- Each payment is checked before it is signed, and reserved once its payload exists and every
  other control has passed.
- It counts as spent when the server confirms settlement, and at least until its authorization
  expires, plus one window: the confirmation is the payee's own word, and a payee that answers
  "payment failed" still holds the signed authorization too.
- A payee may ask for an authorization valid up to an hour (`MAX_PAYMENT_TIMEOUT_SECONDS`, 3600),
  as Coinbase's CDP spend controls allow. Longer terms are passed over for shorter ones on offer;
  when none are, the payment is refused before signing, with the reason `timeout`.
- USDC on Base, Ethereum, Polygon, Arbitrum, Optimism, Avalanche and Solana is priced out of
  the box, plus Base Sepolia, Arbitrum Sepolia and Solana devnet. Add another USD stablecoin with
  `budget.guard(client, { assets: [{ network, asset, decimals }] })`. List only USD-pegged
  stablecoins: each counts at $1 a token. Decimals are an integer from 0 to 18, and a built-in
  asset's decimals can't be changed. Anything else is refused, not guessed.
- `@x402/fetch` rewraps errors from payment creation, so a refusal reaches you as an `Error`
  whose message starts `Failed to create payment payload:` and carries the budget's reason.

### Coinbase CDP spend controls

There are two ways to count a CDP payment in the budget; use **one** per client.

- `budget.guard(client)` — the budget prices every asset, refuses anything it cannot price,
  and reserves in one write transaction. Use it when the budget is the counter.
- `applySpendControls(client, { ..., store: budget.cdpStore({ asset: USDC }) })` — keep
  CDP's controls, and make its count durable and shared. The store re-checks the budget inside
  the write transaction, so replicas on one host sharing the file cannot both take the last
  dollar.

`budget.cdpStore()` is walletcap's SQLite ledger behind CDP's `SpendStore` interface — **not**
CDP's in-memory default. Replacing that default is the fix, not a second control.

Do **not** call both on one client: the CDP store and the guard each record the payment, so
the budget would count it twice. `budget.guard()` refuses a client that already has CDP
controls, and a client guarded first refuses CDP controls before signing.

To use the store, swap CDP's in-memory store for walletcap's, set `maxCumulativeSpend` (CDP
only records through its store when a cumulative cap is set), and set `allowedAssets`: CDP
never consults its store for a token outside the cap.

```js
applySpendControls(client, {
  maxAmountPerPayment: { atomic: 50_000_000n, asset: USDC },
  maxCumulativeSpend: { atomic: 150_000_000n, asset: USDC },
  maxCumulativeSpendWindow: '24h',
  allowedAssets: [USDC],
  store: budget.cdpStore({ asset: USDC }),
});
```

`guard()` is the other choice, and the one that prices every token: it refuses a USD stablecoin
it cannot value instead of letting CDP count only the asset named in the cap.

walletcap's store re-checks the budget when CDP records a payment, so it holds across replicas
on one host on its own. It records the payment at its own time, not the time in CDP's entry,
and counts it until an hour (and a minute) after that, plus one window: CDP signs the payment
after recording it, and lets a payee ask for an authorization it can redeem for up to an hour.
When CDP removes a payment from its store, the store can't tell why, so the payment stays
counted as in-flight until you check the chain and run `npx walletcap release <id>`. Use CDP
1.60.0 or later: its published source refuses a `maxTimeoutSeconds` over 3600, which the store's
hour relies on. The store is tested against 1.60.0, and the crash test runs 1.61.0.

### Coinbase Agentic Wallet (awal CLI and MCP server)

Run the Agentic Wallet's CLI and MCP server through walletcap, and every payment counts in the
wallet's budget, whichever process or session on the host makes it:

```console
$ npx walletcap set --wallet 0xYourAgentWallet --per-payment 0.05 --per-day 0.15
$ npx walletcap awal x402 pay https://api.example.com/data   # instead of: npx awal x402 pay …
$ npx walletcap awal send 0.05 0xRecipient --chain base       # instead of: npx awal send …
```

For an MCP client such as Claude Desktop, start Coinbase's server behind walletcap. Install the
server once: `npx @coinbase/payments-mcp install --client other --no-auto-config` puts it in
`~/.payments-mcp`, and walletcap runs `~/.payments-mcp/bundle.js` from there. (`npx
@coinbase/payments-mcp` is the installer, not the server.) To run another server, put its
command after `--`.

```json
{ "mcpServers": { "payments": { "command": "npx", "args": ["walletcap", "awal-mcp", "--wallet", "0xYourAgentWallet"] } } }
```

- `send` and `x402 pay` (over MCP, `send` and `make_http_request_with_x402`) are checked against
  the wallet's budget before the wallet signs anything, and counted. Every other CLI command is
  the wallet's own.
- Over MCP, the tools that move no money (balance, address, sign-in, bazaar search, payment
  discovery) pass through. Any other tool, `trade` or one the server adds later, is refused and
  left out of the tool list: walletcap can't count it. `--allow-tool <name>` lets one through,
  uncounted. JSON-RPC batches are refused.
- An x402 payment is priced from the endpoint's own 402 answer, and the wallet is capped at exactly
  that amount, so it refuses to sign for more. The wallet is handed the terms walletcap priced, as
  `paymentRequirements`: the caller's, or the ones walletcap discovered. With terms handed to it,
  the wallet skips its own discovery and signs only a term equal to one of them.
- Terms valid more than an hour, or that don't give a whole number of seconds, are refused before
  the wallet is asked. Once the wallet answers, the payment counts until the longest
  `maxTimeoutSeconds` among the terms (a Solana term at least two minutes, the life of its
  blockhash), plus a minute, after that answer, plus one window, whatever the payee says about it.
- The wallet's own refusal, before it signs, gives the amount back. Any other failure, a send
  included, keeps counting as unknown until you release it: check the chain, then
  `npx walletcap release <id>`. A free endpoint's one-unit hold is given back unless the payee
  confirms a payment.
- A refusal tells the agent why, not which holds its owner could release: `walletcap holds` and
  `budget.check()` name them.
- Only USDC is counted; a send in any other asset is refused. Amounts are read exactly: `100.5abc`
  is refused, not read as $100.50.
- It binds the payments that go through it. The wallet app takes requests from any process of
  the same user, so keep the real `awal` out of an agent's reach.

### Coinbase AgentKit

AgentKit's x402 actions build their own x402 client on every call. `budget.guardAgentKit()` puts
the budget on every client the provider builds, so each payment is checked against the wallet's
budget before it is signed, whatever terms the merchant sends:

```js
import { X402ActionProvider } from '@coinbase/agentkit';

const x402 = budget.guardAgentKit(new X402ActionProvider());
// AgentKit.from({ walletProvider, actionProviders: [x402] })
```

It compiles in TypeScript, where a subclass can't override AgentKit's private
`createX402Client`. Tested against the shape of AgentKit 0.10.4.

### Coinbase Spend Permissions, on chain

For a limit the agent's own code can't go around, `solidity/src/AccountCapSpender.sol` is the
spender for Spend Permissions. Deploy it with the SpendPermissionManager, the agent's
address, the cap, the window, the per-payment max and the payees allowed. Grant Spend
Permissions to the contract instead of the agent; the agent calls
`pay(permission, amount, payee)`. Every permission the account grants it then shares one
rolling cap. The window is counted in 24 buckets, so every payment costs the same gas however
many came before it; a payment counts for up to one bucket (window/24) past its window, never
less.

## The owner's controls

```console
$ npx walletcap status
Budget file /home/you/.local/state/walletcap/budget.sqlite

0xd797…ca02: $0.15 spent of $0.15 per 24h, $0.00 left · at most $0.05 a payment

$ npx walletcap set --per-day 0.20     # what was spent still counts
$ npx walletcap freeze                 # every process, every rail, now
$ npx walletcap unfreeze
$ npx walletcap history
$ npx walletcap holds                  # open payments that still count, and why
$ npx walletcap release <id>           # an in-flight payment you know never left
$ npx walletcap release --all-unknown --older-than 24h   # every unknown or refused one older than that
```

Python ships the same commands as `walletcap`. Amounts are dollars; leave out the `$`
sign, which your shell would expand. Add `--wallet` when the file holds more than one budget,
and `--json` for scripts. A refusal names the open payments that take up the room, and
`budget.holds()` lists them in code. `release --all-unknown` leaves a payment the payee could
still settle: it counts until one window past the time it can't.

## Where the budget lives

The default file is per user: `~/.local/state/walletcap/budget.sqlite` on Linux,
`~/Library/Application Support/walletcap/budget.sqlite` on macOS, and
`%LOCALAPPDATA%\walletcap\budget.sqlite` on Windows. Set `WALLETCAP_PATH`, or pass `path`, to put it elsewhere. Both languages
compute the same default.

The file serves one host. Keep it on that host's local disk: SQLite's locks aren't reliable over
NFS, SMB or Docker Desktop bind mounts, so processes that open it through one of those can both
take the last dollar. Agents on more than one host need a shared service, which walletcap
doesn't ship yet.

The budget is as durable as that file. In a container, put it on a local volume that outlives
the container, or a redeploy starts a new file. Opening a budget does not create one: a missing
file refuses every payment. The owner creates it once with `npx walletcap set`; pass
`create: true` only for a demo or a first-run setup.

0.3 upgrades a 0.2.x file the first time it opens it, and 0.2.x can't open it afterwards, so
stop every 0.2.x process before upgrading. Budgets that 0.2.x kept under other spellings of one
wallet become one budget, with the tighter of every limit and every payment.

## What it doesn't do

- **It binds the payments that go through it.** An agent with a shell on the same machine can
  go around it: call the wallet directly, or delete the file. To bound an agent like that, keep
  the budget out of its reach (another OS user, another service) or enforce on chain, as
  `AccountCapSpender` does for Spend Permissions.
- **One file is one host.** Machines can't share a budget through a shared volume or file:
  SQLite's locks aren't reliable over NFS, SMB or Docker Desktop bind mounts. Multiple hosts need
  a shared service, which isn't shipped yet.
- **It can't see a revoke that lands later in the same block,** and for x402 schemes that settle
  later (batch vouchers), a payment counts from when the server confirms it.
- **Some x402 payments can't be confirmed.** `@x402/fetch` doesn't report v1 settlements
  back. An unconfirmed payment keeps counting until one window past the time it can no longer
  settle: the expiry the signed payment carries (an EIP-3009 `validBefore` or a Permit2
  `deadline`), or else the time it was signed plus its terms' `maxTimeoutSeconds`. On the
  Agentic Wallet, a payment the wallet never answered keeps counting until you `release` it.
- Amounts are micro-dollars. A budget, a limit or one payment is at most $1,000,000,000
  (10^15 micro-dollars), so no sum of payments can overflow.
- The ledger reads the system clock; there is no option to set it.

## This repository

| Path | What it is |
|---|---|
| `js/` | the npm package `walletcap`: the budget, the x402 guard, the CDP store, the CLI, and the Agentic Wallet CLI wrapper and MCP proxy |
| `src/walletcap/` | the PyPI package `walletcap`, on the same file format |
| `solidity/` | `AccountCapSpender`, the on-chain cap for Coinbase Spend Permissions |
| `crash-test/` | the crash test: CDP's spend controls and walletcap through the same events, in dollars |
| `tests/` | the Python suite, including the tests that drive both languages against one budget file |
| `spec/vectors/` | the amounts both suites must read the same way, or refuse |
| `docs/` | the docs site for GitHub Pages: one page per integration, each with a full snippet, plus the threat model |
| `llms.txt` | a summary of the package and links to the docs, for language models |

```console
$ cd js && npm install && node --test            # 104 tests
$ uv run --with pytest pytest -q                 # 142 tests, from the repository root
$ cd solidity/evm && npm install && node check.mjs ..   # the contract on an EVM, no Foundry needed
$ cd solidity && forge test                      # the contract's canonical tests, if you have Foundry
```

The JavaScript suite runs the x402 guard against x402's own client and fetch wrapper, and runs
restarts and racing replicas as separate processes, and drives the Agentic Wallet wrapper and
MCP proxy against stand-ins for Coinbase's wallet and MCP server. It builds AgentKit's x402
client the way AgentKit 0.10.4 does, and type-checks the AgentKit recipe with `tsc` against
AgentKit's declared types. The Python suite covers the ledger, the API,
the CLI and one budget shared between both languages. Both suites read the amounts in
`spec/vectors/money.json`, and a Python test checks 15,000 floats against Node. `solidity/evm/check.mjs` compiles the
contract with solc-js and drives it on an in-process EVM, covering what the Foundry tests cover.

The JavaScript suite also drives the published `@coinbase/cdp-sdk@1.60.0` through the
shared store, so the CDP integration is covered against the package users install.

## Security and audit

- [Security policy](SECURITY.md): how to report a vulnerability, supported versions,
  and the 90-day coordinated-disclosure window for walletcap itself.
- [Threat model](docs/threat-model.md): what the guard stops, what it does not, and the
  deployment patterns that hold.
- [Vendor benchmark disclosure](docs/vendor-disclosure.md): the separate 7-day
  pre-publication notice for vendor findings in the Agent Payment Benchmark.
- `AccountCapSpender` is **unaudited**. Read [solidity/README.md](solidity/README.md)
  before deploying it; testnet only until an independent audit.

## Prove it holds in your deployment

This package closes the gaps ShadowPath measured. Whether your configuration is closed is a
measurement: ShadowPath runs your agent with every control switched on and certifies, in
dollars, what can still get past your budget, signed and re-checkable offline.
[Get a certificate for your deployment](mailto:paul@coriolislabs.ca).

Apache-2.0. Copyright 2026 Coriolis Labs Inc.
