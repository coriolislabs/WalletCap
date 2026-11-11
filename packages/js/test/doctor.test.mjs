// SPDX-License-Identifier: Apache-2.0
// walletcap check and walletcap doctor, through the command line. The Python suite runs the same
// cases (tests/test_doctor.py), and tests/test_cli_json.py compares the two command lines' JSON.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openBudget } from 'walletcap';
import { filesystemOf } from '../dist/cli/doctor.js';

const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const SPEC = new URL('../../../spec/', import.meta.url);
const DIR = mkdtempSync(join(tmpdir(), 'walletcap-doctor-'));
after(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* open on Windows */
  }
});
const WALLET = '0xd797ead28c38575fdf4fc523866287372340ca02';
const POSIX = process.platform !== 'win32';

const cli = (path, ...args) => {
  const result = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, WALLETCAP_PATH: path }, encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
};
const fresh = name => {
  const path = join(DIR, name);
  assert.equal(cli(path, 'set', '--wallet', WALLET, '--per-day', '150', '--per-payment', '50').code, 0);
  return path;
};
const statusOf = (report, id) => report.checks.filter(check => check.id === id).map(check => check.status);
const sql = (path, statement) => {
  const db = new DatabaseSync(path);
  try {
    return db.prepare(statement).all();
  } finally {
    db.close();
  }
};

