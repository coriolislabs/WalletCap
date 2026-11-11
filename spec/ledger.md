<!-- SPDX-License-Identifier: Apache-2.0 -->
# The walletcap ledger

This is the contract both packages implement by running [`schema.sql`](schema.sql) as written.
Neither language decides admission or counting: SQLite does, in the file, with the same
statements for every client. What the clients still do on their own is read input (dollars,
windows, wallet names) and word refusals; [`vectors/`](vectors) pins both.

## Terms

- **Budget**: one per wallet, kept under the wallet's canonical name: `cap` per rolling
  `window`, and optionally `per_payment` and `max_payments` per window. Amounts are integers in
  the budget's unit: micro-dollars for `usd`, so one USDC base unit is one unit.
- **Payment**: an amount that may leave the wallet, from the moment it is held.
- **Now**: the ledger's clock, `wc_clock`: SQLite's `julianday('now')` in milliseconds since
  the Unix epoch, read inside the statement that uses it. No client passes a time that the
  ledger takes as the present.

## States

A payment is in one of three states, keyed by its identity.

| State | Means | Counts at time τ while |
|---|---|---|
| `HELD(until)` | it may still move money, up to `until` | τ ≤ max(until, held_at) + W |
| `HELD(open)` | it may still move money, and nothing bounds when | always |
| `SETTLED` | evidence says it moved money | τ ≤ max(settled_at, until, held_at) + W |
| `VOID` | evidence says it never moved money, and never will | never |

W is the budget's window. `held_at` and `settled_at` are the ledger's time when those entries
were appended. `until` is the last moment the payment could still settle: an EIP-3009
`validBefore`, a Permit2 `deadline`, or the ledger's now plus the most time the payment's terms
allow, whichever the client can show. A settled payment keeps its hold's `until`: the word that
a payment settled may come from the payee, who could still redeem the authorization later, so a
settlement never makes a payment count for less time than its hold would have.

### Transitions

