<!-- SPDX-License-Identifier: Apache-2.0 -->
# Changelog

## 0.2.1 — 2026-11-05

### Changed

- `openBudget` / `open_budget` no longer create a missing budget by default. The owner
  creates it once with `walletcap set`; pass `create: true` only for a demo or a first-run
  setup. A missing file now refuses every payment.

### Fixed

- The CDP spend store uses its own `cdp` rail instead of sharing `x402` with the guard.
  A 0.2.0 CDP row on the `x402` rail still loads, and a lowercase 402 asset no longer makes
  `cdpStore.load()` throw.
- `budget.guard()` refuses a client that already has CDP spend controls, and a guarded
  client refuses CDP controls before signing. The store and the guard would otherwise count
  one payment twice.

### Added

- Regression tests for the CDP store, the guard/store conflict, and an integration test
  against the published `@coinbase/cdp-sdk@1.60.0`.
