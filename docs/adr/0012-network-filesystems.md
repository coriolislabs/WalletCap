# 0012. Network filesystems: unsupported, not detected yet

## Context

SQLite's locks aren't reliable over NFS, SMB or Docker Desktop bind mounts, and WAL needs shared
memory those don't give reliably. Two hosts sharing a budget file there can both take the last
dollar. The review asked walletcap to refuse such a file at open.

## Decision

The docs say the file serves one host, on a local disk, and that multiple hosts need a service.
walletcap 0.4 doesn't detect a network filesystem: Node can read a filesystem's type, but Python's
standard library can't without platform-specific code, and a check in one language only would
break the rule that both behave the same.

## Consequences

- A remaining limit, listed in the threat model.
- Multiple hosts are for `walletcapd` or a Postgres backend with the same rule under a row lock.
