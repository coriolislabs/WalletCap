# 0002. An append-only ledger, with each payment's current state derived from it

## Context

The design asks for append-only rows: every state a payment enters is a new row, never changed
or deleted. Counting needs each payment's latest state. Computing it from the rows alone means
admission reads every row a payment ever had: a payment held with no settle-by time counts for
good while held, so its `held` row stays in any range a counting index would read, even after it
settles. Admission would scan history.

## Decision

`wc_entry` is the ledger: rows are appended, and triggers refuse `UPDATE` and `DELETE`.
`wc_current` holds each payment's latest state and its `counts_from`, written only by the
projection triggers on `wc_entry`, in the same transaction. Guard triggers refuse any other
insert, update or delete of `wc_current`. Admission reads the index
`wc_current (wallet, counts_from, amount)` from `now - window` up, which holds only payments that
can still count, and covers the amount.

This departs from a literal reading of "rows are append-only": `wc_current` rows change. They
are derived data, like an account balance next to its transfers, and replaying `wc_entry` into
an empty file rebuilds them; a test does exactly that.

## Consequences

- Admission's cost depends on the payments that count now, not on the history.
- The counting rule lives in one place, the projection triggers.
- A writer that drops the triggers can make `wc_current` disagree with `wc_entry`; the threat
  model treats that writer as outside what the library can stop.
