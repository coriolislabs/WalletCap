<!-- SPDX-License-Identifier: Apache-2.0 -->
# walletcap

[![CircleCI](https://dl.circleci.com/status-badge/img/circleci/9kf5Wo9wYAuLZHsV9nFTQC/Pcdc3JTt5shsZfYpip6SBB/tree/main.svg?style=svg)](https://app.circleci.com/pipelines/circleci/9kf5Wo9wYAuLZHsV9nFTQC/Pcdc3JTt5shsZfYpip6SBB)

**Your agent's spending limit forgets. This one doesn't.** By ShadowPath.

Agent payment kits count "spent so far" per process, per key, per permission or per
period. So a restart, a second replica, one more key, or the next period hands the agent a
fresh budget. walletcap counts **per wallet**: one budget that every process,
replica, key, permission and payment rail spends from.

The owner creates the budget once. Opening it never creates one; pass `create: true` only
for a demo or first-run setup:

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

`npm install walletcap` (Node 22.13+) · `pip install walletcap` (Python 3.11+) ·
no dependencies · Apache-2.0

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
   halfway may still have moved money.

The count lives in a SQLite file that every process on the machine shares, and each payment is
reserved inside one write transaction, so replicas racing for the last dollar can't both win.
JavaScript and Python read and write the same file.

## Use it

### Any payment, any rail

`pay()` reserves the amount, runs your payment, and records it as settled.

```js
const tx = await budget.pay('$5', async reservation => {
  return wallet.sendTransaction(request); // reservation.id makes a good idempotency key
}, { to: payee, note: 'weather API' });
```

If the payment throws, it still counts, because it may have left the wallet. If you know it
didn't, say so and the amount comes back:

```js
import { notSent } from 'walletcap';

throw notSent(error); // inside the payment function
```

In Python, `raise NotSent("card declined")` inside the `with` block. Set `payment.tx` in the
block to keep the transaction hash in the history, and use `async with` in async code.

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
- It counts as spent when the server confirms settlement. A payee that answers "payment
  failed" still holds your signed authorization and could settle it until it expires, so the
  payment keeps counting until then.
- USDC on Base, Ethereum, Polygon, Arbitrum, Optimism, Avalanche and Solana is priced out of
  the box, plus Base Sepolia, Arbitrum Sepolia and Solana devnet. Add another USD stablecoin with
  `budget.guard(client, { assets: [{ network, asset, decimals }] })`. Anything else is refused,
  not guessed.
- `@x402/fetch` rewraps errors from payment creation, so a refusal reaches you as an `Error`
  whose message starts `Failed to create payment payload:` and carries the budget's reason.

### Coinbase CDP spend controls

There are two ways to count a CDP payment in the budget; use **one** per client.

- `budget.guard(client)` — the budget prices every asset, refuses anything it cannot price,
  and reserves in one write transaction. Use it when the budget is the counter.
- `applySpendControls(client, { ..., store: budget.cdpStore({ asset: USDC }) })` — keep
  CDP's controls, and make its count durable and shared. The store re-checks the budget inside
  the write transaction, so replicas sharing the file cannot both take the last dollar.

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
on its own. When CDP removes a payment from its store, the store can't tell why, so the payment
stays counted as in-flight until you check the chain and run `npx walletcap release <id>`. Use
CDP 1.56.0 or later; the store is tested against the published 1.60.0.

### Coinbase Agentic Wallet (awal CLI and MCP server)

Run the Agentic Wallet's CLI and MCP server through walletcap, and every payment counts in the
wallet's budget, whichever process, session or machine makes it:

```console
$ npx walletcap set --wallet 0xYourAgentWallet --per-payment 0.05 --per-day 0.15
$ npx walletcap awal x402 pay https://api.example.com/data   # instead of: npx awal x402 pay …
$ npx walletcap awal send 0.05 0xRecipient --chain base       # instead of: npx awal send …
```

For an MCP client such as Claude Desktop, start Coinbase's server behind walletcap. It runs
`npx -y @coinbase/payments-mcp`; put another command after `--`.

```json
{ "mcpServers": { "payments": { "command": "npx", "args": ["walletcap", "awal-mcp", "--wallet", "0xYourAgentWallet"] } } }
```

- `send` and `x402 pay` (over MCP, `send` and `make_http_request_with_x402`) are checked against
  the wallet's budget before the wallet signs anything, and counted. Every other command and tool
  is the wallet's own.
- An x402 payment is priced from the endpoint's own 402 answer, and the wallet is capped at exactly
  that amount, so it refuses to sign for more.
- A payment the payee confirms as settled counts for one window. One it doesn't confirm keeps
  counting until you release it: the wallet signs whatever validity the payee asks for, and
  walletcap can't see it. Check the chain, then `npx walletcap release <id>`.
- The wallet's own refusal, before it signs, gives the amount back. Any other failure keeps
  counting.
- Only USDC is counted; a send in any other asset is refused.
- Machines share a budget when they share its file (a shared volume). Separate hosts without one
  wait for the Postgres backend.
- It binds the payments that go through it. The wallet app takes requests from any process of
  the same user, so keep the real `awal` out of an agent's reach.

### Coinbase AgentKit

AgentKit's x402 actions build their own x402 client on every call. Put the budget on that client
with a three-line subclass, and every payment is checked against the wallet's budget before it
is signed, whatever terms the merchant sends:

```js
import { X402ActionProvider } from '@coinbase/agentkit';

class BudgetedX402ActionProvider extends X402ActionProvider {
  async createX402Client(walletProvider) {
    return budget.guard(await super.createX402Client(walletProvider));
  }
}
// AgentKit.from({ walletProvider, actionProviders: [new BudgetedX402ActionProvider()] })
```

### Coinbase Spend Permissions, on chain

For a limit the agent's own code can't go around, `solidity/src/AccountCapSpender.sol` is the
spender for Spend Permissions. Deploy it with the SpendPermissionManager, the agent's
address, the cap, the window, the per-payment max and the payees allowed. Grant Spend
Permissions to the contract instead of the agent; the agent calls
`pay(permission, amount, payee)`. Every permission the account grants it then shares one
rolling cap.

## The owner's controls

```console
$ npx walletcap status
Budget file /home/you/.local/state/walletcap/budget.sqlite

0xd797…ca02: $0.15 spent of $0.15 per 24h, $0.00 left · at most $0.05 a payment

$ npx walletcap set --per-day 0.20     # what was spent still counts
$ npx walletcap freeze                 # every process, every rail, now
$ npx walletcap unfreeze
$ npx walletcap history
$ npx walletcap release <id>           # an in-flight payment you know never left
```

Python ships the same commands as `walletcap`. Amounts are dollars; leave out the `$`
sign, which your shell would expand. Add `--wallet` when the file holds more than one budget,
and `--json` for scripts.

## Where the budget lives

The default file is per user: `~/.local/state/walletcap/budget.sqlite` on Linux,
`~/Library/Application Support/walletcap/budget.sqlite` on macOS, and
`%LOCALAPPDATA%\walletcap\budget.sqlite` on Windows. Set `WALLETCAP_PATH`, or pass `path`, to put it elsewhere. Both languages
compute the same default.

The budget is as durable as that file. In a container, put it on a volume that outlives the
container, or a redeploy starts a new file. Opening a budget does not create one: a missing file
refuses every payment. The owner creates it once with `npx walletcap set`; pass `create: true`
only for a demo or a first-run setup.

## What it doesn't do

- **It binds the payments that go through it.** An agent with a shell on the same machine can
  go around it: call the wallet directly, or delete the file. To bound an agent like that, keep
  the budget out of its reach (another OS user, another service) or enforce on chain, as
  `AccountCapSpender` does for Spend Permissions.
- **One file is one host, or a shared volume.** A Postgres backend for replicas on separate
  hosts is next.
- **It can't see a revoke that lands later in the same block,** and for x402 schemes that settle
  later (batch vouchers), a payment counts from when the server confirms it.
- **Some x402 payments can't be confirmed.** `@x402/fetch` doesn't report v1 settlements
  back, and only the exact EVM scheme carries an expiry the guard can read. An unconfirmed
  payment keeps counting until its authorization expires plus one window, or, with no expiry,
  until you `release` it.
- Amounts are micro-dollars and must fit in 64 bits.

## This repository

| Path | What it is |
|---|---|
| `js/` | the npm package `walletcap`: the budget, the x402 guard, the CDP store, the CLI, and the Agentic Wallet CLI wrapper and MCP proxy |
| `src/walletcap/` | the PyPI package `walletcap`, on the same file format |
| `solidity/` | `AccountCapSpender`, the on-chain cap for Coinbase Spend Permissions |
| `tests/` | the Python suite, including the tests that drive both languages against one budget file |

```console
$ cd js && npm install && node --test            # 58 tests
$ uv run --with pytest pytest -q                 # 54 tests, from the repository root
$ cd solidity/evm && npm install && node check.mjs ..   # the contract on an EVM, no Foundry needed
$ cd solidity && forge test                      # the contract's canonical tests, if you have Foundry
```

The JavaScript suite runs the x402 guard against x402's own client and fetch wrapper, and runs
restarts and racing replicas as separate processes, and drives the Agentic Wallet wrapper and
MCP proxy against stand-ins for Coinbase's wallet and MCP server. The Python suite covers the ledger, the API,
the CLI and one budget shared between both languages. `solidity/evm/check.mjs` compiles the
contract with solc-js and drives it on an in-process EVM, covering what the Foundry tests cover.

One test is **not** here: the integration test that drives Coinbase's CDP spend controls through
the shared store. It runs against a vendored build of Coinbase's SDK and lives in ShadowPath's
own repository. Porting it to the published `@coinbase/cdp-sdk` is open work.

## Prove it holds in your deployment

This package closes the gaps ShadowPath measured. Whether your configuration is closed is a
measurement: ShadowPath runs your agent with every control switched on and certifies, in
dollars, what can still get past your budget, signed and re-checkable offline.
[Get a certificate for your deployment](mailto:paul@coriolislabs.ca).

Apache-2.0. Copyright 2026 Coriolis Labs Inc.
