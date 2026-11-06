# AccountCapSpender

> **UNAUDITED. Testnet only.** This contract moves real tokens on behalf of an
> agent. It has not had an independent audit. Do not deploy it with funds you
> cannot lose, and do not point it at a mainnet SpendPermissionManager until an
> independent audit is complete.

`AccountCapSpender` is the spender for Coinbase Spend Permissions that enforces
**one rolling budget per account and token across every permission** that names
it. Spend Permissions themselves count each allowance per permission and per
fixed period, so a second permission, or two payments either side of a period
boundary, can exceed the owner's intended daily budget. This contract counts
every payment through it against one rolling window instead.

## How it fits

- The owner grants Spend Permissions to **this contract**, not to the agent.
- Only `agent` may call `pay`.
- `pay(permission, amount, payee)` draws `amount` through the permission,
  transfers it to an allowlisted `payee`, and records it in a per
  `(account, token)` ledger.
- `perPayment` and `cap` are checked before the manager is called; a payment
  over either is refused.
- The window is counted in `BUCKETS` (24) buckets of `window / 24` seconds, kept
  in a fixed ring of 25 storage slots per `(account, token)`. Every `pay` reads
  the same 25 slots, so its gas stays flat however many payments came before.
  An unbounded log made the first payment after 3,000 tiny ones cost about
  17.7M gas, past the 2^24 per-transaction cap, and locked the account.
- A payment counts as if made at the last second of its bucket: for one window
  from there. That is up to one bucket longer than an exact log, never shorter,
  so no window-long span of time ever holds more than `cap`.

## Tests

```sh
cd solidity
forge test                 # 11 tests, Foundry
```

The same behaviour is also checked without Foundry, on an in-process EVM:

```sh
cd solidity/evm
npm install
node check.mjs ..          # 12 checks
```

## Deploy (testnet only)

The constructor takes the SpendPermissionManager, the agent, the cap, the
rolling window in seconds (a multiple of 24), the per-payment max, and the
allowlisted payees:

```sh
forge create src/AccountCapSpender.sol:AccountCapSpender \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --private-key "$DEPLOYER_KEY" \
  --constructor-args \
    "$SPEND_PERMISSION_MANAGER" \
    "$AGENT" \
    "$CAP_IN_ATOMIC_UNITS" \
    "$WINDOW_SECONDS" \
    "$PER_PAYMENT_IN_ATOMIC_UNITS" \
    "[\"$PAYEE\"]"
```

Use the SpendPermissionManager address published by Coinbase for the chain you
are on; the `ISpendPermissionManager.SpendPermission` struct in
`src/AccountCapSpender.sol` must match that deployment field for field.

## Audit scope

The audit should cover:

- the per-account/token bucket ring: the bucket index and slot arithmetic, the
  counting rule `index + BUCKETS >= current`, and a very large `window`;
- the `manager.spend` call and the token transfer, including fee-on-transfer and
  non-standard ERC-20 return values;
- access control (`agent` only), allowlisted payees, and the lack of an owner
  pause or upgrade path;
- the revoke race: a revoke later in the same block is not visible to a payment
  ordered ahead of it.

There is no audit report, no verified mainnet address, and no deployment
script in this repository yet. Those are release blockers for on-chain use.
