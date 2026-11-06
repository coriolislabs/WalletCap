<!-- SPDX-License-Identifier: Apache-2.0 -->
# Changelog

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
