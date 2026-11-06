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
- The ledger is append-only and expires entries by timestamp. The array keeps
  its historical slots, so a long-lived contract grows; budget for it.

## Tests

```sh
cd solidity
forge test                 # 9 tests, Foundry
```

The same behaviour is also checked without Foundry, on an in-process EVM:

```sh
cd solidity/evm
npm install
node check.mjs ..          # 10 checks
```

## Deploy (testnet only)

The constructor takes the SpendPermissionManager, the agent, the cap, the
rolling window in seconds, the per-payment max, and the allowlisted payees:

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

- the per-account/token ledger and its expiry arithmetic, including a very large
  `window`;
- the `manager.spend` call and the token transfer, including fee-on-transfer and
  non-standard ERC-20 return values;
- access control (`agent` only), allowlisted payees, and the lack of an owner
  pause or upgrade path;
- the revoke race: a revoke later in the same block is not visible to a payment
  ordered ahead of it;
- the append-only array's long-run gas behaviour.

There is no audit report, no verified mainnet address, and no deployment
script in this repository yet. Those are release blockers for on-chain use.
