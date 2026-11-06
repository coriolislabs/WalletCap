<!-- SPDX-License-Identifier: Apache-2.0 -->
# Changelog

## 0.3.0 — 2026-11-06

This release fixes ways past walletcap's own cap that two reviewers reproduced, and ways its
JavaScript and Python packages read the same input differently. It removes public options and
changes what an error does to a payment, so it is a minor release, not a patch.

### Breaking

- An error never settles a payment. When the payment function throws an error not tagged
  `notSent()` (Python: `NotSent`), the payment stays in flight, marked unknown, instead of being
  committed. It counts until one window past its `settlesBy`, or, without one, until its owner
  releases it with `walletcap release <id>`. `status()` shows it as in flight, not spent. The
  Agentic Wallet wrapper does the same for a send or x402 payment whose outcome is unknown.
- The `clock` option is gone from `openBudget`, `cdpStore` and `SharedBudgetStore`, and from
  Python's `open_budget`, `Budget` and `Ledger`. The ledger reads the system clock. Passing a
  clock is an error.
- Python's `Ledger` no longer takes `reservation_ttl_seconds`.
- A payment that went through but couldn't be recorded raises `PaymentNotRecorded`, not
  `BudgetError`. It is not a subclass of `BudgetError`, and it carries the reservation id
  (`reservationId`, `reservation_id`) and the cause.
- `MAX_AMOUNT` is 10^15 micro-dollars ($1,000,000,000), not 2^63 − 1. A larger amount, cap or
  per-payment limit is refused.
- Python refuses a naive datetime for `settles_by`.
- `guard(client, { assets })` and the Agentic Wallet wrapper's `assets` refuse an entry that
  changes a built-in asset's decimals, and decimals that aren't an integer from 0 to 18.
- Amounts and windows take only the digits 0-9, and only ASCII whitespace is trimmed, in both
  languages. `walletcap awal send` refuses an amount with trailing text, an exponent or a
  separator, and the wrapper refuses a send whose `amountAtomic` isn't plain digits.
- The ledger names every budget the way `openBudget` does. A budget that 0.2.x stored under a
  checksummed address through `SharedBudgetStore` or Python's `Ledger` isn't found under that
  name any more.

### Fixed

- A payment whose function threw was committed, so it counted for one window from the error. A
  transfer whose receipt wait timed out and that was mined a day later let $300 through a $150
  window.
- A `settlesBy` already past was stored as given, so the reservation never counted and a second
  full cap was reserved. It now counts as now.
- The CDP store recorded a payment at the time in CDP's entry, so a backdated entry had already
  aged out. It records at the ledger's own time.
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
  micro-dollars.

### Changed

- Python's `pay()` takes `settles_by`, as JavaScript's `pay()` takes `settlesBy`. Python's
  `Reservation` and `Ledger` have `annotate()`.
- The Agentic Wallet wrapper: when the caller hands the wallet the payment requirements (x402's
  exact scheme on an EVM chain), an unconfirmed payment counts until their `maxTimeoutSeconds`
  after the wallet answers, plus one window, instead of until it is released. A free endpoint's
  payment is committed only on a confirmed settlement.
- `cdpStore()` and `SharedBudgetStore` refuse options they don't take.
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
