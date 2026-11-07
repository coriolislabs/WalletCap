# 0003. The ledger reads its own clock, in SQL

## Context

walletcap 0.2 took a clock from each process and a payment's time from its caller: a process
whose clock ran a day ahead saw an empty window, and a backdated entry had aged out when it was
written. 0.3 read the system clock in each client. Tests still need to move time.

## Decision

Every time in a row is the ledger's own: `wc_clock`, `julianday('now')` in milliseconds, read
inside the statement that writes the row. SQLite keeps `'now'` fixed for a whole statement. The
`wc_entry_dated` trigger refuses an entry dated any other way. No API takes the present time from
a caller; a client passes only durations from now (`settlesWithinMs`) or the expiry a signed
payload carries.

Tests replace `julianday('now')` on their own connections with an application-defined function,
through a private module (`_clock`). It is read once per transaction, so a moving test clock
can't give one statement two times. Production connections never get it.

## Consequences

- Processes on one host share one system clock, so they agree on what counts.
- A host whose clock is wrong, or jumps backwards, counts by that clock: a residual risk in the
  threat model.
