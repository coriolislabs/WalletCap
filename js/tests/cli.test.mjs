// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, test } from 'node:test';
import { resetClock, setClock } from '../_clock.mjs';
import { guardAgenticWallet } from '../agentic.mjs';
import { openBudget } from '../index.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'walletcap-cli-'));
after(() => rmSync(DIR, { recursive: true, force: true }));
afterEach(resetClock);
const WALLET = '0xd797ead28c38575fdf4fc523866287372340ca02';

const cli = (path, ...args) => {
  const result = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, WALLETCAP_PATH: path }, encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
};

test('an owner sets, reads, freezes and unfreezes a budget from the command line', async () => {
  const path = join(DIR, 'owner.sqlite');
  assert.match(cli(path).out, /No budget in .* yet/);
  const set = cli(path, 'set', '--wallet', '0xd797ead28C38575FDf4fC523866287372340Ca02', '--per-day', '150', '--per-payment', '50');
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /\$150\.00 per 24h, at most \$50\.00 a payment/);

  const budget = openBudget({ wallet: WALLET, path });
  await budget.pay('$40', async () => `0x${'ab'.repeat(32)}`, { to: '0x4165cb72De51A67aac32DC33197d779552205efD' });

  // Raising the limit keeps what was spent.
  const raised = cli(path, 'set', '--per-day', '300');
  assert.match(raised.out, /\$40\.00 spent, \$0\.00 in flight, \$260\.00 left/);
  assert.match(cli(path, 'status', '--wallet', WALLET).out, /Left {9}\$260\.00/);
  assert.match(cli(path, 'history').out, /\$40\.00\s+settled\s+js\s+to 0x4165…5efd\s+tx 0xabab/);

  assert.equal(cli(path, 'freeze').code, 0);
  await assert.rejects(budget.pay('$1', async () => 'x'), { reason: 'revoked' });
  const frozen = JSON.parse(cli(path, 'status', '--json').out);
  assert.equal(frozen.budgets[0].frozen, true);
  assert.equal(frozen.budgets[0].spent, '40000000');
  assert.equal(cli(path, 'unfreeze').code, 0);
  await budget.pay('$1', async () => 'x');
});

test('set creates the budget file and its folder on a fresh machine', () => {
  const path = join(DIR, 'fresh', 'state', 'walletcap', 'budget.sqlite');
  const created = cli(path, 'set', '--wallet', WALLET, '--per-day', '25');
  assert.equal(created.code, 0, created.err);
  assert.equal(openBudget({ wallet: WALLET, path, create: false }).status().cap, 25_000_000n);
});

test('release gives back only an in-flight payment', () => {
  const path = join(DIR, 'release.sqlite');
  const budget = openBudget({ wallet: WALLET, path, perDay: '$10', create: true });
  const held = budget.reserve('$4');
  assert.match(cli(path, 'history').out, new RegExp(`in flight .*\\(${held.id}\\)`));
  const released = cli(path, 'release', held.id);
  assert.equal(released.code, 0, released.err);
  assert.equal(budget.status().inFlight, 0n);
  const settled = budget.reserve('$1');
  settled.commit();
  const refused = cli(path, 'release', settled.id);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /recorded as settled/);
});

test('an owner can release a payment whose outcome is unknown, once the chain shows it never left', async () => {
  const path = join(DIR, 'unknown.sqlite');
  const budget = openBudget({ wallet: WALLET, path, perDay: '$10', create: true });
  await assert.rejects(budget.pay('$4', async () => { throw new Error('rpc timeout'); }), /rpc timeout/);
  const [payment] = budget.history();
  assert.match(cli(path, 'history').out, new RegExp(`unknown .*\\(${payment.id}\\)`));
  const released = cli(path, 'release', payment.id);
  assert.equal(released.code, 0, released.err);
  assert.equal(budget.status().inFlight, 0n);
});

test('an owner lists the open holds and releases the unknown ones in bulk', async () => {
  const path = join(DIR, 'holds.sqlite');
  const budget = openBudget({ wallet: WALLET, path, perDay: '$10', create: true });
  setClock(() => Date.now() - 2 * 3_600_000); // these two payments failed two hours ago
  for (const amount of ['$1', '$2']) await assert.rejects(budget.pay(amount, async () => { throw new Error('rpc timeout'); }), /rpc timeout/);
  resetClock();
  const recent = budget.reserve('$3');
  const listed = cli(path, 'holds');
  assert.equal(listed.code, 0, listed.err);
  assert.match(listed.out, /spend-\w+ +\$1\.00 +unknown +2h 0m old +js +counts until released/);
  assert.match(listed.out, new RegExp(`${recent.id} +\\$3\\.00 +in flight +\\d+s old`));
  assert.equal(JSON.parse(cli(path, 'holds', '--json').out).length, 3);
  assert.equal(cli(path, 'release', '--all-unknown').code, 2);
  const released = cli(path, 'release', '--all-unknown', '--older-than', '1h');
  assert.equal(released.code, 0, released.err);
  assert.match(released.out, /Released 2 payments of unknown or refused outcome older than 1h \(\$3\.00 from 0xd797…ca02\)/);
  assert.deepEqual(budget.holds().map(hold => hold.id), [recent.id]);
  assert.match(cli(path, 'release', '--all-unknown', '--older-than', '1h').out, /No payment of unknown or refused outcome/);
  budget.close();
});

