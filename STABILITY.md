<!-- SPDX-License-Identifier: Apache-2.0 -->
# Stability

What counts as walletcap's public API, and how versions change it. This applies from 0.4.0.

## Versions

- walletcap follows [semantic versioning](https://semver.org/). While it is 0.x, a breaking
  change bumps the minor version (0.4 to 0.5), and anything else bumps the patch.
- A change to the budget file's format bumps the minor version. The new version upgrades an
  older file in place, in one transaction, the first time it opens it, and every payment that
  counted keeps counting at least as long. Older versions refuse the upgraded file.
- The npm package `walletcap` and the PyPI package `walletcap` share one version number and are
  released together, from a GitHub Release tagged `v<version>`. `walletcap-mcp` (tags
  `mcp-v<version>`) and `walletcap-crash-test` (tags `crash-test-v<version>`) have their own.
- The [CHANGELOG](CHANGELOG.md) lists every change to the public API, under the version that made
  it, and notes a deprecation in the release that makes it.

## Public API

### npm `walletcap` (Node 22.13 or later)

Each entry point, and the names it exports. Exported TypeScript types are public too.

| Entry point | Exports |
|---|---|
| `walletcap` | `openBudget`, `Budget`, `Hold`, `openOwner`, `Owner`, `BudgetUnavailable`, `BudgetRefused`, `PaymentNotRecorded`, `UsageError`, `notSent`, `toMicros`, `formatUsd`, `defaultBudgetPath`, `MAX_AMOUNT`, `SCHEMA_VERSION`, `MIN_SQLITE_VERSION`; types `BudgetOptions`, `HoldOptions`, `Check`, `Status`, `Payment`, `HeldPayment`, `PaymentRecord`, `BudgetLimits`, `VoidedPayment`, `OwnerOptions`, `LimitOptions`, `Dollars`, `Micros`, `Window`, `RefusalCode`, `RefusalSource`, `Outcome`, `PaymentState`, `NotSent` |
| `walletcap/x402` | `guard`, `MAX_PAYMENT_TIMEOUT_SECONDS`, `USD_ASSETS`; types `AssetEntry`, `PaymentRequirements`, `PaymentCreationContext`, `PaymentCreatedContext`, `PaymentCreationFailureContext`, `PaymentResponseContext`, `X402HookedClient` |
| `walletcap/cdp` | `cdpStore`; types `SpendStore`, `SpendLedgerEntry`, `SpendLedgerEntryInput` |
| `walletcap/agentkit` | `guardAgentKit`; type `AssetEntry` |
| `walletcap/agentic` | `guardAgenticWallet`, `discoverRequirements`, `usdcAtomic`, `AWAL_CHAINS`; types `WalletRequest`, `RequestData`, `PaymentRequired`, `GuardedWallet`, `FetchLike` |

Every method of the payer and owner handles returns a Promise, except `close()` and
`[Symbol.dispose]()`, which close the file at once and return nothing; `[Symbol.asyncDispose]()`
returns a Promise, for `await using`. The CDP store's `close()` does nothing and returns nothing:
the budget's own `close()` closes the file. The package has no runtime dependencies, and adding
one is a breaking change.

Every result the handles return (`check`, `status`, `history`, `holds`, `payment`, `budgets`,
`voidUnknown`) is a plain object with a `toJSON()` kept out of its keys. It gives the shape both
CLIs print with `--json`: snake_case keys, amounts and counts as decimal strings, times as ISO-8601
UTC to the millisecond, and `null` for a field with no value. So `JSON.stringify(await
budget.status())` doesn't throw on a bigint, and prints what `walletcap status --json --wallet`
prints for that budget, its `path` included.

The `.d.ts` files compile on their own, with `skipLibCheck` off, `lib: ["es2022"]`, no
`@types/node`, and `nodenext` or `bundler` resolution; a test compiles a project that way against
the packed package. They add `esnext.disposable` to the project's `lib`, for `await using`.
The package reads no file of its own at run time, so a bundler can bundle it; a test bundles an
app with esbuild and runs it from another folder.
`guard()` takes @x402/core's `x402Client`, and `cdpStore()` returns a `SpendStore` that
`applySpendControls` in @coinbase/cdp-sdk takes. A change that breaks either is a breaking change.

### PyPI `walletcap` (Python 3.11 or later)

Every name in `walletcap.__all__`: `open_budget`, `Budget`, `Hold`, `Paying`, `open_owner`,
`Owner`, `BudgetUnavailable`, `BudgetRefused`, `PaymentNotRecorded`, `UsageError`, `NotSent`,
`BudgetWarning`, `Check`, `Status`, `Payment`, `HeldPayment`, `PaymentRecord`, `BudgetLimits`,
`VoidedPayment`, `Micros`, `Dollars`, `Window`, `RefusalCode`, `RefusalSource`, `PaymentState`,
`Outcome`, `to_micros`, `format_usd`, `default_budget_path`, `MAX_AMOUNT`, `SCHEMA_VERSION`,
`MIN_SQLITE_VERSION` and `__version__`. The package has no dependencies.

The Python names match the JavaScript ones, in Python's naming convention: `open_budget` for
`openBudget`, `set_limits` for `setLimits`, `void_unknown` for `voidUnknown`, `payment_id` for
`paymentId`, `windowMs` for `window_ms`, `busyTimeoutMs` for `busy_timeout_ms` (milliseconds in
both). The async forms of the payer's methods are `acheck`, `ahold`, `apayment`, `astatus`, `aholds`
and `ahistory`, and a hold's are `asettle`, `avoid`, `asettles_by`, `asettles_within` and `anote`.
Where a value's type differs, each takes its language's own: a hold's `settlesWithin` is
milliseconds in JavaScript and a `timedelta` in Python, and `settlesBy` a `Date` or milliseconds
in JavaScript and an aware `datetime` in Python. `code`, `source`, `state` and `outcome` are
string unions in JavaScript and `Literal` types in Python, with the same values.
[spec/vectors/names.json](spec/vectors/names.json) lists the names, fields, options and values
the two share, and both test suites check their package against it. Each package also has a few
of its own: npm's `notSent()` and the option types (`BudgetOptions`, `HoldOptions`,
`OwnerOptions`, `LimitOptions`); Python's `NotSent`, `BudgetWarning`, `Paying` and a hold's
writable `tx` inside `with budget.pay(...)`.

