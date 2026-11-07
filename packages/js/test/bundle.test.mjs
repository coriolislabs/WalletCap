// SPDX-License-Identifier: Apache-2.0
// A bundler carries walletcap along: the ledger's SQL is compiled into the package, so an app
// bundled with esbuild and run from another folder opens a budget, pays and refuses, with no
// walletcap file beside it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { build } from 'esbuild';

const JS = fileURLToPath(new URL('..', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'walletcap-bundle-'));
// Windows keeps a budget file a test left open; its temp folder is cleared later.
after(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* open on Windows */
  }
});

const APP = `
import { openBudget } from 'walletcap';
const budget = await openBudget({ wallet: '0xd797ead28c38575fdf4fc523866287372340ca02', path: process.argv[2], perDay: '$2', create: true });
const results = [];
for (const amount of ['$1.50', '$1.00']) {
  try { await budget.pay(amount, async () => 'paid'); results.push('paid'); } catch (error) { results.push(error.code); }
}
console.log(JSON.stringify({ results, spent: String((await budget.status()).spent) }));
budget.close();
`;

test('an esbuild bundle of an app that uses walletcap runs from another folder', async () => {
  const source = join(DIR, 'src');
  mkdirSync(join(source, 'node_modules'), { recursive: true });
  symlinkSync(JS, join(source, 'node_modules', 'walletcap'), 'junction');
  writeFileSync(join(source, 'app.mjs'), APP);
  const bundled = join(DIR, 'out', 'app.mjs');
  await build({
    entryPoints: [join(source, 'app.mjs')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundled,
    logLevel: 'silent',
  });
  const text = readFileSync(bundled, 'utf8');
  assert.match(text, /CREATE TABLE wc_entry/, "the ledger's schema is in the bundle");
  assert.doesNotMatch(text, /new URL\([^)]*spec\//, 'nothing in the bundle looks for the spec beside it');
  assert.doesNotMatch(text, /readFileSync\([^)]*\.sql/, 'nothing in the bundle reads a .sql file');

  const elsewhere = join(DIR, 'elsewhere');
  mkdirSync(elsewhere);
  copyFileSync(bundled, join(elsewhere, 'app.mjs'));
  const run = spawnSync(process.execPath, [join(elsewhere, 'app.mjs'), join(DIR, 'budget.sqlite')], { cwd: elsewhere, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { results: ['paid', 'budget'], spent: '1500000' });
});