test('a bulk release keeps a payment its payee could still settle, and clears refused ones', async () => {
  const path = join(DIR, 'settle-by.sqlite');
  const budget = openBudget({ wallet: WALLET, path, perDay: '$150', create: true });
  const now = Date.now();
  setClock(() => now - 2 * 3_600_000); // all three were taken two hours ago
  const live = budget.reserve('$100', { rail: 'x402', settlesBy: now + 3_600_000 });
  const lapsed = budget.reserve('$20', { rail: 'x402', settlesBy: now - 3_600_000 });
  const refused = budget.reserve('$10', { rail: 'x402' }); // as the CDP store reopens one CDP rolled back
  resetClock();
  live.annotate({ outcome: 'unknown' });
  lapsed.annotate({ outcome: 'unknown' });
  refused.annotate({ outcome: 'refused' });
  // 0.3.0 gave back the first too, with its authorization redeemable for another hour, and kept
  // the refused one counting until released one by one.
  const released = cli(path, 'release', '--all-unknown', '--older-than', '1h');
  assert.equal(released.code, 0, released.err);
  assert.match(released.out, /Released 2 payments of unknown or refused outcome older than 1h \(\$30\.00 from 0xd797…ca02\)/);
  assert.deepEqual(budget.holds().map(hold => hold.id), [live.id]);
  assert.equal(budget.check('$100').ok, false);
  budget.close();
});

test('a bulk release keeps a hold with no settle-by time for an hour and a minute, and a CDP roll-back until it can no longer settle', async () => {
  const path = join(DIR, 'unbounded.sqlite');
  const budget = openBudget({ wallet: WALLET, path, perDay: '$1', create: true });
  const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
  const terms = { scheme: 'exact', network: 'eip155:84532', asset: USDC, amount: '50000', payTo: '0x0773a0a3ec5f88162ea52470b7973b2cfaaa846a', maxTimeoutSeconds: 3600 };
  // An Agentic Wallet call that threw after the wallet may have signed terms valid an hour, and a
  // payment CDP rolled back: one pair taken 62 minutes ago, one pair now.
  const failed = () => guardAgenticWallet(budget, { request: async () => { throw new Error('IPC request timed out'); }, discover: async () => ({ accepts: [terms] }) })
    .request('make-x402-request', { baseURL: 'http://127.0.0.1:9', path: '/' }).catch(() => {});
  const rolledBack = async () => {
    const store = budget.cdpStore({ asset: USDC });
    const entry = { atomicAmount: 50_000n, asset: USDC, network: 'eip155:84532', payTo: terms.payTo, at: Date.now() };
    await store.append(entry);
    await store.removeEntry(entry);
    store.close();
  };
  setClock(() => Date.now() - 62 * 60_000);
  await failed();
  await rolledBack();
  resetClock();
  await failed();
  await rolledBack();
  await new Promise(done => setTimeout(done, 20));
  // 0.3.0 gave back all four 20 ms later, though the new pair could still be redeemed.
  const released = cli(path, 'release', '--all-unknown', '--older-than', '10ms');
  assert.equal(released.code, 0, released.err);
  assert.match(released.out, /Released 2 payments of unknown or refused outcome older than 10ms \(\$0\.10 from 0xd797…ca02\)/);
  const holds = budget.holds();
  assert.deepEqual(holds.map(hold => [hold.reason, hold.until === null]), [['unknown', true], ['refused', false]]);
  assert.equal(budget.status().inFlight, 100_000n);
  assert.match(cli(path, 'release', '--all-unknown', '--older-than', '10ms').out,
    /can be released yet\. One goes once it is older than 10ms and its payee can no longer settle it; one with no settle-by time, once it is also an hour and a minute old\./);
  budget.close();
});

test('mistakes are reported, not guessed', () => {
  const path = join(DIR, 'mistakes.sqlite');
  assert.equal(cli(path, 'frobnicate').code, 2);
  assert.equal(cli(path, 'set', '--per-dya', '5').code, 2);
  assert.match(cli(path, 'set', '--per-day', '5').err, /needs --wallet/);
  assert.match(cli(path, 'freeze').err, /no budget in/);
  openBudget({ wallet: WALLET, path, perDay: '$5', create: true }).close();
  openBudget({ wallet: '0x0000000000000000000000000000000000000001', path, perDay: '$5', create: true }).close();
  const ambiguous = cli(path, 'freeze');
  assert.equal(ambiguous.code, 2);
  assert.match(ambiguous.err, /holds 2 budgets; pick one with --wallet/);
  assert.match(cli(path, '--version').out, /^\d+\.\d+\.\d+\n$/);
});
