# 0004. A settle-by time not after now: refused by the API, clamped by the rule

## Context

0.2 stored a settle-by time already past as given, so the hold never counted and a second full
cap was admitted. 0.3 refused such a time. The SQL rule must also hold for a writer that doesn't
use the API.

## Decision

Both. The `hold` and `bound` statements refuse a settle-by time that isn't after the ledger's
now, and the clients report it as a `UsageError`: a payment can't settle before it is made. The
counting rule clamps anyway: a held payment counts through `max(until, held_at) + window`, and the
`wc_entry_admitted` trigger refuses a held entry whose `until` isn't after its own time.

## Consequences

- A caller's mistake is reported, not silently stored.
- Even a row written outside the API counts at least one window from when it was held.
