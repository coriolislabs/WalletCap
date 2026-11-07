# 0005. The CDP store holds payments; it doesn't settle them

## Context

Coinbase CDP's spend controls call their store's `append()` when they create a payment, before
it is signed, and `removeEntry()` when settlement fails, for reasons the store can't tell apart.
0.3 recorded each append as settled, counting an hour and a minute plus one window.

## Decision

The store holds each payment, from the ledger's own time, until an hour and a minute after CDP
records it (the longest an authorization CDP signs can be redeemed, and a minute), through the
ledger's ordinary admission. A `removeEntry()` notes the payment refused; it keeps counting for
the same time. Nothing in CDP's calls is evidence that a payment settled, so none settles it.

## Consequences

- The store counts a payment for exactly as long as 0.3 did, and the crash test's cdpStore rows
  are unchanged.
- `status()` shows CDP payments as in flight, not spent.
- The store needs no CDP-only ledger methods; 0.3's `record`, `reopenByReference` and `prune` are
  gone.
