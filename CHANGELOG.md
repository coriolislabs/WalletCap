<!-- SPDX-License-Identifier: Apache-2.0 -->
# Changelog

## 0.4.0 (unreleased)

This release gives the spend rule one owner: SQL in `spec/schema.sql`, which the JavaScript and
Python packages ship and run as written, so neither language implements admission or counting.
It changes the API in both languages, the budget file's format and the repository's layout, so
it is a breaking release. [STABILITY.md](STABILITY.md) says what is public API from now on.

### Breaking

The ledger and the budget file:

- The budget file is schema 3. 0.4 upgrades a file that 0.2 (schema 1) or 0.3 (schema 2) wrote
  the first time it opens it, in one transaction: every payment that counted keeps counting at
  least as long, and a crash during the upgrade leaves the file as it was. 0.2 and 0.3 refuse a
  schema 3 file, so stop every 0.2 and 0.3 process before upgrading. One that opens the file
  anyway adds its own tables, `budgets` and `spend`, empty, before it refuses it; 0.4 drops them
  the next time it opens the file.
- Payments are entries appended to a ledger and never deleted. A payment that never left is
  void, and stays in the history with the status `void`; 0.3 deleted it.
- A payment's id is its rail's own identity where walletcap reads one (`eip3009:<from>:<nonce>`,
  `permit2:<owner>:<nonce>`), a key the caller passes as `id`, or one the ledger makes: `wc-`
  and 32 hex digits. 0.3's ids were `spend-…` and `cdp-…`. Holding an id that is already in the
  ledger returns that payment, with `created` false. Holding a voided id is refused with
  `UsageError`: retry with a new id.
- Only the hold that took a payment can settle, void, bound or note it: the ledger gives each
  hold a token that its moves need. A second hold of the same id, or another process, gets
  `UsageError`. The owner's `void(id, evidence)` and `settle(id, evidence)` move any payment, and
  settling a payment that is already settled succeeds for anyone.
- The file is created `0600` in a `0700` folder, and opened in WAL mode with
  `synchronous = FULL`. SQLite older than 3.37.0 is refused (`MIN_SQLITE_VERSION`).
- The window of a budget can change only while no payment counts; 0.3 refused any change once
  the budget had held a payment.

JavaScript:

- The package is written in TypeScript, and its `.d.ts` files come from `tsc`. The hand-written
  `index.d.ts` is gone. The `.d.ts` files compile on their own: with `skipLibCheck` off,
  `lib: ["es2022"]`, no `@types/node`, and `nodenext` or `bundler` resolution.
- `X402HookedClient` gives each hook its context type, `PaymentCreationContext`,
  `PaymentCreatedContext`, `PaymentCreationFailureContext` or `PaymentResponseContext`, where 0.3
  typed them `any`, and no longer lists `registerPolicy`: `guard()` still registers its policy on
  a client that has one. @x402/core's `x402Client` fits it, and `guard()` returns the type it was
  given.
- The API is async. `openBudget()` returns a Promise, and so does every method of the payer and
  owner handles and of a hold. A wait for another process's write lock happens on the event
  loop, for up to `busyTimeoutMs` (30,000 by default).
- `budget.reserve()` is `budget.hold()`, and returns a `Hold`; `Reservation` is gone. A hold's
  `commit({ tx })` is `settle({ tx })`, `release()` is `void({ evidence })`, and `annotate()` is
  `note(outcome, detail)`. `hold()` and `pay()` take `id` and `settlesWithin` (milliseconds).
  `Hold` has no public constructor: `budget.hold()` makes one.
- `status()` names the window `windowMs`, as `BudgetLimits` does.
- `check()` always has `code`, `source`, `message` and `brief`, `null` when the payment would be
  paid; `source` is new. A `Payment`'s `to`, `note` and `tx`, and a `HeldPayment`'s `to`, `note`
  and `error`, are always there too, `null` when unknown. The x402 guard keeps a refusal's
  `source` when it tells the agent.
- `voidUnknown()` returns `VoidedPayment`s.
- The vendor adapters are subpath exports, and the core imports none of them:
  `budget.guard(client)` is `guard(client, budget)` from `walletcap/x402`;
  `budget.cdpStore({ asset })` is `cdpStore(budget, { asset })` from `walletcap/cdp`;
  `budget.guardAgentKit(provider)` is `guardAgentKit(provider, budget)` from
  `walletcap/agentkit`. `MAX_PAYMENT_TIMEOUT_SECONDS` and `USD_ASSETS` moved to `walletcap/x402`.
  `walletcap/agentic` keeps `guardAgenticWallet(budget, { request })`.
