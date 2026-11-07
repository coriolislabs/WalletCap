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

The hour and a minute also started at the wrong moment. A wallet asked to pay an x402 request
signs, if at all, before it answers, and it can take a while: an Agentic Wallet request that
failed 30 minutes after its hold was released 31 minutes after the failure, while an
authorization signed just before it could still be redeemed for 29 more minutes.

The review suggested bounding such a hold when the request fails: a settle-by time of the
longest terms' timeout from the failure. walletcap doesn't, because a wallet that didn't answer
(an IPC time-out, say) may still sign after walletcap stops waiting. A bound would end the hold's
count by itself, one window after that time, with no one checking the chain. Kept open, the hold
counts until its owner voids it.

## Decision

- `void_unknown` in spec/schema.sql joins each payment's `held` entry, and releases a payment
  with no settle-by time only when its rail is `x402` or `awal-x402`, the rails on which
  walletcap has an x402 authorization signed, and only an hour and a minute after its latest
  entry. A payment the bulk release can void has an outcome noted, so that entry is the note of
  its failure: the last moment walletcap knows the wallet was still working on it.
- A failed x402 request's hold stays open (no settle-by time): it counts until its owner voids
  it, by id or with the bulk release.
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
- The bulk release is still the owner's word that a payment never left. A wallet that timed out
  and signed later than the failure noted can have a live authorization when the bulk release
  voids its hold; the owner who runs it has checked the chain, as the command's help says.
