# Design records

Why the walletcap ledger is built the way it is. Each record gives the context, the decision
and its consequences.

- [0001. The rule lives in SQLite, run by both packages](0001-the-rule-lives-in-sqlite.md)
- [0002. An append-only ledger, with each payment's current state derived from it](0002-append-only-ledger-with-a-derived-current-state.md)
- [0003. The ledger reads its own clock, in SQL](0003-the-ledger-reads-its-own-clock.md)
- [0004. A settle-by time not after now: refused by the API, clamped by the rule](0004-settle-by-times-refused-in-the-past-clamped-in-the-rule.md)
- [0005. The CDP store holds payments; it doesn't settle them](0005-the-cdp-store-holds-payments.md)
- [0006. A paying process's limits only tighten, for that process](0006-a-processs-limits-only-tighten.md)
- [0007. No error's text releases a payment](0007-no-error-text-releases-a-payment.md)
- [0008. WAL with full sync, and a private file](0008-wal-with-full-sync-created-0600.md)
- [0009. budget_meta keeps its name](0009-budget-meta-keeps-its-name.md)
- [0010. VOID to SETTLED can put the count over the cap](0010-void-to-settled-can-pass-the-cap.md)
- [0011. Python keeps its sync API, with async forms](0011-python-keeps-a-sync-api.md)
- [0012. Network filesystems: unsupported, not detected yet](0012-network-filesystems.md)