- `SharedBudgetStore` is gone, with its `declare()`, `revoke()` and `status()`; use `cdpStore()`.
  What it returns is a `SpendStore` that cdp-sdk 1.60.0's `applySpendControls` takes, and its
  `load()` gives `atomicAmount` as a bigint, as 0.3's did.
- `budget.setLimits()`, `budget.freeze()` and `budget.unfreeze()` moved to the owner's handle,
  `openOwner()`.
- `budget.holds()` returns `HeldPayment`s: `until` is now `countsUntil`, and `settlesBy` is new.
- `walletcap awal-mcp` is now its own npm package: `npx walletcap-mcp --wallet …`.
  `packages/mcp/server.json` lists it under the MCP Registry name `io.github.coriolislabs/walletcap`.

Python:

- `Budget.reserve()` is `Budget.hold()`, and returns a `Hold`; `Reservation` is gone. A hold has
  `settle(tx=…)`, `void(evidence=…)`, `settles_by(datetime)`, `settles_within(timedelta)` and
  `note(outcome, detail)`. `with budget.pay(...) as payment` yields the hold; `payment.tx` is
  kept as the evidence.
- `open_budget()`, `Budget()` and `open_owner()` take `busy_timeout_ms` (an int of
  milliseconds, as JavaScript's `busyTimeoutMs`) in place of `busy_timeout_seconds`, and
  `open_budget()` lists its keyword arguments: a misspelt one is a `TypeError`.
- `Check` has `source`. `RefusalCode`, `RefusalSource`, `PaymentState`, `Outcome`, `Dollars` and
  `Window` are exported types.
- 0.3's `Hold`, what `budget.holds()` returns, is now `HeldPayment`: `until` is now
  `counts_until`, and `settles_by` is new.
- `Budget.set_limits()`, `freeze()` and `unfreeze()` moved to the owner's handle,
  `open_owner()`.
- `Ledger` is private (`walletcap._ledger`). `UNSET`, `BudgetStatus` and `Spend` are gone, and
  `BudgetLimits` is now the owner's view of a budget.
- `OverBudget`, `OverPerPayment`, `OverUses` and `BudgetRevoked` are gone: `BudgetRefused.code`
  says which limit refused.
- Amounts the API returns are `Micros`, a micro-dollar amount of its own type. `to_micros` reads a
  `Micros` as micro-dollars and a plain `int` as whole dollars, as before. Arithmetic on a
  `Micros` returns a `Micros` or raises `TypeError` (ADR 0015): `cap // 2` is half the cap,
  while `cap + 1`, `1.5 * cap`, `cap / 2` and `float(cap)` are refused, because a bare number
  would be read as dollars. `int(amount)` gives the micro-dollars as a plain int.

Both languages:

- Four errors, with no common base: `BudgetUnavailable` (the file or its lock),
  `BudgetRefused`, `PaymentNotRecorded` and `UsageError` (a malformed call, or one that doesn't
  fit the payment's state). `BudgetError` is gone, and Python's errors no longer subclass
  `ValueError`.
- `BudgetRefused.reason` is now `code`, and the `budget_…` code strings are gone. `frozen` and
  `max_payments` replace `revoked` and `uses`. `terms`, for payment terms walletcap can't read, is
  new. `source` says whether the budget's limits refused (`budget`) or the paying process's own
  (`process`). `Check` has `code` and `brief` in place of `reason`.
- `PaymentNotRecorded.reservationId` (Python `reservation_id`) is now `paymentId`
  (`payment_id`).
- The limits a payer passes to `openBudget()` or `open_budget()` bind that process only, and only
  tighten the stored ones. 0.3 wrote a tighter limit into the file, for every process. Only the
  owner's handle, and `walletcap set`, change the stored limits.
- `pay()` with an `id` already in the ledger refuses with `UsageError` before the payment runs.

The command line, in both languages:

- `--json` prints the same fields from both command lines: snake_case keys, every amount,
  count and duration as a string of decimal digits, every time as an ISO 8601 UTC string to the
  millisecond, and `null` for a field with no value. The npm CLI printed camelCase keys
  (`inFlight`, `perPayment`); the Python one printed times with its own offset format.
- `walletcap release <id>` is `walletcap void <id>`, and `release --all-unknown --older-than …`
  is `void --all-unknown --older-than …`. Its messages say "Voided".
- `void --all-unknown` releases a payment with no settle-by time only if it was held for x402
  (the rails `x402` and `awal-x402`), once it is an hour and a minute old. 0.3.0 released any
  such payment then, a transfer included, though a transfer can still be mined later. The owner
  voids those by id: `walletcap void <id> --evidence <what shows it>`. The same rule holds for
  the owner's `voidUnknown()` (`void_unknown()`).
- A payment id that isn't in the file exits 2.

Behaviour:

- The CDP store holds each payment until an hour and a minute after CDP records it, and it counts
  for one window after that: the same time as in 0.3. It shows as in flight, where 0.3 showed it
  as spent, because CDP's record isn't evidence that the payment settled.
- The Agentic Wallet wrapper no longer reads the wallet's error text to decide that nothing was
  signed. Any failure the wallet reports keeps the payment held, noted unknown, until its owner
  voids it. A free endpoint's one-unit hold is still given back.
- A refusal's message, `walletcap holds` and `walletcap history` mark a payment the CDP store
  holds: CDP signed its authorization, which a payee can redeem until an hour and a minute after
  CDP recorded it, so its owner voids it only if the chain shows it was never redeemed.
- An open hold can learn its settle-by time as a time from the ledger's now: `settlesWithin(ms)`
  and the `settlesWithin` option; in Python `settles_within(timedelta)`. The x402 guard and the Agentic Wallet
  wrapper use it, so neither reads the process's clock to date a payment.

### Added

- `spec/`: [ledger.md](spec/ledger.md), the state machine and its invariant; `schema.sql`, the
  rule; `upgrade.sql`; `vectors/ledger.json`, admission sequences both test suites run; and
  `fixtures/`, budget files 0.2.4 and 0.3.0 wrote, with what 0.3.0 counted in them.
- The owner's handle in both languages, `openOwner()` and `open_owner()`: `budgets`, `status`,
  `history`, `holds`, `payment(id)`, `setLimits`, `freeze`, `unfreeze`, `void(id, evidence)`,
  `settle(id, evidence)` and `voidUnknown` (`void_unknown`), the bulk release.
- `walletcap settle <id> [--tx <hash>] [--evidence <text>]`, and `--evidence` for
  `walletcap void <id>`: what shows that the payment paid, or never moved.
- Python's async forms: `acheck`, `ahold`, `astatus`, `aholds` and `ahistory`, and a hold's
  `asettle`, `avoid`, `asettles_by`, `asettles_within` and `anote`. `async with budget.pay()` now waits for a lock in a worker
  thread; 0.3 waited on the event loop. If the caller is cancelled while `ahold()` or `async with
  budget.pay()` waits, the hold the thread takes is voided, with the evidence "cancelled before
  paying", before the cancellation goes on.
- `walletcap-mcp`, the npm package for the MCP proxy.
- Types for `walletcap/agentic`, which 0.3 shipped without. `guardAgenticWallet(budget, { request })`
  needs `request`, as it did at run time, and `fetch`, there and in `discoverRequirements()`, is a
  `FetchLike`: the part of `fetch` they call.
- [STABILITY.md](STABILITY.md), and design records in [docs/adr/](docs/adr/).

### Changed

- The repository is laid out by what ships: `packages/js` (npm `walletcap`), `packages/python`
  (PyPI `walletcap`), `packages/mcp` (npm `walletcap-mcp`), `contracts/` (was `solidity/`),
  `bench/crash-test/` (was `crash-test/`) and `spec/`. One npm workspace, with one lockfile.
- The PyPI source distribution ships only the Python package and the SQL it runs.
- `walletcap-crash-test` 0.4.0 runs on walletcap `^0.4.0`. Its `--json` refusal codes are
  `budget`, not `budget_budget`.
- A brand-new npm package can't use trusted publishing for its first release, so
  `walletcap-mcp` 0.4.0 is published by hand; later releases publish from `publish.yml`, on tags
  `mcp-v<version>`.

### Kept from 0.3.0

Every fix in 0.3.0 still holds. The tests that show it, in `packages/js/test`, `packages/mcp/test`
and `packages/python/tests`:

- **An error never settles a payment.** JavaScript: "an error never settles a payment: an unknown
  outcome counts until its owner releases it", "an unknown outcome with a settle-by time counts
  until one window past it", and in the Agentic Wallet tests "a send whose outcome is unknown
  keeps counting until its owner releases it". Python: `test_an_error_never_settles_a_payment`,
  `test_an_unknown_outcome_with_a_settle_by_time_counts_one_window_past_it`. Vector: "an open
  hold counts until evidence settles or voids it, however long".
- **A commit never shortens a hold.** JavaScript: "a settlement never shortens a hold: it counts
  until one window past the hold's settle-by time", "a payee's word that a payment settled can't
  free the budget while the authorization is redeemable" and "the payee's word that a payment on
  handed-in terms settled doesn't end its hold early". Python:
  `test_a_settlement_never_shortens_a_hold`. Vector: "a settlement never shortens a hold".
- **x402 terms over 3600 s are filtered** (`MAX_PAYMENT_TIMEOUT_SECONDS`). JavaScript: "terms
  valid longer than an hour are passed over for shorter ones on offer", "an authorization valid
  longer than an hour is refused before it is signed", and "the wallet is handed only the terms
  walletcap can price and bound; the rest are left out, not refused".
- **Discovered terms are handed to the Agentic Wallet.** JavaScript: "the wallet is handed the
  terms walletcap discovered, so the payee's word can't end the hold early", and "npx walletcap
  awal: payments are counted, everything else is awal".
- **Permit2 deadlines are read.** JavaScript: "a Permit2 payment, or one whose expiry walletcap
  can't read, counts until it can no longer settle".
- **CDP rows count for an hour and a minute.** JavaScript: "a CDP payment counts until an hour
  after it is recorded, plus one window: its authorization can be redeemed that long", and "an
  entry CDP backdates still counts from the ledger's own time".
- **Names are canonical.** JavaScript: "checksummed, lowercase and CAIP-10 addresses spend from
  one budget", and "a checksummed or CAIP-10 wallet spends from the one lowercase budget". Python:
  `test_a_checksummed_address_names_the_one_lowercase_budget`.
- **`PaymentNotRecorded`.** JavaScript: "a payment that went through but cannot be recorded
  throws PaymentNotRecorded, which is none of the other errors", "a settlement the guard cannot
  record throws PaymentNotRecorded, and the payment keeps counting", "a refusal or a lost answer
  the guard can't record throws PaymentNotRecorded too", and "a budget that can't be written after
  the wallet answered raises PaymentNotRecorded, not one of the errors code retries on". Python:
  `test_a_payment_that_went_through_but_was_not_recorded`,
  `test_the_four_errors_share_no_base_and_none_is_a_value_error`.
- **`BudgetRefused.brief` is what agents see.** JavaScript: "the agent is told why the guard
  refused, not which holds its owner could release", "a refusal CDP passes on to the agent names
  no holds and no release instructions", and "the agent is told why a payment was refused, not
  which holds its owner could release". walletcap-mcp: "the agent is told why a payment was
  refused, not which holds its owner could void".
- **The bulk release follows the settle-by and 61-minute rules,** the second now for x402
  holds only (above). JavaScript: "a bulk release keeps a payment its payee could still settle,
  and clears refused ones", and "a bulk release keeps a hold with no settle-by time for an hour
  and a minute, and a CDP roll-back until it can no longer settle". Python:
  `test_a_bulk_release_keeps_what_the_payee_could_still_settle`,
  `test_a_bulk_release_keeps_a_hold_without_a_settle_by_time_for_61_minutes`. Vector: "the
  owner's bulk release voids only what can no longer settle".
- **The schema-2 upgrade.** JavaScript: "a 0.2.x file is upgraded on open: every spelling of a
  wallet becomes one budget, and every payment still counts", "the upgrade says what it did: a
  warning names the merged limits, and a wallet in two units is frozen, not the file", and in
  `upgrade.test.mjs` "every payment in a schema 1 file counts as 0.3.0 counted it" (and schema 2)
  and "a crash in the middle of the upgrade leaves the file as it was". Python:
  `test_a_0_2_file_is_upgraded_on_open`, `test_the_upgrade_says_what_it_did`,
  `test_every_payment_counts_as_0_3_0_counted_it`,
  `test_a_crash_mid_upgrade_leaves_the_file_as_it_was` and
  `test_javascript_and_python_open_one_old_file_at_once`.
- **The rest of 0.3.0:** the clock is not an option ("the clock is not an option: no process can
  move its own time to empty the budget", `test_the_clock_is_not_an_option`); a settle-by time
  that isn't after now is refused ("a settle-by time that isn't after now is refused: a payment
  can't settle before it is made", `test_a_settle_by_time_that_isnt_after_now_is_refused`); no
  hold lapses while its payment can still settle (`test_a_hold_never_lapses_while_its_payment_can_still_settle`);
  a naive datetime is refused (`test_a_naive_settle_by_time_is_refused`); amounts stop at
  `MAX_AMOUNT` and never overflow ("amounts and limits stop at a billion dollars, so no sum of
  payments can overflow"); the time is read once the write lock is held ("the ledger reads the
  time once it holds the write lock, so waiting for another process can't make it stale",
  `test_the_time_is_read_once_the_write_lock_is_held`); and amounts read only ASCII digits, the
  same way in both languages (`spec/vectors/money.json`).

## 0.3.0 — 2026-11-06

This release fixes ways past walletcap's own cap that reviewers reproduced, and ways its
JavaScript and Python packages read the same input differently. It removes public options,
changes what an error does to a payment and upgrades the budget file, so it is a minor release,
not a patch.

### Breaking

- An error never settles a payment. When the payment function throws an error not tagged
  `notSent()` (Python: `NotSent`), the payment stays in flight, marked unknown, instead of being
  committed. It counts until one window past its `settlesBy`, or, without one, until its owner
  releases it. `status()` shows it as in flight, not spent. The Agentic Wallet wrapper does the
  same for a send or paid x402 payment whose outcome is unknown.
- A commit never shortens a hold. A payment committed from a reservation with a settle-by time
  counts until one window past the later of the commit and that time, so a payee's own word that
  a payment settled can't free the budget while its authorization can still be redeemed.
- The budget file is schema 2. 0.3 upgrades a 0.2.x file when it first opens it: a budget kept
  under another spelling of a wallet (checksummed, uppercase, CAIP-10) moves to the lowercase
  name, merged with any budget there with the tighter of every limit and every payment.
  `declare()` with other limits than a merged budget's says what the upgrade merged. A budget in
  another unit than the wallet's can't be merged: it stays under its 0.2.x name, and the wallet
  is frozen, with the reason in its refusals, until its owner unfreezes it; the rest of the file
  upgrades as usual. 0.2.x refuses a schema 2 file, so stop 0.2.x processes before upgrading.
- The `clock` option is gone from `openBudget`, `cdpStore` and `SharedBudgetStore`, and from
  Python's `open_budget`, `Budget` and `Ledger`. The ledger reads the system clock. Passing a
  clock is an error.
- Python's `Ledger` no longer takes `reservation_ttl_seconds`.
- A `settlesBy` that isn't after now is refused with a `BudgetError`.
- Python refuses a naive datetime for `settles_by`.
- A payment that went through, or may have, but couldn't be recorded raises
  `PaymentNotRecorded`, not `BudgetError`. It is not a subclass of `BudgetError`, and it carries
  the reservation id (`reservationId`, `reservation_id`) and the cause.
- `MAX_AMOUNT` is 10^15 micro-dollars ($1,000,000,000), not 2^63 − 1. A larger amount, cap or
  per-payment limit is refused.
- The x402 guard pays only on terms whose `maxTimeoutSeconds` is a whole number of seconds up to
  3600 (`MAX_PAYMENT_TIMEOUT_SECONDS`), as Coinbase's CDP spend controls do. It passes over
  longer terms for shorter ones on offer, and refuses before signing, with the reason
  `'timeout'`, when none are.
- The Agentic Wallet wrapper hands the wallet only the terms it can price that are valid an hour
  or less, and refuses a paid x402 request, before the wallet is asked, when none are left
  (reason `'asset'` or `'timeout'`).
- `guard(client, { assets })` and the Agentic Wallet wrapper's `assets` refuse an entry that
  changes a built-in asset's decimals, and decimals that aren't an integer from 0 to 18.
- Amounts and windows take only the digits 0-9, and only ASCII whitespace is trimmed, in both
  languages. `walletcap awal send` refuses an amount with trailing text, an exponent or a
  separator. The wrapper refuses a send whose `amountAtomic` isn't plain digits or that has no
  recipient, and passes the wallet only `recipient`, `amountAtomic`, `asset` and `chain`.
- Every ledger method names a budget the way `openBudget` does: an EVM address, bare or CAIP-10,
  is lowercased after its EIP-55 check.

### Fixed

- A payment whose function threw was committed, so it counted for one window from the error. A
  transfer whose receipt wait timed out and that was mined a day later let $300 through a $150
  window.
- A payee could answer "settled" with a made-up hash, keep the authorization and redeem it later:
  the commit had ended the count after one window. With a 30-day validity, five $0.15
  authorizations passed a $0.15-a-day cap; with Permit2, $0.75 passed a $0.15-per-10-minutes cap
  in 50 minutes. A payment now counts until one window past its authorization's expiry. The
  guard reads it from the signed payload (EIP-3009 `validBefore`, Permit2 `deadline`), or takes
  the signing time plus `maxTimeoutSeconds`. The Agentic Wallet wrapper takes the longest
  `maxTimeoutSeconds` among the terms it hands the wallet, whatever their scheme.
- The CDP store counted a payment for one window from when CDP recorded it, though CDP signs it
  after and lets the authorization be redeemed for up to an hour. It now counts until an hour
  and a minute after the record, plus one window.
- A `settlesBy` already past was stored as given, so the reservation never counted and a second
  full cap was reserved.
- The CDP store recorded a payment at the time in CDP's entry, so a backdated entry had already
  aged out. It records at the ledger's own time.
- A process that waited for another's write lock dated its payment as much as the wait earlier,
  so the payment stopped counting that much early. Both ledgers read the time once the lock is
  held.
- A process whose clock ran a day ahead saw an empty budget and paid a second full cap.
- Python's `reservation_ttl_seconds` let a hold lapse while its payment could still settle: $300
  on a $150 cap.
- `SharedBudgetStore` and Python's `Ledger` took a checksummed address as given, which opened a
  second budget beside the lowercase one, with its own cap.
- Two near-maximum payments overflowed SQLite's `SUM`, and every later payment from the wallet
  failed.
- Python read a naive `settles_by` as local time: 9 hours early in Tokyo.
- Code that retried on `BudgetError` could pay twice after "the payment went through but could
  not be recorded".
- An asset override could price USDC at 18 decimals, counting $1 as a millionth of a cent.
- `walletcap awal send` read amounts with `parseFloat`: `100.5abc` was $100.50, and `0.29` was
  289,999 atomic units.
- Python read Arabic-Indic and other Unicode digits as numbers (`١٢` was $12), and trimmed
  `\x85` and other non-ASCII spaces, which JavaScript doesn't.
- A float of dollars converted differently in the two languages on about 0.5% of halfway values.
  Both now read the shortest decimal that gives the float back and round it half up.
- Python rounded a `Decimal` amount at 28 digits before checking it was a whole number of
  micro-dollars, and raised `ValueError`, not `BudgetError`, for an input over 4,300 digits.

### Changed

- `budget.holds()` (Python: `budget.holds()`, returning `Hold`s) and `walletcap holds` list the
  open payments that still count: id, amount, reason (in flight, refused, unknown), age, and
  when each stops counting. `walletcap release --all-unknown --older-than <24h|7d|30m>` gives
  back every payment of unknown or refused outcome older than that, for an owner who has checked
  the chain, except one whose settle-by time is still ahead: the payee could still settle it. One
  with no settle-by time, which the wallet may have signed as it failed, goes only once it is an
  hour and a minute old (`UNBOUNDED_HOLD_MS`).
- A budget or payment-count refusal names the open payments that take up the room, oldest
  first, and says how to list and release them. `BudgetRefused.brief`, and `brief` beside
  `message` in `budget.check()`, is the refusal without them. The x402 guard (and so AgentKit),
  the CDP store and the Agentic Wallet wrapper, with its CLI and MCP proxy, tell the agent only
  that.
- Python's `pay()` takes `settles_by`, as JavaScript's `pay()` takes `settlesBy`. Python's
  `Reservation` and `Ledger` have `annotate()`.
- The Agentic Wallet wrapper:
  - It hands the wallet, as `paymentRequirements`, the terms it can price that are valid an hour
    or less, from the caller's or the ones walletcap discovered, with the 402's extensions unless
    the caller gave some. The wallet then skips its own discovery and signs only a term equal to
    one of them. A `discover` option of one's own may return the 402 answer or its list of terms.
  - Once the wallet answers, a paid request counts until the longest `maxTimeoutSeconds` among
    the terms it was handed (a Solana term at least two minutes, the life of its blockhash), plus
    a minute, after that answer, plus one window, instead of until it is released. That holds for
    one the payee calls settled too. One the wallet never answered counts until it is released.
  - A free endpoint's one-unit hold is released unless the payee confirms a payment, so a free
    endpoint that fails can't use up `maxPayments`.
  - Every ledger write after the wallet answers raises `PaymentNotRecorded` if it fails.
- `cdpStore()` and `SharedBudgetStore` refuse options they don't take. The docs ask for CDP
  1.60.0 or later, whose published source refuses a `maxTimeoutSeconds` over 3600. A payment CDP
  rolls back counts as long as it would have settled, an hour and a minute after CDP recorded it
  plus one window, instead of until it is released.
- The docs no longer say machines can share a budget through a shared volume. The budget file
  serves one host: SQLite's locks aren't reliable over NFS, SMB or Docker Desktop bind mounts,
  and multiple hosts need a shared service, which isn't shipped yet.
- `spec/vectors/money.json` holds the amounts both test suites must read the same way, or refuse.
- `walletcap-crash-test` 0.3.1 depends on walletcap `^0.3.0`. In its AgentKit row, walletcap now
  passes over the merchant's first-listed $1.00, valid 4 days, and the offer left is the 1¢ one
  the agent approved, where it refused the payment before. walletcap limits the amount, not which
  offer is paid; the row passes only if walletcap signs the approved offer or nothing.

## 0.2.4 — 2026-11-06

### Added

- `mcpName` in the npm package and a `server.json`, so `walletcap awal-mcp` can be listed in the
  official MCP Registry as `io.github.coriolislabs/walletcap`. `glama.json` names the maintainer
  for Glama.
- A docs site, https://coriolislabs.github.io/WalletCap/, with one page per integration, and
  `llms.txt`.

### Fixed

- The `create` doc comment in `index.d.ts` said it defaulted to true. It defaults to false.

### Changed

- Package descriptions and search keywords on npm and PyPI, and a README that leads with the
  crash test.

## 0.2.3 — 2026-11-06

### Changed

- Releases are published from GitHub Actions with trusted publishing: npm with provenance,
  PyPI with PEP 740 attestations. No token is stored. A GitHub Release whose tag doesn't
  match the package version is refused.

### Fixed

- `AccountCapSpender` no longer locks an account after a burst of payments. An unbounded log
  made the first payment after 3,000 tiny ones cost about 17.7M gas, past the 2^24
  per-transaction cap. The window is now counted in 24 buckets in a fixed ring of 25 slots, so
  every `pay` costs the same gas. A payment counts for up to one bucket (window/24) past its
  window, never less. The window must be a multiple of 24 seconds.
- `walletcap awal-mcp` ran `npx -y @coinbase/payments-mcp`, which is Coinbase's installer, not
  the MCP server. It now runs the installed server, `~/.payments-mcp/bundle.js`, and says how to
  install it when it is missing.
- `walletcap awal-mcp` forwarded every tool it didn't count. It now passes through only the
  tools that move no money, and counts `send` and `make_http_request_with_x402`. It refuses
  everything else, `trade` included, and leaves those tools out of `tools/list`, unless the
  owner names one with `--allow-tool`. JSON-RPC batches and lines that aren't JSON are refused.

### Added

- `budget.guardAgentKit(provider)` puts the budget on every x402 client an AgentKit
  `X402ActionProvider` builds. The README's subclass recipe didn't compile in TypeScript,
  where `createX402Client` is private. `tsc` now checks the recipe against AgentKit's declared
  types in the test suite.

## 0.2.2 — 2026-11-05

### Changed

- A mixed-case EVM address is checked against EIP-55 before it is accepted. A bad
  checksum is refused; all-lowercase and all-uppercase hex are still accepted.
- A Solana CAIP-10 address is reduced to its address, so it and the bare address
  share one budget.
- Numeric `window` values are milliseconds in Python too, matching JavaScript.

### Fixed

- The rolling window cannot be shortened once the budget has spend. An edit can
  change the cap and the per-payment limit, but it cannot reset the count by
  shrinking the window.

### Added

- `SECURITY.md`, `docs/threat-model.md`, `docs/vendor-disclosure.md`, and the
  Solidity audit status in `solidity/README.md`.
- `examples/quickstart/` in JavaScript and Python, run in CI. No wallet, chain,
  keys or network.
- EIP-55, Solana CAIP-10, and window-freeze tests in both languages.

## 0.2.1 — 2026-11-05
