#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Run the same gate locally, on CircleCI, or on any other runner.
set -euo pipefail
cd "$(dirname "$0")/.."

export npm_config_cache="${npm_config_cache:-${TMPDIR:-/tmp}/walletcap-npm-cache}"
mkdir -p "$npm_config_cache"

echo "== JavaScript =="
(cd js && npm install --no-audit --no-fund --no-package-lock && node --test)

echo "== Python =="
if python3 -c "import pytest" >/dev/null 2>&1; then
  python3 -m pytest -q
elif command -v uv >/dev/null 2>&1; then
  UV_CACHE_DIR="${UV_CACHE_DIR:-${TMPDIR:-/tmp}/walletcap-uv-cache}" \
    uv run --no-project --with pytest --python 3.12 pytest -q
else
  echo "pytest is not installed; run: python3 -m pip install pytest" >&2
  exit 1
fi

echo "== Examples =="
node examples/quickstart/quickstart.mjs >/dev/null
python3 examples/quickstart/quickstart.py >/dev/null

echo "== Solidity (Foundry) =="
if command -v forge >/dev/null 2>&1; then
  (cd solidity && forge test)
else
  echo "forge not found; skipping Foundry tests"
fi

echo "== Solidity (EVM check) =="
(cd solidity/evm && npm install --no-audit --no-fund --no-package-lock && node check.mjs ..)

echo "== Crash test =="
(cd crash-test \
  && npm install --no-audit --no-fund --no-package-lock \
  && npm install --no-save --no-audit --no-fund --no-package-lock ../js \
  && node --test)

echo "All checks passed."
