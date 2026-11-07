// SPDX-License-Identifier: Apache-2.0
// Opening a file walletcap 0.2 or 0.3 wrote: the upgrade to schema 3 keeps every payment
// counting. spec/fixtures holds files 0.2.4 and 0.3.0 wrote, and what 0.3.0 counted in them at a
// series of times. The Python suite checks the same files (tests/test_upgrade.py).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { after, afterEach, test } from 'node:test';
import { resetClock, setClock } from '../_clock.mjs';
import { Ledger } from '../ledger.mjs';

const FIXTURES = new URL('../../spec/fixtures/', import.meta.url);
const LEDGER = fileURLToPath(new URL('../ledger.mjs', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'walletcap-upgrade-'));
after(() => rmSync(DIR, { recursive: true, force: true }));
afterEach(resetClock);
let files = 0;

const copy = name => {
  const path = join(DIR, `${files++}-${name}`);
  copyFileSync(new URL(name, FIXTURES), path);
  return path;
};
const schemaOf = path => {
  const db = new DatabaseSync(path);
  try { return db.prepare("SELECT value FROM budget_meta WHERE key = 'schema'").get().value; } finally { db.close(); }
};

for (const version of ['1', '2']) {
  test(`every payment in a schema ${version} file counts as 0.3.0 counted it`, () => {
    const expect = JSON.parse(readFileSync(new URL(`schema-${version}.expect.json`, FIXTURES), 'utf8'));
    let now = expect.T0 - 3_600_000;
    setClock(() => now);
    const path = copy(`schema-${version}.sqlite`);
    const ledger = new Ledger(path);
    try {
      assert.equal(schemaOf(path), '3');
      for (const probe of expect.probes) {
        now = probe.at;
        for (const [wallet, counted] of Object.entries(probe.budgets)) {
          const s = ledger.status(wallet);
          const got = {
            cap: s.cap, window: s.window_ms, perPayment: s.per_payment, maxPayments: s.max_payments, spent: s.spent, inFlight: s.in_flight,
            remaining: s.remaining, payments: s.payments, frozen: s.frozen_at !== null, holds: ledger.counting(wallet, { heldOnly: true }).map(row => row.payment),
          };
          const want = Object.fromEntries(Object.entries(counted).map(([key, value]) => [key, typeof value === 'number' ? BigInt(value) : value]));
          assert.deepEqual(got, want, `${wallet} at T0${probe.at >= expect.T0 ? '+' : ''}${probe.at - expect.T0}`);
        }
      }
    } finally {
      ledger.close();
    }
  });
}

test('a crash in the middle of the upgrade leaves the file as it was', { skip: process.platform === 'win32' && 'needs SIGKILL' }, async () => {
  // The schema 2 fixture with 120,000 more payments, so the upgrade takes long enough to kill.
  const source = copy('schema-2.sqlite');
  const db = new DatabaseSync(source);
  db.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120000) INSERT INTO spend SELECT 'bulk-' || i, "
    + "'0x0773a0a3ec5f88162ea52470b7973b2cfaaa846a', 1, CASE WHEN i % 3 = 0 THEN 'reserved' ELSE 'committed' END, 'js', NULL, 1700000000000 + i, NULL FROM n").run();
  const { payments } = db.prepare('SELECT count(*) AS payments FROM spend').get();
  db.close();
  const upgrade = path => spawn(process.execPath, ['--input-type=module', '-e', `const { Ledger } = await import(${JSON.stringify(LEDGER)}); new Ledger(process.argv[1]).close();`, path], { stdio: 'ignore' });
  const exited = child => new Promise(done => child.on('exit', code => done(code)));

  const timed = copy('schema-2.sqlite');
  copyFileSync(source, timed);
  const started = Date.now();
  assert.equal(await exited(upgrade(timed)), 0);
  const took = Date.now() - started;

  let interrupted = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const path = join(DIR, `attempt-${attempt}.sqlite`);
    copyFileSync(source, path);
    const child = upgrade(path);
    await new Promise(done => setTimeout(done, (0.2 + 0.7 * ((attempt * 37) % 10) / 10) * took));
    child.kill('SIGKILL');
    await exited(child);
    if (existsSync(`${path}-journal`)) interrupted += 1;
    // SQLite rolls a half-done upgrade back the next time the file is opened: schema 2 as it was,
    // or schema 3 with every payment, never anything between.
    new Ledger(path).close();
    const after = new DatabaseSync(path);
    try {
      assert.equal(after.prepare("SELECT value FROM budget_meta WHERE key = 'schema'").get().value, '3');
      assert.equal(after.prepare("SELECT count(*) AS held FROM wc_entry WHERE kind = 'held'").get().held, payments);
      assert.equal(after.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally {
      after.close();
    }
  }
  assert.ok(interrupted > 0, 'no kill landed inside the upgrade; the file upgrades too fast to test');
});
