<!-- SPDX-License-Identifier: Apache-2.0 -->
# 0016. The x402 guard counts what the wallet signs, under schemes it knows

## Context

The guard priced a payment from its terms: the `amount` of the accept the client selected. A
review of 0.4.1 found three ways the wallet signed for something else:

- x402 v1 names the amount `maxAmountRequired`, and a v1 client signs that field. Terms that
  carried both had the small `amount` counted and the large `maxAmountRequired` signed.
- Under `batch-settlement` the wallet signs a deposit into a payment channel: five times the
  request's amount, or the minimum the payee announces. The guard held the request's amount.
- `@x402/core` returns a payload that a scheme's failure hook "recovered" straight to the
  transport, past the hook where the guard holds. `@x402/svm`'s batch-settlement client signs a
  second accept that way.

Each is a payee choosing what the guard reads, apart from what the wallet does.

## Decision

1. **Terms are priced at the most they could ask for.** Both amount fields are read, each as a
   whole number in decimal digits, and the larger is the price. Anything else is refused: a
   guard and a signer must never read one string two ways.
2. **A signed payload is held at what it moves.** After signing, the guard reads the payload's
   own amount where it can (an EIP-3009 `value`, a Permit2 `permitted.amount`, a channel
   `deposit.amount`) and holds the larger of it and the price.
3. **A scheme is counted only if it is known.** `exact`, `upto` and `auth-capture` sign for at
   most the terms' amount, good for at most `maxTimeoutSeconds`. Any other scheme is refused
   unless the owner lists it in `schemes`, as an asset is refused unless listed in `assets`.
   `batch-settlement`, listed, is counted on EVM, where the deposit is read, and refused
   elsewhere.
4. **Every payload the client hands out was held.** The guard wraps the client's
   `createPaymentPayload`: a payload it hasn't seen is held on the terms it says it accepted,
   or is never returned. A hook that finds no record of the check prices the payment itself.

## Consequences

- A client with a custom scheme must list it (`guard(client, budget, { schemes: ['mine'] })`).
  0.4 counted any scheme at its terms' amount.
- An amount written `0x10`, `5e4` or with spaces is refused, with the code `terms`.
- A channel deposit counts in full when it is signed, and each later voucher counts its request
  again: the budget over-counts a channel, never under-counts it.
- The guard depends on `createPaymentPayload` being the one way a payload leaves an
  `@x402/core` client. A client with no such method has only its hooks.
