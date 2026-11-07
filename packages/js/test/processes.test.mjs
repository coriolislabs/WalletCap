// SPDX-License-Identifier: Apache-2.0
// Separate processes stand in for a restart and for replicas: the budget lives in
// the file, so neither starts the count again.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openBudget } from 'walletcap';
import { race, run } from './support/race.mjs';
import { x402 } from './support/x402-kit.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'walletcap-processes-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

const WALLET = '0xd797ead28c38575fdf4fc523866287372340ca02';
const LIMITS = { perPayment: '$50', perDay: '$150' };
const count = (results, outcome) => results.flatMap(result => result.results).filter(entry => entry === outcome).length;

test('a restarted agent finds the count where it left it, even with looser limits in its code', async () => {
  const path = join(DIR, 'restart.sqlite');
  (await openBudget({ wallet: WALLET, path, ...LIMITS, create: true })).close();
  const first = await run('payer.mjs', { wallet: WALLET, path, limits: LIMITS, payments: ['$50', '$50', '$50'] });
  assert.deepEqual(first.results, ['paid', 'paid', 'paid']);
  const restarted = await run('payer.mjs', { wallet: WALLET, path, limits: { perPayment: '$100', perDay: '$5000' }, payments: ['$50', '$2'] });
  assert.deepEqual(restarted.results, ['budget', 'budget']);
  assert.equal(restarted.warnings.length, 1);
  assert.equal(restarted.spent, '150000000');
});

test('replicas racing for the last of the budget cannot both win', async () => {
  const path = join(DIR, 'race.sqlite');
  (await openBudget({ wallet: WALLET, path, ...LIMITS, create: true })).close();
  // Four replicas, three $50 payments each, against $150: exactly three may win.
  const results = await race('payer.mjs', DIR, Array.from({ length: 4 }, () => ({ wallet: WALLET, path, limits: LIMITS, payments: ['$50', '$50', '$50'] })));
  assert.equal(count(results, 'paid'), 3);
  assert.equal(count(results, 'budget'), 9);
  assert.equal((await (await openBudget({ wallet: WALLET, path })).status()).spent, 150_000_000n);
});

test('x402 replicas racing with guarded clients cannot pass the shared cap', async t => {
  const kit = await x402();
  if (kit === null) return t.skip('the x402 devDependencies are not installed');
  const path = join(DIR, 'x402-race.sqlite');
  (await openBudget({ wallet: kit.account.address, path, ...LIMITS, create: true })).close();
  const results = await race('x402-payer.mjs', DIR, Array.from({ length: 3 }, () => ({ path, limits: LIMITS, payments: [50_000_000, 50_000_000, 50_000_000] })));
  assert.equal(count(results, 'paid'), 3);
  assert.equal((await (await openBudget({ wallet: kit.account.address, path })).status()).spent, 150_000_000n);
  return undefined;
});

test("the ledger reads the time once it holds the write lock, so waiting for another process can't make it stale", async () => {
  const path = join(DIR, 'lock.sqlite');
  const budget = await openBudget({ wallet: WALLET, path, ...LIMITS, create: true });
  // Another process takes the write lock and holds it for 400 ms.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', [
    "import { DatabaseSync } from 'node:sqlite';",
    'const db = new DatabaseSync(process.argv[1]);',
    "db.exec('BEGIN IMMEDIATE');",
    "process.stdout.write('locked\\n');",
    "setTimeout(() => { db.exec('COMMIT'); db.close(); }, 400);",
  ].join(' '), path], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise(resolve => holder.on('exit', resolve));
  await new Promise(resolve => holder.stdout.once('data', resolve));
  const asked = Date.now();
  const held = await budget.reserve('$1');
  const [row] = await budget.history();
  assert.equal(row.id, held.id);
  // 0.3.0 read the time before it waited for the lock, so the payment was dated, and stopped
  // counting, as much as the wait earlier than it was taken.
  assert.ok(row.at.getTime() - asked >= 250, `dated ${row.at.getTime() - asked} ms after it was asked for`);
  await exited;
  budget.close();
});

test("a wait for another process's write lock never blocks the event loop", async () => {
  const path = join(DIR, 'event-loop.sqlite');
  const budget = await openBudget({ wallet: WALLET, path, ...LIMITS, create: true });
  // Another process takes the write lock and holds it for about 500 ms.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', [
    "import { DatabaseSync } from 'node:sqlite';",
    'const db = new DatabaseSync(process.argv[1]);',
    "db.exec('BEGIN IMMEDIATE');",
    "process.stdout.write('locked\\n');",
    "setTimeout(() => { db.exec('COMMIT'); db.close(); }, 500);",
  ].join(' '), path], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise(resolve => holder.on('exit', resolve));
  await new Promise(resolve => holder.stdout.once('data', resolve));
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 10);
  try {
    await budget.pay('$1', async () => 'paid');
  } finally {
    clearInterval(ticker);
  }
  // 0.3.0 waited inside SQLite on this thread, so no timer ran until the lock came free.
  assert.ok(ticks >= 20, `the event loop ran ${ticks} ticks while the payment waited`);
  assert.equal((await budget.status()).spent, 1_000_000n);
  await exited;
  budget.close();
});
