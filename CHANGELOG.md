<!-- SPDX-License-Identifier: Apache-2.0 -->
# Changelog

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
- The Agentic Wallet wrapper refuses a paid x402 request, before the wallet is asked, if any of
  its terms asks for more than an hour or gives no whole number of seconds (reason `'timeout'`).
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
  the chain, except one whose settle-by time is still ahead: the payee could still settle it.
- A budget or payment-count refusal names the open payments that take up the room, oldest
  first, and says how to list and release them. `BudgetRefused.brief` is the refusal without
  them, and the Agentic Wallet wrapper, its CLI and its MCP proxy tell the agent only that.
- Python's `pay()` takes `settles_by`, as JavaScript's `pay()` takes `settlesBy`. Python's
  `Reservation` and `Ledger` have `annotate()`.
- The Agentic Wallet wrapper:
  - It hands the wallet the terms it priced as `paymentRequirements`: the caller's, or the ones
    walletcap discovered, with the 402's extensions unless the caller gave some. The wallet then
    skips its own discovery and signs only a term equal to one of them.
  - Once the wallet answers, a paid request counts until the longest `maxTimeoutSeconds` among
    its terms (a Solana term at least two minutes, the life of its blockhash), plus a minute,
    after that answer, plus one window, instead of until it is released. That holds for one the
    payee calls settled too. One the wallet never answered counts until it is released.
  - A free endpoint's one-unit hold is released unless the payee confirms a payment, so a free
    endpoint that fails can't use up `maxPayments`.
  - Every ledger write after the wallet answers raises `PaymentNotRecorded` if it fails.
- `cdpStore()` and `SharedBudgetStore` refuse options they don't take. The docs ask for CDP
  1.60.0 or later, whose published source refuses a `maxTimeoutSeconds` over 3600.
- The docs no longer say machines can share a budget through a shared volume. The budget file
  serves one host: SQLite's locks aren't reliable over NFS, SMB or Docker Desktop bind mounts,
  and multiple hosts need a shared service, which isn't shipped yet.
- `spec/vectors/money.json` holds the amounts both test suites must read the same way, or refuse.
- `walletcap-crash-test` 0.3.1 depends on walletcap `^0.3.0`.

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
