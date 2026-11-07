# 0014. The 61-minute bulk release is for x402 holds only

## Context

The owner's bulk release (`walletcap void --all-unknown`, `voidUnknown`) voids held payments of
unknown or refused outcome that can no longer settle. A payment with a settle-by time goes once
that time has passed. In 0.3.0 and in 0.4's first draft, a payment with none went once it was an
hour and a minute old, because an x402 authorization that walletcap lets be signed is valid for
an hour at most.

That bound belongs to x402. A transfer has none: an Agentic Wallet `send`, or a payment made
inside `pay()` whose receipt wait timed out, is a transaction that can still be mined after it
was sent, however long ago, for example one that waited in the mempool. Voiding it after 61
minutes freed its room while the money could still leave.

## Decision

- `void_unknown` in spec/schema.sql joins each payment's `held` entry, and releases a payment
  with no settle-by time only when its rail is `x402` or `awal-x402`, the rails on which
  walletcap has an x402 authorization signed, and only once it is an hour and a minute old.
- Any other payment with no settle-by time is voided by id, with evidence that it never moved:
  `walletcap void <id> --evidence <what shows it>`, or the owner's `void(id, { evidence })`.
  `walletcap settle` takes `--evidence` too.
- The command line's help, and its answer when nothing can be voided, say which payments the
  bulk release leaves and how to void them.

## Consequences

- A transfer whose outcome is unknown counts until its owner settles or voids it by id, however
  old it is: the owner reads the chain for each one.
- The rail is the caller's word. Code that holds a payment with the rail `x402` gets the x402
  rule for it.
- A payment with a settle-by time is released once that time has passed, on any rail, as
  before.
