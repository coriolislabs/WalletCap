# 0008. WAL with full sync, and a private file

## Context

0.3 used SQLite's rollback journal and created the file with the process's default mode, often
`0644`. Many processes read the budget while one writes, and a payment the ledger admitted must
not disappear in a crash.

## Decision

The file is created `0600`, in a `0700` folder; SQLite gives its WAL and shared-memory files the
same mode. After creating or upgrading the schema, the client switches it to WAL, so readers
don't wait for a writer, and every connection sets `synchronous = FULL`, which syncs the log at
every commit. If another process holds the file open in its old journal mode and the switch is
busy, the file keeps its mode; both are correct.

## Consequences

- Status and history reads don't block admission.
- WAL needs shared memory, which network filesystems don't give reliably; they were never
  supported (see 0012).
- On a disk that acknowledges a sync it hasn't made, the last commits can be lost on power loss.
