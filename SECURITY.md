# Security policy

walletcap is a spend guard that sits on the payment path. If you find a way
around its count, its reservations, or its failure modes, we want to know.

## Supported versions

The latest **0.2.x** release is supported. The 0.2.1 release fixed the
fail-open default and the CDP store/guard collision; earlier 0.2.0 installs
should upgrade before relying on the guard.

## Reporting a vulnerability

Email **paul@coriolislabs.ca** with `walletcap security` in the subject. If you
want to encrypt, ask for a PGP key in the first message; do not send the details
in a public GitHub issue.

Please include:

- the version, language (JavaScript or Python), and platform;
- the configuration (single process or replicas, one file or a shared volume);
- a minimal reproduction, or the sequence of calls;
- what you expected and what happened.

## What to expect

- We aim to acknowledge a report within **5 business days**.
- For walletcap itself we use a **90-day** coordinated disclosure window, and
  we will credit you unless you ask us not to.
- If a fix ships earlier, we will publish the advisory as soon as users can
  upgrade.

## In scope

- the SQLite ledger (`ledger.mjs`, `src/walletcap/ledger.py`) and its
  transaction/counting rules;
- the JavaScript and Python budget APIs and the CLI;
- the x402 guard and the CDP `SpendStore`;
- the Agentic Wallet CLI/MCP wrapper;
- `AccountCapSpender` and its transfer/allowance handling.

## Out of scope

- an agent with shell access on the same OS user: it can call the wallet
  directly or delete the file. The guard is not an OS sandbox.
- editing the SQLite file by someone who can write it;
- private-key custody and the wallet or chain itself;
- vulnerabilities in Coinbase, Safe, MetaMask, Tempo, Google or other vendor
  products. Those are handled under the separate benchmark disclosure policy
  in [docs/vendor-disclosure.md](docs/vendor-disclosure.md).

## Known limitations

See [docs/threat-model.md](docs/threat-model.md) for the full model. The short
version:

- the guard binds only the calls that pass through it;
- the budget file is single-host; a shared volume is not a substitute for a
  database that speaks a network protocol;
- an x402 payment whose settlement cannot be confirmed keeps counting until its
  authorization expires;
- `AccountCapSpender` is **unaudited**; see
  [solidity/README.md](solidity/README.md). Do not deploy it with real funds
  until it has an independent audit.
