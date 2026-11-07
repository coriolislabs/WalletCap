#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# The local gate: the steps .github/workflows/ci.yml runs, in the same order, on one machine with
# one Node and one Python. Hosted CI runs the operating-system and version matrix.
# Needs node 22.13+, npm, uv and python3; forge if you have it.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s ==\n' "$1"; }

step "Install the workspace from the lockfile"
npm ci --no-audit --no-fund

step "Lint and types: Biome, strict TypeScript, ruff, mypy --strict"
npx biome check --error-on-warnings
npm run build
(cd packages/python && uv run --locked ruff check && uv run --locked ruff format --check && uv run --locked mypy)

step "walletcap and walletcap-mcp"
npm test -w walletcap
npm test -w walletcap-mcp

step "Python"
(cd packages/python && uv run --locked pytest -q)

step "Quickstarts"
node examples/quickstart/quickstart.mjs >/dev/null
python3 examples/quickstart/quickstart.py >/dev/null

step "Contracts"
if command -v forge >/dev/null 2>&1; then
  (cd contracts && forge test)
else
  echo "forge not found; skipping the Foundry tests (CI runs them)"
fi
(cd contracts/evm && node check.mjs ..)

step "Pack and install"
bash scripts/pack-smoke.sh

step "JS and Python race, kill -9"
node scripts/race/race.mjs --seconds 45

step "Quint model"
(
  cd spec/quint
  npx -y @informalsystems/quint@0.33.0 run ledger.qnt --main=ledgerClock --invariant=capHolds --max-steps=24 --max-samples=20000
  if npx -y @informalsystems/quint@0.33.0 run ledger.qnt --main=processClocks --invariant=capHolds --max-steps=24 --max-samples=20000 >/dev/null; then
    echo "expected a violation with skewed clocks" >&2
    exit 1
  fi
  echo "With a clock per process, the simulator finds the overspend, as expected."
)

step "Crash test, on this checkout's walletcap"
(cd bench/crash-test && node contracts/build.mjs --check && node --test)

echo
echo "All checks passed."
