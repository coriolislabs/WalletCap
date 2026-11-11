// SPDX-License-Identifier: Apache-2.0
// What the November 2026 security review changed in the core, each with the case that got past
// 0.4.1. The Python suite runs the same cases (tests/test_hardening.py).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BudgetUnavailable, notSent, openBudget, openOwner, UsageError } from 'walletcap';
import { normalizeWallet } from '../dist/core/money.js';

const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const SPEC = new URL('../../../spec/', import.meta.url);
const DIR = mkdtempSync(join(tmpdir(), 'walletcap-hardening-'));
after(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* open on Windows */
  }
});
const WALLET = '0xd797ead28c38575fdf4fc523866287372340ca02';
const OTHER = '0x4165cb72de51a67aac32dc33197d779552205efd';
const TX = `0x${'ab'.repeat(32)}`;
const POSIX = process.platform !== 'win32';
let files = 0;
const fresh = async (limits = { perPayment: '$60', perDay: '$100' }) => {
  const path = join(DIR, `budget-${files++}.sqlite`);
  return { path, budget: await openBudget({ wallet: WALLET, path, create: true, ...limits }) };
};
const statuses = async budget => (await budget.history()).map(payment => payment.status).reverse();

test('only notSent() says a payment never left: a notSent property from data voids nothing', async () => {
  const { budget } = await fresh({ perDay: '$10' });
  // 0.4.1 read a plain `notSent: true`, which a payee's JSON error body can carry: three $10
  // payments "failed" this way against a $10 cap were all voided, and the cap never bound.
  const fromPayee = JSON.parse('{"error":"upstream said no","notSent":true}');
  await assert.rejects(
    budget.pay('$10', () => {
      throw fromPayee;
    }),
  );
  await assert.rejects(
    budget.pay('$1', () => {
      throw Object.assign(new Error('declined'), fromPayee);
    }),
    { code: 'budget' },
  );
  assert.deepEqual(await statuses(budget), ['unknown']);
  assert.equal((await budget.status()).remaining, 0n, 'it keeps counting');

  // The real tag still voids, and still reads as a property.
  const { budget: second } = await fresh();
  const tagged = notSent(new Error('card declined'));
  assert.equal(tagged.notSent, true);
  await assert.rejects(
    second.pay('$10', () => {
      throw tagged;
    }),
    /card declined/,
  );
  assert.deepEqual(await statuses(second), ['void']);
});

test('notSent speaks for one payment: a pay() around the one it leaves keeps counting', async () => {
  const { budget } = await fresh();
  // The outer function sends $60, then a helper's own $5 payment is not sent. 0.4.1 voided both,
  // and $160 went out against a $100 cap.
  let sent = 0;
  await assert.rejects(
    budget.pay('$60', async () => {
      sent += 60;
      await budget.pay('$5', () => {
        throw notSent('the helper never sent');
      });
    }),
    /the helper never sent/,
  );
  assert.equal(sent, 60);
  assert.deepEqual(await statuses(budget), ['unknown', 'void'], 'the $60 is noted unknown, the $5 void');
  assert.equal((await budget.status()).remaining, 40_000_000n);
  await assert.rejects(
    budget.pay('$60', () => TX),
    { code: 'budget' },
  );
});

test('a function that voids its hold and then pays after all is settled by its transaction', async () => {
  const { budget } = await fresh();
  const tx = await budget.pay('$10', async hold => {
    await hold.void({ evidence: 'first try never broadcast' });
    return TX; // the retry paid
  });
  assert.equal(tx, TX);
  assert.deepEqual(await statuses(budget), ['settled']);
  // With nothing to show for it, a void hold stays void.
  await budget.pay('$10', async hold => {
    await hold.void();
    return null;
  });
  assert.deepEqual(await statuses(budget), ['settled', 'void']);
});

