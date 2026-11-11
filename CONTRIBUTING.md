<!-- SPDX-License-Identifier: Apache-2.0 -->
# Contributing to walletcap

walletcap is a spend guard, so a change is judged by one question: can more money leave a wallet
than its budget allows, or can the count be read wrong? This page is the working loop and the
rules that keep the answer no.

Found a way past the guard? Don't open an issue. [SECURITY.md](SECURITY.md) says how to report it.

## Set up

You need Node 22.13 or later, npm and [uv](https://docs.astral.sh/uv/). Foundry is only for the
contract's tests.

```console
$ git clone https://github.com/coriolislabs/WalletCap.git && cd WalletCap
$ npm ci
$ npm run check
```

`npm ci` installs the whole workspace from the lockfile. uv makes the Python environment the
first time a command needs it, from `packages/python/uv.lock`.

## The loop

| Command | What it runs | About |
|---|---|---|
| `npm run check` | lint, types, and the JavaScript and Python suites | 2 minutes |
| `npm run check lint` | the workflows' rules, Biome, `tsc`, ruff, `mypy --strict` | 15 seconds |
| `npm run check js` | `walletcap` and `walletcap-mcp` | 1 minute |
| `npm run check python` | the Python package | 1 minute |
| `npm run check js -- test/x402.test.mjs` | one JavaScript test file | seconds |
| `npm run check python -- -k doctor` | pytest, with its own arguments | seconds |
| `npm run ci` | the whole gate: all of the above, the quickstarts, the contract, the packed packages installed in empty projects, six processes racing on one file under `kill -9`, the Quint model and the crash test | 10 minutes |

Every command builds the TypeScript first: both suites run the built package, and the Python
suite drives the npm command line beside its own. Hosted CI runs the whole gate on Linux, macOS
and Windows, on Node 22 and 24 and Python 3.11 to 3.13, so `npm run check` is enough before
most pushes. To run the lint before every push:

```console
$ git config core.hooksPath .githooks
```

Try a change by hand on a throwaway file. `doctor` and `check` only read:

```console
$ export WALLETCAP_PATH=/tmp/walletcap-dev/budget.sqlite
$ node packages/js/dist/cli/main.js set --wallet 0xd797ead28c38575fdf4fc523866287372340ca02 --per-day 150 --per-payment 50
$ node packages/js/dist/cli/main.js doctor
$ node packages/js/dist/cli/main.js check 12.50
$ (cd packages/python && uv run python -m walletcap status)
```

## Where a change goes

| You are changing | It lives in | And also needs |
|---|---|---|
| Admission, counting, a payment's states | `spec/schema.sql`, explained in `spec/ledger.md` | a sequence in `spec/vectors/ledger.json`; both packages run the SQL as written, so neither gets a copy of the rule |
| How input is read (dollars, windows, wallet names) | `packages/js/src/core/money.ts` and `packages/python/src/walletcap/money.py` | a case in `spec/vectors/money.json`, which both suites read |
| A public name, option or field | both packages | `spec/vectors/names.json` and [STABILITY.md](STABILITY.md) |
| A command or a `--json` field | `packages/js/src/cli/` and `packages/python/src/walletcap/__main__.py` | a row in `packages/python/tests/test_cli_json.py`, which runs both command lines and compares their output |
| A payment rail | `packages/js/src/adapters/` | a test against the vendor's real client, pinned in `devDependencies`; no runtime dependency |
| The budget file's format | `spec/schema.sql` and `spec/upgrade.sql` | a fixture an older version wrote, in `spec/fixtures/`, and a minor version |

## Rules

1. **Fail closed.** If the count can't be read, a payment's terms can't be priced or an input
   can't be parsed one way only, refuse. An error never settles a payment and never releases one.
2. **Count what the wallet signs.** A payee controls every byte of its terms. Hold the most the
   signed payload can move, for as long as it can still move it.
3. **One rule, two languages.** The JavaScript and Python packages share one file and one SQL
   rule. A change to one package that the other doesn't make is a bug, and the shared vectors
   are how the suites notice.
4. **A fix comes with the test that failed.** For a way past the guard, write the test first,
   watch it fail, then fix it. Say in the test what the old version did.
5. **No runtime dependencies.** Either package. Adding one is a breaking change.
6. **Write it down.** Anything a user can observe goes in [CHANGELOG.md](CHANGELOG.md) under the
   next version, and a decision someone would otherwise re-argue gets a record in `docs/adr/`.

## Pull requests

Keep one change to a pull request, and say what it lets through or refuses that the old code
didn't. CI must pass. [RELEASING.md](RELEASING.md) covers versions and publishing, which the
maintainers do.