test('check says whether a payment would be paid now, and holds nothing', () => {
  const path = fresh('check.sqlite');
  const yes = cli(path, 'check', '12.50');
  assert.equal(yes.code, 0);
  assert.match(yes.out, /^Yes: \$12\.50 from 0xd797…ca02 would be paid now\. \$150\.00 is left in its window\./);

  const no = cli(path, 'check', '60');
  assert.equal(no.code, 1, 'a payment the budget would refuse exits 1');
  assert.match(no.out, /^No: \$60\.00 is over 0xd797…ca02's \$50\.00 limit per payment/);

  const answer = cli(path, 'check', '60', '--json');
  assert.equal(answer.code, 1);
  assert.deepEqual(JSON.parse(answer.out), {
    ok: false,
    remaining: '150000000',
    code: 'per_payment',
    source: 'budget',
    message: "$60.00 is over 0xd797…ca02's $50.00 limit per payment",
    brief: "$60.00 is over 0xd797…ca02's $50.00 limit per payment",
  });
  assert.deepEqual(JSON.parse(cli(path, 'check', '5', '--json').out), {
    ok: true,
    remaining: '150000000',
    code: null,
    source: null,
    message: null,
    brief: null,
  });
  assert.equal(JSON.parse(cli(path, 'status', '--wallet', WALLET, '--json').out).payments, '0', 'a check holds nothing');

  cli(path, 'freeze');
  const frozen = cli(path, 'check', '5');
  assert.equal(frozen.code, 1);
  assert.match(frozen.out, /^No: .*frozen/);
});

test('check needs an amount, a budget file and a budget', () => {
  const path = fresh('check-usage.sqlite');
  const bare = cli(path, 'check');
  assert.equal(bare.code, 2);
  assert.match(bare.err, /check needs an amount in dollars/);
  const words = cli(path, 'check', 'lots');
  assert.equal(words.code, 1);
  assert.match(words.err, /must be dollars/);
  const missing = cli(join(DIR, 'no-such.sqlite'), 'check', '5', '--wallet', WALLET);
  assert.equal(missing.code, 1, 'a missing file is not a new budget');
  assert.match(missing.err, /no budget file at/);
  assert.equal(statSync(join(DIR, 'no-such.sqlite'), { throwIfNoEntry: false }), undefined, 'check never creates the file');
});

test('doctor passes a budget walletcap set created, and says so in JSON', () => {
  const path = fresh('healthy.sqlite');
  const text = cli(path, 'doctor');
  assert.equal(text.code, 0, text.out);
  assert.match(text.out, /Everything checks out\.$/m);
  const report = JSON.parse(cli(path, 'doctor', '--json').out);
  assert.equal(report.ok, true);
  assert.equal(report.path, path);
  assert.match(report.sqlite_version, /^3\.\d+\.\d+/);
  const ids = report.checks.map(check => check.id);
  assert.deepEqual(
    ids,
    POSIX
      ? ['file', 'file_mode', 'folder_mode', 'file_owner', 'filesystem', 'sqlite', 'schema', 'integrity', 'journal', 'rules', 'projection', 'budgets']
      : ['file', 'filesystem', 'sqlite', 'schema', 'integrity', 'journal', 'rules', 'projection', 'budgets'],
  );
  for (const check of report.checks) {
    assert.deepEqual(Object.keys(check), ['id', 'status', 'message', 'wallet']);
    assert.ok(
      check.status === 'ok' || (check.id === 'filesystem' && process.platform !== 'linux' && check.status === 'skipped'),
      `${check.id}: ${check.message}`,
    );
  }
});

test('doctor fails a file whose guard trigger was dropped: the rule no longer binds every writer', () => {
  const path = fresh('tampered.sqlite');
  sql(path, 'DROP TRIGGER wc_entry_admitted');
  const result = cli(path, 'doctor', '--json');
  assert.equal(result.code, 1);
  const report = JSON.parse(result.out);
  assert.equal(report.ok, false);
  assert.deepEqual(statusOf(report, 'rules'), ['fail']);
  assert.match(report.checks.find(check => check.id === 'rules').message, /wc_entry_admitted is missing or changed/);
  assert.match(cli(path, 'doctor').out, /FAIL {2}rules/);

  // A trigger put back with another body is caught too.
  const edited = fresh('edited.sqlite');
  sql(edited, 'DROP TRIGGER wc_entry_never_deleted');
  sql(edited, 'CREATE TRIGGER wc_entry_never_deleted BEFORE DELETE ON wc_entry WHEN 0 BEGIN SELECT 1; END');
  assert.match(
    JSON.parse(cli(edited, 'doctor', '--json').out).checks.find(check => check.id === 'rules').message,
    /wc_entry_never_deleted is missing or changed/,
  );
});

test('doctor reads only: it leaves an older file at its schema, and a missing one missing', () => {
  const old = join(DIR, 'schema-2.sqlite');
  copyFileSync(new URL('fixtures/schema-2.sqlite', SPEC), old);
  const before = readFileSync(old);
  const result = cli(old, 'doctor', '--json');
  assert.equal(result.code, 0, 'an older file is a warning: walletcap upgrades it when it opens it');
  const report = JSON.parse(result.out);
  assert.deepEqual(statusOf(report, 'schema'), ['warn']);
  assert.match(report.checks.at(-1).message, /schema 2, which an older walletcap wrote/);
  assert.deepEqual(readFileSync(old), before, 'the file is byte for byte what it was');
  assert.deepEqual(
    sql(old, "SELECT value FROM budget_meta WHERE key = 'schema'").map(row => row.value),
    ['2'],
  );

  const missing = join(DIR, 'missing', 'budget.sqlite');
  const none = cli(missing, 'doctor', '--json');
  assert.equal(none.code, 1);
  assert.deepEqual(
    JSON.parse(none.out).checks.map(check => [check.id, check.status]),
    [['file', 'fail']],
  );
  assert.equal(statSync(missing, { throwIfNoEntry: false }), undefined);

  // Once upgraded, the file's rule is the one walletcap ships.
  assert.equal(cli(old, 'status').code, 0);
  const upgraded = JSON.parse(cli(old, 'doctor', '--json').out);
  assert.deepEqual(statusOf(upgraded, 'rules'), ['ok']);
  assert.ok(statusOf(upgraded, 'frozen').length > 0, 'a frozen budget is a warning, by wallet');
  assert.ok(upgraded.checks.filter(check => check.id === 'open_holds').every(check => check.wallet !== null && /with no settle-by time/.test(check.message)));
});

test('doctor warns about a file other users can read, and fails one they can write', { skip: !POSIX }, () => {
  const path = fresh('modes.sqlite');
  chmodSync(path, 0o644);
  const readable = JSON.parse(cli(path, 'doctor', '--json').out);
  assert.deepEqual(statusOf(readable, 'file_mode'), ['warn']);
  assert.equal(readable.ok, true);
  chmodSync(path, 0o666);
  const writable = cli(path, 'doctor', '--json');
  assert.equal(writable.code, 1);
  assert.deepEqual(statusOf(JSON.parse(writable.out), 'file_mode'), ['fail']);
});

test('doctor names a wallet with no budget, an open hold, and a file that is not a budget', async () => {
  const path = fresh('wallets.sqlite');
  const other = '0x4165cb72de51a67aac32dc33197d779552205efd';
  const absent = cli(path, 'doctor', '--wallet', other, '--json');
  assert.equal(absent.code, 1);
  assert.deepEqual(statusOf(JSON.parse(absent.out), 'budgets'), ['fail']);

  const budget = await openBudget({ wallet: WALLET, path });
  await budget.hold('$5'); // no settle-by time: it counts until voided or settled
  budget.close();
  const open = JSON.parse(cli(path, 'doctor', '--wallet', WALLET, '--json').out).checks.find(check => check.id === 'open_holds');
  assert.equal(open.status, 'warn');
  assert.equal(open.wallet, WALLET);
  assert.match(open.message, /has 1 held payment with no settle-by time: it counts until voided or settled/);

  const stranger = join(DIR, 'stranger.sqlite');
  sql(stranger, 'CREATE TABLE notes (body TEXT)');
  const not = cli(stranger, 'doctor', '--json');
  assert.equal(not.code, 1);
  assert.match(JSON.parse(not.out).checks.at(-1).message, /not a walletcap budget/);
});

test("doctor's filesystem check reads /proc/self/mountinfo as the shared vectors say", () => {
  const { mountinfo, cases } = JSON.parse(readFileSync(new URL('vectors/mounts.json', SPEC), 'utf8'));
  for (const { path, type } of cases) assert.equal(filesystemOf(mountinfo.join('\n'), path), type, path);
  assert.equal(filesystemOf('', '/anywhere'), null);
});

test("doctor fails a file whose payment was un-counted behind the ledger's back", async () => {
  const path = fresh('replaced.sqlite');
  const budget = await openBudget({ wallet: WALLET, path });
  await budget.pay('$6', () => `0x${'ab'.repeat(32)}`);
  budget.close();
  assert.equal(JSON.parse(cli(path, 'status', '--wallet', WALLET, '--json').out).spent, '6000000');
  // INSERT OR REPLACE deletes the row it replaces without firing the triggers that refuse a
  // DELETE, so a settled payment can be put back as void with no entry saying so.
  sql(
    path,
    'INSERT OR REPLACE INTO wc_current (payment, wallet, amount, state, held_seq, held_at, until, outcome, counts_from, seq) ' +
      "SELECT payment, wallet, amount, 'void', held_seq, held_at, until, outcome, NULL, held_seq FROM wc_current",
  );
  assert.equal(JSON.parse(cli(path, 'status', '--wallet', WALLET, '--json').out).spent, '0', 'the payment no longer counts');
  const result = cli(path, 'doctor', '--json');
  assert.equal(result.code, 1);
  const report = JSON.parse(result.out);
  assert.deepEqual(statusOf(report, 'projection'), ['fail']);
  assert.match(report.checks.at(-1).message, /1 payment has a state the ledger's entries don't give it/);
});
