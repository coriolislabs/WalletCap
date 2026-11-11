#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# The quick gate: lint, types and both test suites, in two or three minutes on a laptop.
# scripts/ci.sh is the whole gate (it adds the quickstarts, the contracts, the packed packages, the
# kill -9 race, the Quint model and the crash test), and hosted CI runs that on every platform.
#
#   bash scripts/check.sh            everything below
#   bash scripts/check.sh lint       the workflows' rules, Biome, tsc, ruff, mypy
#   bash scripts/check.sh js         walletcap and walletcap-mcp
#   bash scripts/check.sh python     the Python package
#   bash scripts/check.sh js -- test/x402.test.mjs     one JavaScript test file
#   bash scripts/check.sh python -- -k doctor          pytest's own arguments
#
# Needs node 22.13+, npm and uv.
set -euo pipefail
cd "$(dirname "$0")/.."

parts=()
extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    lint | js | python) parts+=("$1") ;;
    --)
      shift
      extra=("$@")
      break
      ;;
    -h | --help)
      sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      # npm run check js -- <args> reaches here without the --: npm takes it.
      extra=("$@")
      break
      ;;
  esac
  shift
done
[ ${#parts[@]} -gt 0 ] || parts=(lint js python)
if [ ${#extra[@]} -gt 0 ] && { [ ${#parts[@]} -ne 1 ] || [ "${parts[0]}" = lint ]; }; then
  echo "usage: check.sh [lint] [js] [python], or one of js and python with its own arguments after --" >&2
  exit 2
fi

step() { printf '\n== %s ==\n' "$1"; }
has() { case " ${parts[*]} " in *" $1 "*) return 0 ;; *) return 1 ;; esac }
started=$(date +%s)

if [ ! -d node_modules ]; then
  step "Install the workspace from the lockfile"
  npm ci --no-audit --no-fund
fi

# Both suites run the built package: the Python one drives the npm CLI beside its own.
step "Build walletcap and walletcap-mcp (tsc, strict)"
npm run build --silent

if has lint; then
  step "Lint: the workflows' rules, Biome, ruff, mypy --strict"
  node scripts/check-workflows.mjs
  npx biome check --error-on-warnings
  (cd packages/python && uv run --locked ruff check && uv run --locked ruff format --check && uv run --locked mypy)
fi

if has js; then
  if [ ${#extra[@]} -gt 0 ]; then
    step "walletcap: ${extra[*]}"
    (cd packages/js && node --test --test-concurrency=2 "${extra[@]}")
  else
    step "walletcap"
    (cd packages/js && node --test --test-concurrency=2 "test/*.test.mjs")
    step "walletcap-mcp"
    (cd packages/mcp && node --test "test/*.test.mjs")
  fi
fi

if has python; then
  step "Python"
  (cd packages/python && uv run --locked pytest -q ${extra[@]+"${extra[@]}"})
fi

printf '\nChecked %s in %ss. scripts/ci.sh runs the whole gate.\n' "${parts[*]}" "$(($(date +%s) - started))"