| From | To | Entry | When |
|---|---|---|---|
| — | `HELD` | `held` | admission (below) allows it |
| `HELD(open)` | `HELD(until)` | `bound` | the client learns `until`, which must be after now |
| `HELD` | `HELD` | `noted` | the client learns the outcome is `unknown` or the payee `refused` it; counting is unchanged |
| `HELD` | `SETTLED` | `settled` | evidence that it paid (a transaction hash, or the payee's word) |
| `HELD` | `VOID` | `void` | evidence that it never left: the payer's (`notSent`), or the owner's after checking the chain |
| `VOID` | `SETTLED` | `settled` | later evidence that it paid after all |

Transitions only move forward: `HELD` < `VOID` < `SETTLED`, and a bound, once set, stays.
Every transition is idempotent: settling a settled payment, voiding a void one, or bounding one
that has an `until` appends nothing and succeeds. Anything else, such as voiding a settled
payment, is refused. An exception in the code that makes a payment never settles it: the
payment stays `HELD`, noted `unknown`.

Two parties append transitions. The paying process's statements, `settle`, `void`, `bound` and
`note`, need the token its hold returned (Identity, below); without it they append nothing, and
the client refuses the move, a settled payment's included. The owner's, `owner_settle` and
`owner_void`, need no token (settling a payment that is already settled succeeds): they reconcile a
payment, whoever held it, from evidence such as the chain's record.

The owner's bulk release, `void_unknown`, voids every `HELD` payment of `unknown` or `refused`
outcome, held at least a given time ago, that can no longer settle: its `until` has passed, or
it has none, was held on an x402 rail (`x402`, `awal-x402`) and its latest entry, the note of
its failure, is an hour and a minute old. An x402 authorization walletcap lets be signed lasts
an hour at most, and the wallet signs it, if at all, before it answers. Any other payment with no
`until`, a transfer say, can still be mined however old it is: the owner voids it by id, with
evidence ([ADR 0014](../docs/adr/0014-the-61-minute-release-is-for-x402-holds.md)).

### Rows

`wc_entry` is the ledger: one row per state a payment enters, appended in order (`seq`), dated
by the ledger's clock, never updated or deleted. `wc_current` holds each payment's latest state;
the projection triggers write it from `wc_entry` in the same transaction, the guards refuse any
other write to it, and replaying `wc_entry` into an empty file rebuilds it. Its `counts_from`
column is where the counting rule lives:

    HELD(open)    counts_from = 2^63 - 1
    HELD(until)   counts_from = max(until, held_at)
    SETTLED       counts_from = max(settled_at, until, held_at)
    VOID          counts_from = NULL

and a payment counts at now while `counts_from >= now - W`. The index on
`(wallet, counts_from, amount)` makes every count a range read of the payments that can still
count, however long the history. No payment is ever deleted.

## Identity

A payment's identity is the rail's own, so the same payment can't be held twice and evidence
can find it again:

- `eip3009:<from>:<nonce>`: an EIP-3009 authorization (x402's `exact` scheme on EVM);
- `permit2:<owner>:<nonce>`: a Permit2 transfer;
- `tx:<hash>`: a transaction;
- a key the caller supplies, such as an order id;
- otherwise the ledger's own: `wc-` and 32 random hex digits.

Holding an identity that is already in the ledger appends nothing, and the client refuses the
hold, whatever room the budget has left, saying where that payment stands. An identity is one
payment, held once: handing a caller the existing payment would let a retry pay it a second
time, and a voided identity would bring back a payment that was given up. A process that
restarts looks its payment up instead.

Each `held` entry carries `holder`, a token of 32 random hex digits that the client makes for
the hold and hands back only to the call that appended it. The paying process's moves need it,
so a process that knows a payment's identity, from `holds` or from holding it again, can't move
it: a hold of an existing payment comes back without a token. The token is in the file, and
anything that can write the file can read it: it keeps walletcap's callers from moving each
other's payments, and isn't an OS boundary ([ADR 0013](../docs/adr/0013-a-payments-moves-belong-to-the-hold-that-took-it.md)).

## Admission

A hold of `amount` on wallet `w` at now is admitted when all of these hold, in this order:

1. the budget is not frozen;
2. `amount <= per_payment`, when set;
3. `counted(w, now) + amount <= cap`;
4. `payments(w, now) < max_payments`, when set;
5. the same three checks against any tighter limits the paying process passed, with its own
   window, which bind that process alone;

where `counted` and `payments` are the sum and the number of payments that count at now.
`wc_room.room` is the largest amount that passes 1–4.

Admission is one statement, `hold`: an `INSERT … SELECT … WHERE` that appends the `held`
entry if and only if the verdict is empty, inside a `BEGIN IMMEDIATE` transaction. SQLite lets
one writer at a time into the file, so no two admissions can both take the last of a budget, in
one process or many, in either language. If nothing was appended, the client runs `refusal` in
the same transaction to say why. The `wc_entry_admitted` trigger checks 1–4 again on every
`held` entry, so a client that skipped the conditional insert, or the `sqlite3` shell, is
refused too; the statements never trip it.

The window changes only while no payment counts (`wc_budget_window`): a shorter one would stop
payments counting early.

## The invariant

For every wallet and every time τ:

**Coverage.** Every payment that could have moved money in (τ − W, τ] counts at τ.

A payment can move money only between `held_at` and the latest moment its state allows:
`until` while held with a bound, never while void, and `max(settled_at, until)` once settled. If
it moved money at m in (τ − W, τ], that latest moment is at least m > τ − W, and so is
`counts_from`, which is at least that latest moment. So it counts at τ.

**The cap.** The money moved in (τ − W, τ] is at most `cap`.

Let S be the payments that moved money in (τ − W, τ], and p the one of them admitted last, at
t ≤ τ. Every other payment q in S was admitted before t. If q moved money before t, it moved in
(t − W, t], since τ − W ≥ t − W, and by coverage it counted at t. If q moved after t, it was held
at t with an `until` after t, so `counts_from ≥ until > t − W`, and it counted at t too. So at
t, `counted(w, t) ≥ Σ S − amount(p)`, and admission required `counted(w, t) + amount(p) ≤ cap`.

The proof assumes what the ledger can't check: that a `void` is true (the payment never moved
money), that an `until` is a real bound, that the cap and window weren't changed after S was
admitted, and that the clock doesn't run backwards. A `VOID → SETTLED` transition records that a
void was wrong; the count then includes the payment, and admission refuses until it ages out.
`counted(τ) ≤ cap` itself holds at every admission and between them, except after an owner lowers
the cap or a void is contradicted.

### Why the ledger owns the clock

walletcap 0.2 let each process bring its own clock, and took a payment's time from the caller.
A process whose clock ran a day ahead saw an empty window and paid a second full cap, and a
backdated entry had aged out the moment it was written. Here every time in a row is the ledger's
`now`, read in SQL in the statement that writes it; the `wc_entry_dated` trigger refuses any
other. Processes on one host share one system clock, so they agree. The Quint model in
[`quint/`](quint) checks the invariant with the ledger's clock, and finds the overspend when
each process brings its own, skewed clock.

## Refusals

`refusal` returns the first failed check as `code`:

| code | limit |
|---|---|
| `frozen` | the budget is frozen |
| `per_payment` | the payment is over the per-payment limit |
| `budget` | the window's count plus the payment is over the cap |
| `max_payments` | the window already holds the most payments allowed |

and `source`: `budget` for the owner's limits, `process` for the paying process's own. Adapters
add `asset` (a token walletcap can't price) and `timeout` (terms valid longer than an hour).
A refusal's `brief` is what an agent is told; its message adds, for the owner, the ids of the
open payments that take up the room.

## Upgrades

[`upgrade.sql`](upgrade.sql) turns a file walletcap 0.2 (schema 1) or 0.3 (schema 2) wrote into
schema 3, in one write transaction; [`fixtures/`](fixtures) holds files those versions wrote,
with what 0.3.0 counted in them. Each old row becomes entries that count at least as long:

| schema 2 row | schema 3 entries |
|---|---|
| `reserved`, no expiry | `held` with no `until` |
| `reserved`, expiry E | `held` with `until = E − W − 1` (0.3 stored settle-by + W + 1) |
| `reserved` with outcome `unknown` or `refused` | then `noted` |
| `committed` at T | `held` at T, then `settled` at T |

A schema 1 file first gets 0.3.0's renaming: every spelling of a wallet merges into its
canonical name, with the tighter of every limit, or, in another unit, stays aside and freezes
the wallet. `budget_meta` keeps its name so that 0.2 and 0.3 refuse a schema 3 file.

Before they refuse it, 0.2 and 0.3 create their own tables in it, `budgets` and `spend`, empty.
A client that opens a schema 3 file drops those two, in one write transaction, if they hold no
rows. Stop every 0.2 and 0.3 process before upgrading, so none of them opens the file after.

## The file

One file serves one host. It is opened in WAL mode with `synchronous = FULL`, created `0600`
in a `0700` directory, and refused if its schema is newer than the client's or its SQLite is
older than 3.37.0. SQLite's locks aren't reliable over NFS, SMB or Docker Desktop bind mounts:
a budget shared by several hosts belongs in a service (the coming `walletcapd`, or Postgres with
the same rule as one function under a row lock), not in a shared file.