test('a budget file removed or replaced under a running payer refuses, and never pays', {
  skip: !POSIX && 'an open file cannot be removed on Windows',
}, async () => {
  const { path, budget } = await fresh({ perDay: '$10' });
  await budget.pay('$4', () => TX);
  // Its owner starts over: rm, then walletcap set. 0.4.1's running payer kept counting in the
  // deleted file, $6 more, while a new payer had a fresh $10: $20 in one window.
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  let ran = false;
  const pay = () =>
    budget.pay('$6', () => {
      ran = true;
      return TX;
    });
  await assert.rejects(pay(), error => error instanceof BudgetUnavailable && /was removed after this process opened it/.test(error.message));
  const owner = await openOwner({ path, create: true });
  await owner.setLimits(WALLET, { perDay: '$10' });
  owner.close();
  await assert.rejects(pay(), error => error instanceof BudgetUnavailable && /was replaced after this process opened it/.test(error.message));
  await assert.rejects(budget.status(), BudgetUnavailable);
  assert.equal(ran, false);
  // Opened again, the payer counts in the file every other process sees.
  const again = await openBudget({ wallet: WALLET, path });
  await again.pay('$10', () => TX);
  await assert.rejects(
    again.pay('$1', () => TX),
    { code: 'budget' },
  );

  // A file moved into place, as a restore does, is another file too.
  const { path: live, budget: payer } = await fresh({ perDay: '$10' });
  const { path: backup } = await fresh({ perDay: '$10' });
  renameSync(backup, live);
  await assert.rejects(payer.check('$1'), /was replaced after this process opened it/);
});

test('walletcap creates a budget at the path itself, never through a link to nowhere', {
  skip: !POSIX && 'symbolic links need a privilege on Windows',
}, async () => {
  const target = join(DIR, 'elsewhere.sqlite');
  const link = join(DIR, 'linked.sqlite');
  symlinkSync(target, link);
  // 0.4.1 swallowed the failed exclusive create, and SQLite made the target, mode 0644.
  await assert.rejects(
    openBudget({ wallet: WALLET, path: link, create: true, perDay: '$10' }),
    error => error instanceof BudgetUnavailable && /symbolic link/.test(error.message),
  );
  assert.equal(statSync(target, { throwIfNoEntry: false }), undefined);
});

test('one address is one budget: the shared wallet-name vectors', () => {
  const { same, refused } = JSON.parse(readFileSync(new URL('vectors/wallets.json', SPEC), 'utf8'));
  for (const { name, spellings } of same) for (const spelling of spellings) assert.equal(normalizeWallet(spelling), name, spelling);
  for (const { input, why } of refused) assert.throws(() => normalizeWallet(input), UsageError, `${JSON.stringify(input)}: ${why}`);
});

test("another wallet's payment id is refused without describing that payment, and a new id can't look like an option", async () => {
  const { path, budget } = await fresh();
  const other = await openBudget({ wallet: OTHER, path, create: true, perDay: '$100' });
  await budget.hold('$33.33', { id: 'order-17' });
  // 0.4.1 answered "…for $33.33 from 0xd797…ca02" to any wallet's payer that guessed the id.
  await assert.rejects(other.hold('$1', { id: 'order-17' }), error => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /already in the ledger, under another wallet's budget/);
    assert.doesNotMatch(error.message, /33\.33|0xd797/);
    return true;
  });
  assert.equal(await other.payment('order-17'), null);
  await assert.rejects(budget.hold('$1', { id: 'order-17' }), /already in the ledger, for \$33\.33$/);

  for (const id of ['--all-unknown', '-h', '--json']) await assert.rejects(budget.hold('$1', { id }), /can't start with '-'/);
  assert.equal((await budget.holds()).length, 1);
});

test('the owner sees what a payer or a payee wrote as text, never as terminal controls', async () => {
  const { path, budget } = await fresh();
  // A one-cent hold whose note erases the line above it, and a "transaction" that forges a row.
  const erase = '\r\u001b[2K\u001b[1A\u001b[2K';
  await budget.hold('$45', { id: 'real-45', settlesWithin: 600_000 });
  await budget.hold('$0.01', { note: `${erase}no open payments\u001b[8m`, to: `0xabc\u202e${erase}` });
  const done = await budget.hold('$1', { settlesWithin: 600_000 });
  await done.settle({ tx: `0xabc\n2026-11-10T00:00:00Z      $0.00  void       safe to void real-45${erase}` });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--path', path], { encoding: 'utf8' }).stdout;
  for (const [command, lines] of [
    ['holds', 2],
    ['history', 3],
  ]) {
    const out = run(command);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the controls a terminal acts on
    assert.doesNotMatch(out.replaceAll('\n', ''), /[\u0000-\u001f\u007f-\u009f\u202e]/, command);
    assert.equal(out.trimEnd().split('\n').length, lines, `${command} prints one line a payment`);
    assert.match(out, /real-45/);
    assert.match(out, /\ufffd/);
  }
  // --json keeps the text as it is, escaped as JSON escapes it.
  assert.ok(JSON.parse(run('holds', '--json')).some(hold => hold.note?.includes('\u001b[2K')));
});
