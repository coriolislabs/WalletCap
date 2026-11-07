#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// JavaScript and Python payers race on one budget file while this kills them with SIGKILL, at
// random, over and over, and starts new ones; then check.mjs reads the file back and checks the
// ledger's invariants. Needs packages/js built and python3 on PATH.
//   node scripts/race/race.mjs [--seconds 45] [--workers 3] [--python python3]
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { check } from './check.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({
  options: { seconds: { type: 'string', default: '45' }, workers: { type: 'string', default: '3' }, python: { type: 'string', default: 'python3' } },
});
const seconds = Number(values.seconds);
const perLanguage = Number(values.workers);
const WALLET = '0xd797ead28c38575fdf4fc523866287372340ca02';
const { openOwner } = await import(join(ROOT, 'packages/js/dist/index.js'));

// The Python payers run from the source tree, which needs the spec copy a wheel carries.
const copies = join(ROOT, 'packages/python/src/walletcap/spec');
mkdirSync(copies, { recursive: true });
for (const name of ['schema.sql', 'upgrade.sql']) copyFileSync(join(ROOT, 'spec', name), join(copies, name));

const dir = mkdtempSync(join(tmpdir(), 'walletcap-race-'));
const path = join(dir, 'budget.sqlite');
const owner = await openOwner({ path, create: true });
await owner.setLimits(WALLET, { cap: '$40', window: '2s', perPayment: '$5', maxPayments: 12 });
owner.close();

const failures = [];
const live = new Set();
let kills = 0;
let started = 0;
const start = language => {
  const child = language === 'js'
    ? spawn(process.execPath, [join(ROOT, 'scripts/race/worker.mjs'), path, WALLET], { stdio: ['ignore', 'ignore', 'pipe'] })
    : spawn(values.python, [join(ROOT, 'scripts/race/worker.py'), path, WALLET], {
      stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PYTHONPATH: join(ROOT, 'packages/python/src') },
    });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('exit', (code, signal) => {
    live.delete(child);
    if (signal !== 'SIGKILL') failures.push({ language, code, signal, stderr: stderr.slice(-2000) });
  });
  child.language = language;
  live.add(child);
  started += 1;
};
for (let i = 0; i < perLanguage; i += 1) {
  start('js');
  start('python');
}

const until = Date.now() + seconds * 1000;
while (Date.now() < until && failures.length === 0) {
  await new Promise(done => setTimeout(done, 100 + Math.random() * 400));
  const children = [...live];
  const victim = children[Math.floor(Math.random() * children.length)];
  if (victim === undefined) continue;
  victim.kill('SIGKILL');
  kills += 1;
  start(victim.language);
}
const ended = [...live].map(child => new Promise(done => child.once('exit', done)));
for (const child of live) child.kill('SIGKILL');
await Promise.all(ended);

const result = check(path);
const ok = failures.length === 0 && result.integrity === 'ok' && result.replayed && result.violations.length === 0;
process.stdout.write(`${JSON.stringify({ seconds, workers: started, kills, failures, ...result, violations: result.violations.slice(0, 20) }, null, 2)}\n`);
if (ok) rmSync(dir, { recursive: true, force: true });
else process.stderr.write(`the race failed; the budget file is kept at ${path}\n`);
process.exitCode = ok ? 0 : 1;
