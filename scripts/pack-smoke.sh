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
# The build backend and everything it needs, pinned by hash, as publish.yml builds them.
pins=(--build-constraints packages/python/build-constraints.txt --require-hashes)
uv build --quiet "${pins[@]}" --sdist --out-dir "$work/dist" packages/python
uv build --quiet "${pins[@]}" --wheel --out-dir "$work/direct" packages/python
uv build --quiet "${pins[@]}" --wheel --out-dir "$work/from-sdist" "$work"/dist/walletcap-*.tar.gz
python3 - "$work"/dist/walletcap-*.tar.gz <<'PY'
import sys, tarfile
names = sorted(tarfile.open(sys.argv[1]).getnames())
top = names[0].split("/")[0]
allowed = ("src/walletcap/", "pyproject.toml", "hatch_build.py", "README.md", "LICENSE", "NOTICE",
           "PKG-INFO")
stray = [n for n in names if n != top and not n.removeprefix(top + "/").startswith(allowed)]
assert not stray, f"the sdist holds more than the Python package: {stray}"
# The tests stay in the repository (they need spec/vectors, spec/fixtures and the npm package),
# and hatchling's .gitignore is taken out.
assert f"{top}/tests" not in names and not any(n.startswith(f"{top}/tests/") for n in names), "the sdist holds tests/"
assert f"{top}/.gitignore" not in names, "the sdist holds .gitignore"
for spec in ("src/walletcap/spec/schema.sql", "src/walletcap/spec/upgrade.sql"):
    assert f"{top}/{spec}" in names, f"the sdist lacks {spec}"
assert not any(n.endswith((".mjs", ".ts", ".sol", ".js")) for n in names), "the sdist holds non-Python sources"
print(f"the sdist holds only the Python package: {len(names)} entries")
PY
# A wheel built from the unpacked sdist takes the rule from the sdist, whatever sits above it: pip
# unpacks a source build under the temp folder, where anyone can leave a spec/ two levels up.
mkdir -p "$work/tmp/build" "$work/tmp/spec"
tar xzf "$work"/dist/walletcap-*.tar.gz -C "$work/tmp/build"
printf -- '-- planted\n' > "$work/tmp/spec/schema.sql"
printf -- '-- planted\n' > "$work/tmp/spec/upgrade.sql"
uv build --quiet "${pins[@]}" --wheel --out-dir "$work/planted" "$work"/tmp/build/walletcap-*/
python3 - "$work"/planted/walletcap-*.whl "$root/spec" <<'PY'
import pathlib, sys, zipfile
wheel, spec = zipfile.ZipFile(sys.argv[1]), pathlib.Path(sys.argv[2])
for name in ("schema.sql", "upgrade.sql"):
    assert wheel.read(f"walletcap/spec/{name}") == (spec / name).read_bytes(), f"the wheel's {name} is not the sdist's"
print("a wheel built from the sdist ships the sdist's rule, not a spec/ planted above it")
PY
for wheel in "$work"/direct/walletcap-*.whl "$work"/from-sdist/walletcap-*.whl; do
  venv="$(mktemp -d "$work/venv.XXXX")"
  uv venv --quiet "$venv"
  uv pip install --quiet --python "$venv" "$wheel"
  (cd "$work" && "$venv/bin/python" "$root/scripts/smoke/smoke.py")
done
echo "Pack smoke passed."
