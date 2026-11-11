<!-- SPDX-License-Identifier: Apache-2.0 -->
# Releasing

`.github/workflows/publish.yml` publishes from a tag on `main`. No registry token is stored: PyPI
and npm trust the workflow through OIDC (trusted publishing). The workflow builds, tests and packs
in jobs that can't publish, and four short jobs publish what was packed:

| Tag | Publishes | From |
|---|---|---|
| `v<version>` | `walletcap` to PyPI and npm | `packages/python`, `packages/js` |
| `mcp-v<version>` | `walletcap-mcp` to npm | `packages/mcp` |
| `crash-test-v<version>` | `walletcap-crash-test` to npm | `bench/crash-test` |

The first job resolves the tag to a commit: it must be the commit the run started from, be on
`main` and carry the package's version, or the run stops before anything is built. Every build
job checks out that commit, not the tag's name. Each packs and uploads its artifact before it runs
a test, and the wheel's build backend is pinned by hash in `packages/python/build-constraints.txt`
(regenerate it with `uv pip compile --universal --generate-hashes` when hatchling moves).
`scripts/check-workflows.mjs`, in CI's lint job, fails a change that drops any of this.

## Once, before the first release

- **GitHub environments.** `pypi` and `npm` exist under Settings → Environments. Give each a
  required reviewer and a deployment rule that allows only the tags above (`v*`, `mcp-v*`,
  `crash-test-v*`). The registries trust the repository, the workflow's file name and the
  environment's name, not the ref: until the environments have these rules, a branch whose own
  `publish.yml` names the environment can publish. As an admin:

  ```console
  $ for env in npm pypi; do
      gh api -X PUT repos/coriolislabs/WalletCap/environments/$env --input - <<'JSON'
  {"reviewers": [{"type": "User", "id": 95724717}],
   "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
  JSON
      for tag in 'v*' 'mcp-v*' 'crash-test-v*'; do
        gh api -X POST repos/coriolislabs/WalletCap/environments/$env/deployment-branch-policies -f name="$tag" -f type=tag
      done
    done
  ```

- **Rulesets.** Under Settings → Rules: on `main`, require a pull request and CI, and block force
  pushes and deletion; on the tags `v*`, `mcp-v*` and `crash-test-v*`, block updates and deletion
  and restrict who creates them. Turn on immutable releases.
- **Names.** Every npm name the docs tell a user to run must be ours before the docs say so:
  `npm view <name>` answers with this repository. `walletcap-mcp` needs its placeholder (below).
- **PyPI.** The `walletcap` project has a trusted publisher: owner `coriolislabs`, repository
  `WalletCap`, workflow `publish.yml`, environment `pypi`.
- **npm.** `walletcap` and `walletcap-crash-test` each have a trusted publisher: organization or
  user `coriolislabs`, repository `WalletCap`, workflow `publish.yml`, environment `npm`.

## A walletcap release

1. Set the version in `packages/js/package.json` and `packages/python/pyproject.toml` (the same
   number), and move the CHANGELOG's unreleased section under it.
2. Merge to `main` with CI green.
3. Tag the merge commit `v<version>` and publish a GitHub Release from the tag. The workflow
   runs both suites, packs the npm tarball, the wheel and the sdist, then publishes them.

To run it again for an existing tag (a failed publish, say): Actions → Publish → Run workflow,
pick the tag under "Use workflow from", and give the same tag. The environments allow only the
release tags, so a run from `main` or another branch stops before anything is built.

## The first release of walletcap-mcp

npm can't attach a trusted publisher to a package that doesn't exist yet. Claim the name with a
placeholder first, so the real first release goes through the workflow with provenance like
every other:

1. From a machine logged in to npm as an owner of the `coriolislabs` packages, with two-factor
   authentication, publish a placeholder that does nothing:

   ```console
   $ mkdir walletcap-mcp-placeholder && cd walletcap-mcp-placeholder
   $ npm init -y >/dev/null
   $ npm pkg set name=walletcap-mcp version=0.0.0 description="Name reserved for the walletcap MCP proxy; use 0.5.0 or later." license=Apache-2.0
   $ npm publish --access public
   ```

2. On npmjs.com, add the trusted publisher for `walletcap-mcp`: repository
   `coriolislabs/WalletCap`, workflow `publish.yml`, environment `npm`.
3. Wait until `walletcap` 0.5.0 is on npm: `walletcap-mcp` depends on `walletcap ^0.5.0`.
4. Tag `mcp-v0.5.0` on `main` and publish a GitHub Release from it. The workflow tests and packs
   `packages/mcp` and publishes it with provenance.
5. Deprecate the placeholder: `npm deprecate walletcap-mcp@0.0.0 "Placeholder; use 0.5.0 or later."`

## The MCP Registry

`.github/workflows/mcp-registry.yml`, run by hand, publishes `packages/mcp/server.json` once the
npm version it names is out. The registry checks that the npm package carries the same
`mcpName`.
