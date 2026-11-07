#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Run the same gate locally, on CircleCI, or on any other runner.
set -euo pipefail
cd "$(dirname "$0")/.."

export npm_config_cache="${npm_config_cache:-${TMPDIR:-/tmp}/walletcap-npm-cache}"
mkdir -p "$npm_config_cache"

echo "== JavaScript: walletcap and walletcap-mcp =="
npm ci --no-audit --no-fund
npm test

echo "== Python =="
if python3 -c "import pytest" >/dev/null 2>&1; then
  (cd packages/python && python3 -m pytest -q)
elif command -v uv >/dev/null 2>&1; then
  (cd packages/python && UV_CACHE_DIR="${UV_CACHE_DIR:-${TMPDIR:-/tmp}/walletcap-uv-cache}" \
    uv run --no-project --with pytest --python 3.12 pytest -q)
else
  echo "pytest is not installed; run: python3 -m pip install pytest" >&2
  exit 1
fi

echo "== Examples =="
node examples/quickstart/quickstart.mjs >/dev/null
python3 examples/quickstart/quickstart.py >/dev/null

echo "== Contracts (Foundry) =="
if command -v forge >/dev/null 2>&1; then
  (cd contracts && forge test)
else
  echo "forge not found; skipping Foundry tests"
fi

echo "== Contracts (EVM check) =="
(cd contracts/evm && npm install --no-audit --no-fund --no-package-lock && node check.mjs ..)

echo "== Crash test, on this checkout's walletcap =="
(cd bench/crash-test && node contracts/build.mjs --check && node --test)

echo "All checks passed."
