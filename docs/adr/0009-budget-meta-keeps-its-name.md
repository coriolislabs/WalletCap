# 0009. budget_meta keeps its name

## Context

walletcap 0.2 and 0.3 create their tables with `CREATE TABLE IF NOT EXISTS`, then read the
`schema` row of `budget_meta`, and refuse a value they don't know. A 0.3 process that opened a
file without `budget_meta` would create its own empty tables and could pay against an empty
count.

## Decision

Schema 3 keeps the version in a table named `budget_meta`, with `schema = '3'`, in new files and
upgraded ones alike. Every other table is new (`wc_budget`, `wc_entry`, `wc_current`,
`wc_budget_log`).

## Consequences

- 0.2 and 0.3 refuse a schema 3 file instead of counting beside it.
- The upgrade renames the old tables, migrates them, and drops them in one transaction.
