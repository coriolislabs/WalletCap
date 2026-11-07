#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Pack what would be published and use it as a user would: the two npm tarballs installed in an
# empty project, and the Python wheel, plus a wheel built from the sdist, each in a fresh virtual
# environment. The sdist must hold only the Python package. Needs node, npm and uv.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "== npm: walletcap and walletcap-mcp from their tarballs =="
npm pack --silent -w walletcap -w walletcap-mcp --pack-destination "$work" >/dev/null
mkdir "$work/project"
cp scripts/smoke/smoke.mjs "$work/project/"
(
  cd "$work/project"
  printf '{ "name": "smoke", "private": true, "type": "module" }\n' > package.json
  npm install --no-audit --no-fund --no-package-lock "$work"/walletcap-0*.tgz "$work"/walletcap-mcp-*.tgz >/dev/null
  node smoke.mjs
  test "$(npx --no-install walletcap --version)" = "$(node -p "require('$root/packages/js/package.json').version")"
  npx --no-install walletcap-mcp --help >/dev/null
  echo "npx walletcap --version and npx walletcap-mcp --help run"
)

echo "== PyPI: the sdist, and wheels from the source and from the sdist =="
uv build --quiet --sdist --out-dir "$work/dist" packages/python
uv build --quiet --wheel --out-dir "$work/direct" packages/python
uv build --quiet --wheel --out-dir "$work/from-sdist" "$work"/dist/walletcap-*.tar.gz
python3 - "$work"/dist/walletcap-*.tar.gz <<'PY'
import sys, tarfile
names = sorted(tarfile.open(sys.argv[1]).getnames())
top = names[0].split("/")[0]
allowed = ("src/walletcap/", "tests/", "pyproject.toml", "hatch_build.py", "pytest.ini", "README.md",
           "LICENSE", "NOTICE", "PKG-INFO", ".gitignore")
stray = [n for n in names if n != top and not n.removeprefix(top + "/").startswith(allowed)]
assert not stray, f"the sdist holds more than the Python package: {stray}"
for spec in ("src/walletcap/spec/schema.sql", "src/walletcap/spec/upgrade.sql"):
    assert f"{top}/{spec}" in names, f"the sdist lacks {spec}"
assert not any(n.endswith((".mjs", ".ts", ".sol", ".js")) for n in names), "the sdist holds non-Python sources"
print(f"the sdist holds only the Python package: {len(names)} entries")
PY
for wheel in "$work"/direct/walletcap-*.whl "$work"/from-sdist/walletcap-*.whl; do
  venv="$(mktemp -d "$work/venv.XXXX")"
  uv venv --quiet "$venv"
  uv pip install --quiet --python "$venv" "$wheel"
  (cd "$work" && "$venv/bin/python" "$root/scripts/smoke/smoke.py")
done
echo "Pack smoke passed."
