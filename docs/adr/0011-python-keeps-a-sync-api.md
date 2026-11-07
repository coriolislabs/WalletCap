# 0011. Python keeps its sync API, with async forms

## Context

The JavaScript API is async, because a lock wait inside a synchronous call freezes the event
loop. Python agents are written both ways, and Python's `sqlite3` is synchronous.

## Decision

Python keeps the synchronous API and adds async forms: `acheck`, `ahold`, `astatus`, `aholds`,
`ahistory`, a hold's `asettle`, `avoid` and `anote`, and `async with budget.pay()`. Each runs the
synchronous call in a worker thread through `asyncio.to_thread`. Each operation opens its own
connection, so threads share none.

## Consequences

- Synchronous code waits for a lock as it always did; async code doesn't block its loop.
- The names differ from JavaScript's only by the `a` prefix.
- A thread can't be stopped. If the caller is cancelled while `ahold()` or `async with
  budget.pay()` waits, the hold the thread takes is voided, with the evidence "cancelled before
  paying", and the cancellation goes on once that is done.
