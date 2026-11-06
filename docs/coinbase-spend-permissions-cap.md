---
title: One cap across Coinbase Spend Permissions
description: "AccountCapSpender holds every Coinbase Spend Permission an account grants it to one rolling cap. Crash test: $150 over with a second permission, $0 through it."
---

# One cap across Coinbase Spend Permissions

You let an agent pull USDC from a Coinbase Smart Wallet with Spend Permissions, and you want one
daily limit for the agent however many permissions it holds. Spend Permissions count each
allowance per permission and per fixed period, so a second permission, or two payments either
side of a period boundary, can pass the daily budget you meant. `AccountCapSpender` is a spender
contract that counts every payment through it, from every permission that names it, against one
rolling window.

> **Unaudited. Testnet only.** `AccountCapSpender` moves real tokens on behalf of an agent and has
> not had an independent audit. Read
> [solidity/README.md](https://github.com/coriolislabs/WalletCap/blob/main/solidity/README.md)
> before deploying it, and don't point it at a mainnet SpendPermissionManager until an audit is
> complete.

## Deploy it on a testnet

```console
$ cd solidity
$ forge create src/AccountCapSpender.sol:AccountCapSpender \
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

- The constructor takes the SpendPermissionManager, the agent, the cap, the rolling window in
  seconds (a multiple of 24), the per-payment max and the allowlisted payees. Use the
  SpendPermissionManager address Coinbase publishes for your chain.
- The account grants its Spend Permissions to the contract instead of the agent. The agent calls
  `pay(permission, amount, payee)`, and every permission the account grants the contract shares
  one rolling cap.
- Only the agent may call `pay`, only to an allowlisted payee, at most the per-payment max at a
  time.
- The window is counted in 24 buckets, so every payment costs the same gas however many came
  before it. A payment counts for up to one bucket (window/24) past its window, never less.

The contract's checks also run without Foundry, on an in-process EVM:

```console
$ cd solidity/evm && npm install && node check.mjs ..
```

## Crash test: $150 over with a second permission, $0 through AccountCapSpender

`npx walletcap-crash-test` runs Coinbase's SpendPermissionManager v1.0.0 and Smart Wallet on an
in-process EVM, from the runtime code deployed on Base mainnet. A Smart Wallet holds $1,000 of a
test token that stands in for USDC, and grants the agent permissions of $150 a day. On
walletcap's side, the wallet grants the same permissions to `AccountCapSpender`.

| Event | SpendPermissionManager | AccountCapSpender |
|---|---|---|
| a second permission | $300 pulled · $150 over | $150 pulled · $0 over |
| across a period boundary, 1 second apart | $300 pulled · $150 over | $150 pulled · $0 over |

The result was the same in all eight runs on 6 November 2026. Within one permission and one
period the manager holds: the crash test's suite checks that a fourth $50 is refused with
`ExceededSpendPermission`. `AccountCapSpender` refuses the second $150 with `OverBudget`.

## Links

- [README: Coinbase Spend Permissions, on chain](https://github.com/coriolislabs/WalletCap#coinbase-spend-permissions-on-chain)
- [The contract](https://github.com/coriolislabs/WalletCap/blob/main/solidity/src/AccountCapSpender.sol),
  its [Foundry tests](https://github.com/coriolislabs/WalletCap/blob/main/solidity/test/AccountCapSpender.t.sol)
  and the [audit scope](https://github.com/coriolislabs/WalletCap/blob/main/solidity/README.md#audit-scope)
- [The crash test](https://github.com/coriolislabs/WalletCap/tree/main/crash-test), which says
  exactly what runs, and [all pages](index.md)
- Off chain, the same budget idea for x402 payments: [any x402 client](x402-spending-limit.md) and
  [Coinbase CDP x402 spend controls](coinbase-cdp-spend-controls.md)
