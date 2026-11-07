# 0001. The rule lives in SQLite, run by both packages

## Context

Through 0.3, the JavaScript and Python packages each implemented the ledger: the tables, the
counting rule and admission, by hand, twice. They drifted (0.2.2, a patch, changed what Python's
window numbers meant), and the core took the time and the payment's identity from its callers.
The options were: keep two ledgers and test them against shared vectors; one Rust core with Node
and Python bindings; one WebAssembly core; or put the rule in the store both already use.

## Decision

The rule is SQL: `spec/schema.sql` holds the tables, the counting rule (in the projection
triggers), admission (one conditional `INSERT … SELECT … WHERE`) and every statement the clients
run, by name. Both packages ship the file and run it as written. What each language still does
on its own is read input and word refusals, and the golden vectors in `spec/vectors/` pin both.

A Rust core would remove the drift too, but costs prebuilt binaries for about eight platforms,
the zero-dependency install, and contributors without Rust; the hard part is the contract, not
the code's volume. A WebAssembly core can't use SQLite's cross-process file locks. Two ledgers
plus vectors detect drift but don't remove it.

## Consequences

- Admission is identical in both languages, and in the `sqlite3` shell: the triggers check the
  same rule on any insert.
- The cross-language contract is the statement names and parameters in `schema.sql`; changing
  one is a file-format change ([STABILITY.md](../../STABILITY.md)).
- A Postgres backend gets the same rule as one SQL function under a row lock; that is future
  work.
