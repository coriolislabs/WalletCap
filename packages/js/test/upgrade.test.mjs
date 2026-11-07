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
import { resetClock, setClock } from '../dist/core/_clock.js';
import { Ledger } from '../dist/core/ledger.js';

const FIXTURES = new URL('../../../spec/fixtures/', import.meta.url);
const LEDGER = fileURLToPath(new URL('../dist/core/ledger.js', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'walletcap-upgrade-'));
// Windows keeps a budget file a test left open; its temp folder is cleared later.
after(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* open on Windows */ } });
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
  test(`every payment in a schema ${version} file counts as 0.3.0 counted it`, async () => {
    const expect = JSON.parse(readFileSync(new URL(`schema-${version}.expect.json`, FIXTURES), 'utf8'));
    let now = expect.T0 - 3_600_000;
    setClock(() => now);
    const path = copy(`schema-${version}.sqlite`);
    const ledger = await Ledger.open(path);
    try {
      assert.equal(schemaOf(path), '3');
      for (const probe of expect.probes) {
        now = probe.at;
        for (const [wallet, counted] of Object.entries(probe.budgets)) {
          const s = await ledger.status(wallet);
          const got = {
            cap: s.cap, window: s.window_ms, perPayment: s.per_payment, maxPayments: s.max_payments, spent: s.spent, inFlight: s.in_flight,
            remaining: s.remaining, payments: s.payments, frozen: s.frozen_at !== null, holds: (await ledger.counting(wallet, { heldOnly: true })).map(row => row.payment),
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
  // Each child opens the file, which upgrades it, and closes it. Its exit is watched from the start.
  const upgrade = path => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `const { Ledger } = await import(${JSON.stringify(LEDGER)}); (await Ledger.open(process.argv[1])).close();`, path], { stdio: 'ignore' });
    child.done = new Promise(done => child.on('exit', code => done(code)));
    return child;
  };

  const timed = copy('schema-2.sqlite');
  copyFileSync(source, timed);
  const started = Date.now();
  assert.equal(await upgrade(timed).done, 0);
  const took = Date.now() - started;

  let interrupted = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const path = join(DIR, `attempt-${attempt}.sqlite`);
    copyFileSync(source, path);
    const child = upgrade(path);
    await new Promise(done => setTimeout(done, (0.2 + 0.7 * ((attempt * 37) % 10) / 10) * took));
    child.kill('SIGKILL');
    await child.done;
    if (existsSync(`${path}-journal`)) interrupted += 1;
    // SQLite rolls a half-done upgrade back the next time the file is opened: schema 2 as it was,
    // or schema 3 with every payment, never anything between.
    (await Ledger.open(path)).close();
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

// What walletcap 0.3.0 (and 0.2.x) run when they open a file, before they read its schema and
// refuse it: their own tables, created empty if missing.
const OLD_OPEN = `
CREATE TABLE IF NOT EXISTS budget_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS budgets (instrument TEXT PRIMARY KEY, unit TEXT NOT NULL, cap INTEGER NOT NULL CHECK (cap >= 0),
  window_ms INTEGER NOT NULL CHECK (window_ms > 0), per_payment INTEGER CHECK (per_payment IS NULL OR per_payment > 0),
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses >= 0), revoked_at_ms INTEGER);
CREATE TABLE IF NOT EXISTS spend (spend_id TEXT PRIMARY KEY, instrument TEXT NOT NULL REFERENCES budgets(instrument),
  amount INTEGER NOT NULL CHECK (amount > 0), status TEXT NOT NULL CHECK (status IN ('reserved', 'committed')), rail TEXT NOT NULL,
  reference TEXT, at_ms INTEGER NOT NULL, expires_at_ms INTEGER);
CREATE INDEX IF NOT EXISTS spend_by_instrument ON spend (instrument, at_ms);
INSERT OR IGNORE INTO budget_meta VALUES ('schema', '2');
`;

test('the empty tables a 0.2 or 0.3 process leaves in a schema 3 file are dropped on open', async () => {
  const path = join(DIR, `${files++}-strays.sqlite`);
  const ledger = await Ledger.open(path, { create: true });
  await ledger.createBudget('0xd797ead28c38575fdf4fc523866287372340ca02', { cap: 10_000_000n, windowMs: 86_400_000n });
  ledger.close();
  const old = new DatabaseSync(path);
  old.exec(OLD_OPEN); // 0.3.0 then reads schema '3' and refuses the file
  old.close();
  const tables = () => {
    const db = new DatabaseSync(path);
    try { return db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name); } finally { db.close(); }
  };
  assert.deepEqual(tables().filter(name => ['budgets', 'spend'].includes(name)), ['budgets', 'spend']);
  const reopened = await Ledger.open(path);
  try {
    assert.deepEqual(tables().filter(name => ['budgets', 'spend'].includes(name)), []);
    assert.equal(schemaOf(path), '3');
    const held = await reopened.hold('0xd797ead28c38575fdf4fc523866287372340ca02', 10_000_000n, { rail: 'test' });
    assert.equal((await reopened.settle(held.payment, { holder: held.holder })).state, 'settled');
  } finally {
    reopened.close();
  }
});
