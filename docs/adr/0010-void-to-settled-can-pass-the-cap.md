# 0010. VOID to SETTLED can put the count over the cap

## Context

An owner voids a payment on evidence that it never moved money, and its amount frees room that
another payment then takes. Later evidence can show the voided payment paid after all.

## Decision

`VOID` to `SETTLED` is allowed, and the payment counts again from its settlement, even when that
puts the window's count over the cap. Admission then refuses every payment until the count falls
back under it.

## Consequences

- The ledger records money that moved, whatever the cap says: refusing the settlement would make
  the count smaller than what was spent.
- `counted(τ) ≤ cap` holds at every admission, but not after a contradicted void or an owner
  lowering the cap; [spec/ledger.md](../../spec/ledger.md) states the invariant with that
  assumption.
