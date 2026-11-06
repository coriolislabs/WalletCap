<!-- SPDX-License-Identifier: Apache-2.0 -->
# Changelog

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