### Amounts

The two packages read numbers the same way, and every amount they return reads back as itself:

| | JavaScript | Python |
|---|---|---|
| Micro-dollars | `bigint` (`Micros`, a branded bigint) | `Micros` |
| Dollars | `number`, a string like `"$12.50"` | `int`, `float`, `Decimal`, a string |
| Arithmetic on an amount | bigint arithmetic, which stays bigint, so stays micro-dollars | a `Micros`, or `TypeError`; never a bare number |

So `check(status().remaining)`, `check(remaining / 2n)` and `check(remaining // 2)` read
micro-dollars in both. Converting an amount to a plain number yourself, `Number(remaining)` or
`int(remaining)`, gives micro-dollars that walletcap would read as dollars: don't pass one back.
ADR 0015 records why.

### Errors

Four classes, the same in both languages, with no common base: `BudgetUnavailable`,
`BudgetRefused`, `PaymentNotRecorded` and `UsageError`. None of the Python ones is a
`ValueError`. Moving an error from one class to another is a breaking change.

`UsageError` from a hold of an id already in the ledger carries `paymentId` and `paymentState`
(Python `payment_id` and `payment_state`): which payment holds the id, and where it stands. They
are null for every other `UsageError`.

`BudgetRefused.code` is one of:

| code | Refused because |
|---|---|
| `budget` | the window's count plus the payment is over the cap |
| `per_payment` | the payment is over the per-payment limit |
| `max_payments` | the window already holds the most payments allowed |
| `frozen` | the budget is frozen |
| `asset` | an adapter can't price the asset |
| `timeout` | the payment terms are valid longer than an hour, or don't say how long |
| `terms` | an adapter can't read the payment terms |

`BudgetRefused.source` is `budget` (the owner's limits) or `process` (the paying process's own).
`BudgetRefused.brief` is the refusal without the ids of open payments; its wording, and every
other message's, may change in any release.

### Command lines

- `walletcap` (npm), and `walletcap` or `python -m walletcap` (PyPI): the commands `status`,
  `set`, `freeze`, `unfreeze`, `history`, `holds`, `void <id> [--evidence <text>]`,
  `void --all-unknown --older-than <duration>` and
  `settle <id> [--tx <hash>] [--evidence <text>]`, with the flags `--wallet`, `--path`,
  `--per-payment`, `--per-hour`, `--per-day`, `--per-week`, `--cap`, `--window`,
  `--max-payments`, `--limit`, `--older-than`, `--all-unknown`, `--tx`, `--evidence` and
  `--json`. The npm CLI also has `awal <command>`.
- Exit codes: 0 when the command worked; 1 when walletcap refused or couldn't use the budget;
  2 when the command line is wrong.
- `--json` prints the same output from both command lines, field for field: object keys in
  snake_case (`window_ms`, `in_flight`, `counts_until`), every amount, count and duration as a
  string of decimal digits (micro-dollars for amounts), every time as an ISO 8601 UTC string to
  the millisecond (`2027-01-15T08:00:00.000Z`), and `null` for a field with no value. A test
  runs every command through both command lines on copies of one file and compares the output.
- The fields of `--json` output are public: a release may add fields, and removing or renaming
  one is a breaking change. The plain-text output is for people and may change.
- `walletcap-mcp`: the flags `--wallet`, `--path`, `--allow-tool` and `--help`, and a server
  command after `--`. It exits with the MCP server's own code, 1 when the default server isn't
  installed, and 2 when `--` has no command after it. Which tools it counts, passes through or
  refuses is public behaviour, and the CHANGELOG names every change to those lists.

### The budget file

- Its format is schema 3, recorded as `schema` in the file's `budget_meta` table. walletcap 0.2
  (schema 1) and 0.3 (schema 2) refuse it.
- [spec/schema.sql](spec/schema.sql) is the contract between the JavaScript and Python
  packages: its tables, its views `wc_clock` and `wc_room`, and its named statements with their
  parameters. A change to them is a file-format change. [spec/ledger.md](spec/ledger.md)
  describes the state machine they implement.
- Reading the file with SQL is fine. Writing to it outside the statements is refused by its
  triggers, and dropping the triggers is unsupported.

## Not public

- Modules whose names start with `_`: `_clock`, `_keccak`, `_ledgers`, `_spec.generated` and
  `adapters/_x402` in the npm package, and `walletcap._clock`, `walletcap._keccak` and
  `walletcap._ledger` in the PyPI one.
- Anything in `packages/js/src/core` that the entry points above don't export, such as the
  ledger client and `budgetPathFor`.
- The test clock: replacing `julianday('now')` on a test's own connections. It exists for
  walletcap's own tests.
- A hold's token, the `holder` of a `held` entry in the file. No API returns it; only the
  ledger's own statements read it.
- Message wording, the plain-text output of the command lines, and the order of rows in results
  except where the API says (`history` is newest first, `holds` oldest first).
- The `walletcap-crash-test` package's output, beyond what its README says.
