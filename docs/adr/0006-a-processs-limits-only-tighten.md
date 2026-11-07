# 0006. A paying process's limits only tighten, for that process

## Context

In 0.3, limits passed to `openBudget()` that were tighter than the stored ones were written to
the file, lowering them for every process. That let any payer change the owner's limits, and made
one process's defaults everyone's.

## Decision

The stored limits change only through the owner's handle (`setLimits`, `walletcap set`). Limits
a payer passes are that process's own: every hold and check runs with them, as the `:p_*`
parameters of the `hold` and `refusal` statements, and they can only refuse more. A process limit
looser than the stored one of the same kind and window does nothing, and the payer gets a
warning naming the command that raises the stored one. With `create`, a missing budget is created
with them.

## Consequences

- A process can hold itself to $5 an hour inside a $150-a-day budget without changing anyone
  else's.
- The admission trigger checks only the stored limits; process limits are checked by the
  conditional insert alone, since only that process knows them.
