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
1.0.0 and walletcap 0.2.3. The crash test in this repository now runs walletcap 0.4.0, and its
suite fails if the guard or the cdpStore lets anything past the cap.

Add `--agentkit` for Coinbase AgentKit's row: the agent approves a 1¢ offer, and AgentKit signs
the merchant's first-listed $1.00 on Base mainnet. walletcap, at 2¢ a payment, limits the amount,
not which offer is paid: it passes over the $1.00, valid 4 days, and the offer left is the 1¢ the
agent approved. [The crash test's README](https://github.com/coriolislabs/WalletCap/tree/main/bench/crash-test)
says exactly what runs.

## Install and use

```console
$ npm install walletcap     # Node 22.13+, no runtime dependencies
$ pip install walletcap     # Python 3.11+, no dependencies
```

The owner creates the budget once. Opening it never creates one; pass `create: true` only for a
demo or first-run setup:

```console
$ npx walletcap set --wallet 0xYourAgentWallet --per-payment 50 --per-day 150
```

```js
import { openBudget } from 'walletcap';

const budget = await openBudget({ wallet: account.address });

await budget.pay('$12.50', () => sendUsdc(payee, '12.50')); // refused past $150 in any 24h, restarts included
```

```python
from walletcap import open_budget

budget = open_budget(agent_address)

with budget.pay("$12.50") as payment:
    payment.tx = send_usdc(payee, "12.50")
```

| Integration | Install | Use |
|---|---|---|
| [Any x402 client](https://github.com/coriolislabs/WalletCap/blob/main/docs/x402-spending-limit.md) (`@x402/core`, `@x402/fetch`) | `npm install walletcap` | `guard(client, budget)` from `walletcap/x402` |
| [Coinbase CDP x402 spend controls](https://github.com/coriolislabs/WalletCap/blob/main/docs/coinbase-cdp-spend-controls.md) | `npm install walletcap @coinbase/cdp-sdk` | `store: cdpStore(budget, { asset: USDC })` in `applySpendControls` |
| [Coinbase AgentKit](https://github.com/coriolislabs/WalletCap/blob/main/docs/coinbase-agentkit-spending-limit.md) | `npm install walletcap @coinbase/agentkit` | `guardAgentKit(new X402ActionProvider(), budget)` from `walletcap/agentkit` |
| [Coinbase Agentic Wallet CLI](https://github.com/coriolislabs/WalletCap/blob/main/docs/coinbase-agentic-wallet-budget.md) | `npm install walletcap awal` | `npx walletcap awal x402 pay <url>` |
| [Coinbase payments MCP server](https://github.com/coriolislabs/WalletCap/blob/main/docs/coinbase-agentic-wallet-budget.md#the-mcp-server-one-entry-in-the-clients-config) | `npx @coinbase/payments-mcp install --client other --no-auto-config` | MCP server command: `npx walletcap-mcp --wallet 0x…` |
| [Coinbase Spend Permissions](https://github.com/coriolislabs/WalletCap/blob/main/docs/coinbase-spend-permissions-cap.md) | deploy `contracts/src/AccountCapSpender.sol` (testnet only, unaudited) | the agent calls `pay(permission, amount, payee)` |
| [Python](https://github.com/coriolislabs/WalletCap/blob/main/docs/python-agent-spending-limit.md) | `pip install walletcap` | `with budget.pay("$12.50"):` |

Each link opens a page with a full snippet. The [Use it](#use-it) section below covers every
integration too.

## Try it without a wallet

Two runnable demos use a fake payee and a temporary file: no wallet, chain, keys or network.

```console
$ npm install && npm run build --workspace packages/js
$ node examples/quickstart/quickstart.mjs
$ python3 examples/quickstart/quickstart.py
```

They show three `$0.05` payments against a `$0.15` rolling cap, a `$1.00` refusal, a fourth
`$0.05` refusal, and a restart whose code asks for looser limits and still gets the stored ones.
The demo uses `create: true`; a production agent opens with the default `create: false` after
the owner runs `walletcap set`.

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
   process, key, permission or delegate. Every payment from that wallet is held against one
   number. Checksummed, lowercase and CAIP-10 forms of an address are one wallet, so they
   can't split it.
2. **Count over a rolling window.** "$150 a day" means any 24 hours: there is no period
   boundary to straddle.
3. **Changing a limit never resets the count.** Raising $150 to $200 after spending $150
   leaves $50. Only the owner changes the stored limits. Code that opens the budget can tighten
   the limits for its own process; if it asks for looser ones (a kit's defaults, say), the
   stored limits apply and it gets a warning with the command that raises them.
4. **Fail closed.** If the count can't be read, nothing pays; a missing file is not a new
   budget. A payment whose outcome is unknown keeps counting, because a payment that failed
   halfway may still have moved money. An error never settles a payment.

## How it counts

The rule lives in one place: [`spec/schema.sql`](spec/schema.sql), which both packages ship and
run as written. [`spec/ledger.md`](spec/ledger.md) explains it.

- A payment is `HELD` from the moment it is admitted, then `SETTLED` on evidence that it paid,
  or `VOID` on evidence that it never moved money. States only move forward, and `VOID` can
  still become `SETTLED`. Every state is a row appended to the ledger; none is changed or
  deleted.
- A held payment counts through one window past the last moment it could settle, or until
  evidence ends it if nothing bounds that moment. A settled one counts through one window past
  its settlement, or past its hold's settle-by time if that is later. A void one counts nothing.
- Admission is one conditional `INSERT` inside a write transaction, so two processes, in either
  language, can't both take the last dollar. A trigger checks the same rule on every insert,
  including one made from the `sqlite3` shell.
- The ledger reads its own clock in SQL. No caller passes the time it is dated by.
- A payment is keyed by its rail's own identity where there is one (an EIP-3009 authorization
  is `eip3009:<from>:<nonce>`), so one signature counts once.

The JavaScript and Python test suites run the same golden vectors in
[`spec/vectors/`](spec/vectors), whole admission sequences with their expected refusals.

## Use it

### Any payment, any rail

`pay()` holds the amount, runs your payment, and settles it.

```js
const tx = await budget.pay('$5', async hold => {
  return wallet.sendTransaction(request); // hold.id makes a good idempotency key
}, { to: payee, note: 'weather API' });
```

If the payment throws, it may still have left the wallet, so it stays held, noted unknown. It
counts until one window past `settlesBy`, the last moment it could still settle (after now), if
you pass one; otherwise until you check the chain and run `npx walletcap void <id>`. If you know
it didn't leave, say so and the amount comes back:

```js
import { notSent } from 'walletcap';

throw notSent(error); // inside the payment function
```

For more control, `hold()` gives you the payment's handle:

```js
const id = `order-${orderId}`;
// A retry after a restart finds the earlier payment: look, don't pay again.
if ((await budget.payment(id)) === null) {
  const hold = await budget.hold('$5', { id, settlesWithin: 300_000 });
  try {
    const tx = await sendUsdc(payee, '5');
    await hold.settle({ tx });
  } catch (error) {
    if (neverBroadcast(error)) await hold.void({ evidence: String(error) });
    else await hold.note('unknown', String(error)); // it keeps counting
  }
}
```

- One id is one payment, held once. Holding an id that is already in the ledger throws
  `UsageError`, whose `paymentState` says where that payment stands, whatever room the budget
  has left; `pay()` refuses it before your function runs. A process that restarts looks its
  payment up with `budget.payment(id)` instead of holding it again. Only the hold that took a
  payment can settle, void or note it; another process can't. A voided id can't be held again:
  a retry takes a new id.
- `hold.settlesBy(date)` or `hold.settlesWithin(ms)` tells an open hold, once, the last moment
  it could settle.
- If the payment went through but the budget can't record it, `pay()` throws
  `PaymentNotRecorded`. It shares no base class with the other errors, so code that retries on
  them won't pay twice. The payment still counts as held.
- `budget.check('$5')` answers `{ ok, remaining, code, source, message, brief }` without spending:
  `source` says whether the owner's limit (`budget`) or this process's own (`process`) would
  refuse, and every field but `ok` and `remaining` is `null` when it would be paid.
  `budget.status()`, `budget.history()` and `budget.holds()` read the count.
- Every method is async. Each try at the file can hold the event loop for up to about 10 ms, the
  wait SQLite itself makes for a lock; between tries, a wait for another process's write lock
  happens on the event loop, in steps of up to 50 ms, for at most `busyTimeoutMs` (30,000 by
  default).

Errors are four classes with no common base:

| Error | When |
|---|---|
| `BudgetUnavailable` | the budget can't be read or written: no file, no budget for the wallet, a lock held past `busyTimeoutMs`, SQLite older than 3.37.0, a newer file format |
| `BudgetRefused` | a limit refused the payment; `code` is `budget`, `per_payment`, `max_payments`, `frozen`, `asset`, `timeout` or `terms`, `brief` is what an agent should be told, and `source` says whether the budget's limits or the process's own refused |
| `PaymentNotRecorded` | the payment went through, or may have, but couldn't be recorded; `paymentId` names it. Don't pay again |
| `UsageError` | the call was malformed, or doesn't fit the payment's state |

### Python

The Python package has the same handles and errors under Python names:

```python
from datetime import timedelta
from walletcap import BudgetRefused, NotSent, open_budget

budget = open_budget(agent_address, per_payment="$5")  # tighter than the stored limit: this process only

hold = budget.hold("$5", id=f"order-{order_id}", settles_within=timedelta(minutes=5))
try:
    hold.settle(tx=send_usdc(payee, "5"))
except BroadcastFailed:
    hold.void(evidence="never broadcast")
```

- Inside `with budget.pay(...)`, set `payment.tx` to keep the transaction hash, and raise
  `NotSent("card declined")` when you know it didn't leave. `settles_by` takes a timezone-aware
  datetime; a naive one is refused.
- Amounts come back as `Micros`, a micro-dollar amount. `to_micros` reads a `Micros` as
  micro-dollars and a plain `int` as whole dollars, so `budget.check(budget.status().remaining)`
  means what it says. Arithmetic on a `Micros` returns a `Micros` or raises `TypeError`:
  `remaining // 2` is half of it, and `remaining + 1`, `remaining * 1.5` or `remaining / 2` is
  refused, since a bare number would be read as dollars.
- In async code, `async with budget.pay(...)` and `acheck`, `ahold`, `astatus`, `aholds` and
  `ahistory` wait for another process's lock in a worker thread, through `asyncio.to_thread`.
  If the task is cancelled while it waits, the hold the thread takes is voided.

### x402

`guard()` from `walletcap/x402` puts the budget in front of any x402 v2 client from
`@x402/core`, so it works under `@x402/fetch`. Use it as the one counter when the client has no
CDP spend store.

```js
import { openBudget } from 'walletcap';
import { guard } from 'walletcap/x402';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';

const budget = await openBudget({ wallet: account.address });
const client = guard(new x402Client().register('eip155:8453', new ExactEvmScheme(account)), budget);
const fetchPaid = wrapFetchWithPayment(fetch, client);
```

- Each payment is checked before it is signed, and held once its payload exists and every
  other control has passed, under the authorization's own identity.
- It counts as settled when the server confirms settlement, and at least until its
  authorization expires, plus one window: the confirmation is the payee's own word, and a payee
  that answers "payment failed" still holds the signed authorization too.
- A payee may ask for an authorization valid up to an hour (`MAX_PAYMENT_TIMEOUT_SECONDS`, 3600),
  as Coinbase's CDP spend controls allow. Longer terms are passed over for shorter ones on offer;
  when none are, the payment is refused before signing, with the code `timeout`.
- USDC on Base, Ethereum, Polygon, Arbitrum, Optimism, Avalanche and Solana is priced out of
  the box, plus Base Sepolia, Arbitrum Sepolia and Solana devnet (`USD_ASSETS`). Add another USD
  stablecoin with `guard(client, budget, { assets: [{ network, asset, decimals }] })`. List only
  USD-pegged stablecoins: each counts at $1 a token. Decimals are an integer from 0 to 18, and a
  built-in asset's decimals can't be changed. Anything else is refused, with the code `asset`.
- `@x402/fetch` rewraps errors from payment creation, so a refusal reaches you as an `Error`
  whose message starts `Failed to create payment payload:` and carries the budget's reason.

### Coinbase CDP spend controls

There are two ways to count a CDP payment in the budget; use **one** per client.

- `guard(client, budget)`: the budget prices every asset, refuses anything it cannot price,
  and holds each payment in one write transaction. Use it when the budget is the counter.
- `applySpendControls(client, { ..., store: cdpStore(budget, { asset: USDC }) })`: keep CDP's
  controls, and make its count durable and shared. The store holds each payment through the
  ledger's own admission, so replicas on one host can't both take the last dollar.

`cdpStore()` from `walletcap/cdp` is walletcap's ledger behind CDP's `SpendStore` interface, in
place of CDP's in-memory default. With both the store and the guard on one client, the budget
would count each payment twice: `guard()` refuses a client that already has CDP controls, and a
client guarded first refuses CDP controls before signing.

Set `maxCumulativeSpend` (CDP only records through its store when a cumulative cap is set), and
set `allowedAssets`: CDP never consults its store for a token outside the cap.

```js
import { cdpStore } from 'walletcap/cdp';

applySpendControls(client, {
  maxAmountPerPayment: { atomic: 50_000_000n, asset: USDC },
  maxCumulativeSpend: { atomic: 150_000_000n, asset: USDC },
  maxCumulativeSpendWindow: '24h',
  allowedAssets: [USDC],
  store: cdpStore(budget, { asset: USDC }),
});
```

In TypeScript with `node16` or `nodenext` module resolution, that call fails to compile with
`@coinbase/cdp-sdk` 1.60 and 1.61, with or without walletcap: TS2345 at `client`. The SDK ships
one set of declarations, which TypeScript reads as CommonJS there, so `applySpendControls` takes
`@x402/core`'s CommonJS `x402Client`, a different type from the ESM one your code imports. At run
time Node loads the ESM build of both, so the client is the same class. Write
`client as unknown as Parameters<typeof applySpendControls>[0]`, or compile with
`"moduleResolution": "bundler"`.

The store holds each payment from the ledger's own time, not the time in CDP's entry, until an
hour and a minute after CDP records it, and it counts for one window after that: CDP signs the
payment after recording it, and lets a payee ask for an authorization it can redeem for up to an
hour. CDP's record isn't evidence that the payment settled, so it shows as in flight. When CDP
removes a payment from its store, the store can't tell why: the payment keeps counting for the
same time, noted refused, unless its owner voids it sooner. `walletcap holds` and a refusal's
message mark each one: CDP signed it, so void it only if the chain shows it was never redeemed.
Use CDP 1.60.0 or later: its published source refuses a `maxTimeoutSeconds` over 3600, which
the store's hour relies on. The store is tested against 1.60.0, and the crash test runs 1.61.0.

### Coinbase Agentic Wallet (awal CLI and MCP server)

Run the Agentic Wallet's CLI through walletcap, and its MCP server through `walletcap-mcp`, and
every payment counts in the wallet's budget, whichever process or session on the host makes it:

```console
$ npx walletcap set --wallet 0xYourAgentWallet --per-payment 0.05 --per-day 0.15
$ npx walletcap awal x402 pay https://api.example.com/data   # instead of: npx awal x402 pay …
$ npx walletcap awal send 0.05 0xRecipient --chain base       # instead of: npx awal send …
```

For an MCP client such as Claude Desktop, start Coinbase's server behind `walletcap-mcp`. Install
the server once: `npx @coinbase/payments-mcp install --client other --no-auto-config` puts it in
`~/.payments-mcp`, and `walletcap-mcp` runs `~/.payments-mcp/bundle.js` from there. To run
another server, put its command after `--`.

```json
{ "mcpServers": { "payments": { "command": "npx", "args": ["walletcap-mcp", "--wallet", "0xYourAgentWallet"] } } }
```

- `send` and `x402 pay` (over MCP, `send` and `make_http_request_with_x402`) are checked against
  the wallet's budget before the wallet signs anything, and counted. Every other CLI command is
  the wallet's own.
- Over MCP, the tools that move no money (balance, address, sign-in, bazaar search, payment
  discovery) pass through. Any other tool, `trade` or one the server adds later, is refused and
  left out of the tool list: walletcap can't count it. `--allow-tool <name>` lets one through,
  uncounted. JSON-RPC batches are refused.
- An x402 payment is priced from the endpoint's own 402 answer, and the wallet is capped at
  exactly that amount, so it refuses to sign for more. The wallet is handed, as
  `paymentRequirements`, the terms walletcap can price that are valid an hour or less, from the
  caller's or the ones walletcap discovered; the rest are left out. With terms handed to it, the
  wallet skips its own discovery and signs only a term equal to one of them.
- With no such terms left, the payment is refused before the wallet is asked. Once the wallet
  answers, the payment counts until the longest `maxTimeoutSeconds` among the terms it was handed
  (a Solana term at least two minutes, the life of its blockhash), plus a minute, after that
  answer, plus one window, whatever the payee says about it.
- Any failure the wallet reports keeps the payment held, noted unknown, until you check the chain
  and void it: walletcap doesn't read an error's text to decide that nothing was signed. A free
  endpoint's one-unit hold is given back unless the payee confirms a payment. The bulk release
  leaves a `send`: void it by id once the chain shows it never moved.
- A refusal tells the agent why, not which holds its owner could void: `walletcap holds` and
  `budget.check().message` name them.
- Only USDC is counted; a send in any other asset is refused. Amounts are read exactly: `100.5abc`
  is refused, not read as $100.50.
- It binds the payments that go through it. The wallet app takes requests from any process of
  the same user, so keep the real `awal` out of an agent's reach.

In code, the wrapper is `guardAgenticWallet()` from `walletcap/agentic`. Give it the wallet's own
request channel (awal's `sendIpcRequest`), and send through the `request` it returns:

```js
import { openBudget } from 'walletcap';
import { guardAgenticWallet } from 'walletcap/agentic';

const budget = await openBudget({ wallet: '0xYourAgentWallet' });
const wallet = guardAgenticWallet(budget, { request: sendIpcRequest });
await wallet.request('send-transaction', { recipient: payee, amountAtomic: '50000', asset: 'USDC', chain: 'base' });
```

### Coinbase AgentKit

AgentKit's x402 actions build their own x402 client on every call. `guardAgentKit()` from
`walletcap/agentkit` puts the budget on every client the provider builds, so each payment is
checked against the wallet's budget before it is signed, whatever terms the merchant sends:

```js
import { X402ActionProvider } from '@coinbase/agentkit';
import { openBudget } from 'walletcap';
import { guardAgentKit } from 'walletcap/agentkit';

const budget = await openBudget({ wallet: '0xYourAgentWallet' });
const x402 = guardAgentKit(new X402ActionProvider(), budget);
// AgentKit.from({ walletProvider, actionProviders: [x402] })
```

It compiles in TypeScript, where a subclass can't override AgentKit's private
`createX402Client`; the test suite type-checks this recipe with `tsc`. Tested against the shape
of AgentKit 0.10.4.

### Coinbase Spend Permissions, on chain

For a limit the agent's own code can't go around, `contracts/src/AccountCapSpender.sol` is the
spender for Spend Permissions. Deploy it with the SpendPermissionManager, the agent's address,
the cap, the window, the per-payment max and the payees allowed. Grant Spend Permissions to the
contract instead of the agent; the agent calls `pay(permission, amount, payee)`. Every
permission the account grants it then shares one rolling cap. The window is counted in 24
buckets, so every payment costs the same gas however many came before it; a payment counts for
up to one bucket (window/24) past its window, never less.

## The owner's controls

The owner's handle sets limits, freezes the budget, and reconciles payments with evidence. The
`walletcap` command is that handle, with the same commands and output in both languages
(`npx walletcap`, or `walletcap` and `python -m walletcap` from the PyPI package):

```console
$ npx walletcap status
Budget file /home/you/.local/state/walletcap/budget.sqlite

0xd797…ca02: $0.15 spent of $0.15 per 24h, $0.00 left · at most $0.05 a payment

$ npx walletcap set --per-day 0.20     # what was spent still counts
$ npx walletcap freeze                 # every process, every rail, now
$ npx walletcap unfreeze
$ npx walletcap history
$ npx walletcap holds                  # held payments that still count, and why
$ npx walletcap void <id> --evidence "never mined"   # a held payment you know never left the wallet
$ npx walletcap void --all-unknown --older-than 24h   # every unknown or refused one older than that
$ npx walletcap settle <id> --tx 0x…   # a payment you know paid
```

Amounts are dollars; leave out the `$` sign, which your shell would expand. Add `--wallet` when
the file holds more than one budget, and `--json` for scripts. Exit codes: 0 when it worked; 2
when the command line is wrong (an unknown command or flag, a missing argument, a payment id not
in the file); 1 for anything walletcap refused or couldn't do.

`void --all-unknown` leaves a payment the payee could still settle: it counts until one window
past the time it can't. An x402 payment with no such time, one the wallet may have signed as it
failed, stays until an hour and a minute after its failure: an authorization walletcap lets be
signed is valid for an hour at most. Any other payment with no such time, a transfer say, can still be
mined however old it is, so the bulk release leaves it: void it by id once the chain shows it
never moved.

In code, the same handle is `openOwner()` in JavaScript and `open_owner()` in Python:

```js
import { openOwner } from 'walletcap';

const owner = await openOwner();
await owner.setLimits('0xYourAgentWallet', { perPayment: '$50', perDay: '$150' });
await owner.void(paymentId, { evidence: 'authorization unused past its validBefore' });
await owner.voidUnknown('0xYourAgentWallet', { olderThan: '24h' });
```

## Where the budget lives

The default file is per user: `~/.local/state/walletcap/budget.sqlite` on Linux,
`~/Library/Application Support/walletcap/budget.sqlite` on macOS, and
`%LOCALAPPDATA%\walletcap\budget.sqlite` on Windows. Set `WALLETCAP_PATH`, or pass `path`, to
put it elsewhere. Both languages compute the same default.

- The file serves one host. Keep it on that host's local disk: SQLite's locks aren't reliable
  over NFS, SMB or Docker Desktop bind mounts, so processes that open it through one of those
  can both take the last dollar.
- walletcap creates the file `0600`, in a `0700` folder, and opens it in WAL mode with
  `synchronous = FULL`: the log is synced at every commit, so a payment the ledger admitted
  survives the process crashing. It needs SQLite 3.37.0 or later, and refuses an older one.
- The budget is as durable as that file. In a container, put it on a local volume that outlives
  the container, or a redeploy starts a new file. A missing file refuses every payment.
- walletcap 0.4 upgrades a file that 0.2 or 0.3 wrote the first time it opens it, in one
  transaction: every payment that counted keeps counting at least as long. 0.2 and 0.3 can't
  open the file afterwards, so stop every 0.2 and 0.3 process before upgrading. One that opens
  the file anyway adds two empty tables of its own, `budgets` and `spend`, before it refuses it;
  0.4 drops them the next time it opens the file with write access. They change no count.

## What it doesn't do

walletcap has three tiers of enforcement, and the library is the one that ships today.

- **The library advises.** It runs in the agent's process and binds the payments that go through
  it. It bounds bugs and runaways. An agent with a shell as the same OS user can go around it:
  call the wallet directly, edit the budget file, drop its triggers or delete it. The payer and
  owner handles are an API split, not an OS boundary: any process that can open the file can
  open an owner's handle, and read the token that ties a payment's moves to the hold that took
  it. A separate service under its own OS user, with peer-credential checks
  on a Unix socket (`walletcapd`), is planned.
- **On chain, the limit binds.** `AccountCapSpender` makes the cap part of the payment path for
  Spend Permissions, so the agent's own code can't raise it. It is unaudited; testnet only.
- **One file is one host.** Network filesystems aren't supported, and walletcap doesn't detect
  them yet. Agents on more than one host need a shared service, which isn't shipped.
- **It can't see a revoke that lands later in the same block,** and for x402 schemes that settle
  later (batch vouchers), a payment counts from when the server confirms it.
- **Some x402 payments can't be confirmed.** `@x402/fetch` doesn't report v1 settlements back.
  An unconfirmed payment keeps counting until one window past the time it can no longer settle:
  the expiry the signed payment carries (an EIP-3009 `validBefore` or a Permit2 `deadline`), or
  else its terms' `maxTimeoutSeconds` from when it was held. On the Agentic Wallet, a payment the
  wallet never answered keeps counting until you void it.
- Amounts are micro-dollars. A budget, a limit or one payment is at most $1,000,000,000
  (10^15 micro-dollars), so no sum of payments can overflow.

[docs/threat-model.md](docs/threat-model.md) lists every adversary and what stops it.

## This repository

| Path | What it is |
|---|---|
| `spec/` | the ledger: [`ledger.md`](spec/ledger.md) (the state machine and its invariant), `schema.sql` (the rule both packages run), `upgrade.sql`, golden vectors, and files 0.2 and 0.3 wrote |
| `packages/js/` | the npm package `walletcap`: the payer and owner handles, the CLI, and the adapters `walletcap/x402`, `walletcap/cdp`, `walletcap/agentkit` and `walletcap/agentic`, in TypeScript |
| `packages/mcp/` | the npm package `walletcap-mcp`: Coinbase's payments MCP server behind the budget |
| `packages/python/` | the PyPI package `walletcap`, on the same file and the same SQL |
| `contracts/` | `AccountCapSpender`, the on-chain cap for Coinbase Spend Permissions (Foundry) |
| `bench/crash-test/` | the crash test: CDP's spend controls and walletcap through the same events, in dollars |
| `docs/` | the docs site: one page per integration, the threat model and the [design records](docs/adr/) |
| `llms.txt` | a summary of the package and links to the docs, for language models |

```console
$ npm install && npm test --workspaces --if-present     # walletcap, walletcap-mcp and the crash test
$ cd packages/python && uv run --with pytest pytest -q  # the Python package
$ cd contracts && forge test                            # the contract's Foundry tests
$ cd contracts/evm && npm install && node check.mjs ..  # the contract on an EVM, no Foundry needed
```

The suites drive the x402 guard against x402's own client and fetch wrapper, the CDP store
against the published `@coinbase/cdp-sdk` 1.60.0, and the Agentic Wallet wrapper and MCP proxy
against stand-ins for Coinbase's wallet and MCP server. They run restarts and racing replicas as
separate processes, in both languages on one file, and open files 0.2.4 and 0.3.0 wrote to check
the upgrade counts what 0.3.0 counted.

## Security and audit

- [Security policy](SECURITY.md): how to report a vulnerability, supported versions,
  and the 90-day coordinated-disclosure window for walletcap itself.
- [Threat model](docs/threat-model.md): what the library stops, what it does not, and the
  deployment patterns that hold.
- [What is public API](STABILITY.md), and how versions change it.
- `AccountCapSpender` is **unaudited**. Read [contracts/README.md](contracts/README.md)
  before deploying it; testnet only until an independent audit.

## Prove it holds in your deployment

This package closes the gaps ShadowPath measured. Whether your configuration is closed is a
measurement: ShadowPath runs your agent with every control switched on and certifies, in
dollars, what can still get past your budget, signed and re-checkable offline.
[Get a certificate for your deployment](mailto:paul@coriolislabs.ca).

Apache-2.0. Copyright 2026 Coriolis Labs Inc.
