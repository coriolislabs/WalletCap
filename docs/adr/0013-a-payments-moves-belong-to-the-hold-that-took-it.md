# 0013. A payment's moves belong to the hold that took it

## Context

A payment's id is easy to learn: `holds()` lists it, and callers often choose it (an order id).
In 0.4's first draft, holding an id already in the ledger returned that payment, and the handle
it returned could settle, void, bound or note it like the one that took it. Two failures came
from that:

- Another process on the same file read an id from `holds()`, held it again, voided it, and
  spent the freed room on a payment of its own. The first process's `settle()` then took the
  payment from void to settled (ADR 0010), and the count went over the cap.
- A retry with an id the same process had voided got the voided payment back, and its
  `settle()` took it to settled: $20 against a $10 cap.

## Decision

- Every `held` entry carries a token, `wc_entry.holder`: 32 hex digits from a cryptographic
  random source, made by the client for that hold. Only the call that appended the entry gets
  it back, and the `Hold` it returns keeps it to itself. No API returns it.
- The payer's moves, the statements `settle`, `void`, `bound` and `note`, append only when
  `:holder` matches the held entry's token. Without it the client says why: "payment X was held
  by another process: only that process, or the budget's owner, can void it".
- Settling a payment that is already settled appends nothing. It succeeds for the hold that took
  the payment and for the owner; without the token it is refused, like any other move.
- The owner's moves are statements of their own, `owner_settle` and `owner_void`. They take
  evidence and no token: the owner reconciles any payment from what the chain shows.
- A voided id is spent. Holding it again is refused with `UsageError` ("payment X was voided;
  retry with a new id"). Holding any other id already in the ledger, for the same wallet and
  amount, returns that payment with `created` false and no token, and `pay()` refuses it before
  the payment runs.
- Schema 3 hasn't been released, so it changed in place. A file an earlier 0.4 build wrote isn't
  supported.

## Alternatives

- **Any handle moves the payment**, as in the first draft. It gave both failures above.
- **Refuse every hold of an id already in the ledger.** This closes both failures too, but a
  caller that retries after a crash could no longer learn from the hold that its payment exists
  and what state it is in. `created` false, with no token, keeps that answer and takes away the
  moves.
- **One token per process,** made when the budget opens. It closes the case of another process,
  but two handles in one process, or a second hold of the same id, could still move each other's
  payments, and the token would mean nothing after a restart either.
- **Keep a hash of the token in the file.** A process that can read the file can also write it,
  and open an owner's handle, so a hash protects nothing the token itself doesn't.
- **An OS boundary:** a service under its own user that checks each caller's credentials on a
  Unix socket (`walletcapd`). That is the boundary for an agent that means harm. It is planned,
  and it can keep this token for the holds it makes.

## Consequences

- A process that restarts can't move the payments it held before it stopped: their tokens were
  in the `Hold`s it lost. They count as held until the owner settles or voids each one with
  evidence (`walletcap settle <id>`, `walletcap void <id>`), as an unknown outcome does.
- The token is in the file, so anything that can write the file can read it. It keeps
  walletcap's callers from moving each other's payments; it doesn't stop a process that edits
  the file, which can also open an owner's handle.
- A retry after a void takes a new id. For x402 and Permit2 that is a new authorization with a
  new nonce anyway.
