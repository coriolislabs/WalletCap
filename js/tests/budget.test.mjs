// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { resetClock, setClock } from '../_clock.mjs';
import { BudgetRefused, MAX_AMOUNT, notSent, openBudget, SharedBudgetStore } from '../index.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'walletcap-'));
after(() => rmSync(DIR, { recursive: true, force: true }));
afterEach(resetClock);

let files = 0;
const WALLET = '0xd797ead28c38575fdf4fc523866287372340ca02';
const DAY = 86_400_000;
const TX = `0x${'ab'.repeat(32)}`;

/** A fresh file and a clock the test moves (the ledger's own clock, through the internal hook). */
const fixture = (limits = { perPayment: '$50', perDay: '$150' }) => {
  const path = join(DIR, `budget-${files++}.sqlite`);
  const clock = { now: 1_800_000_000_000 };
  setClock(() => clock.now);
  const open = (more = {}) => openBudget({ wallet: WALLET, path, create: true, ...more });
  return { path, clock, open, budget: open(limits) };
};

const refusedFor = reason => error => error instanceof BudgetRefused && error.reason === reason;
const paid = async (budget, amount) => budget.pay(amount, async () => TX);

test('the cap holds across payments and says why it refused', async () => {
  const { budget } = fixture();
  for (let i = 0; i < 3; i += 1) await paid(budget, '$50');
  await assert.rejects(paid(budget, '$1'), error => refusedFor('budget')(error) && /\$150\.00 limit \(\$0\.00 left\)/.test(error.message));
  assert.equal(budget.status().spent, 150_000_000n);
  assert.match(budget.status().summary, /\$150\.00 spent of \$150\.00 per 24h, \$0\.00 left/);
});

test('a restart reads the same count, and cannot raise the limits it finds', async () => {
  const { budget, open } = fixture({ perPayment: '$0.05', perDay: '$0.15' });
  for (let i = 0; i < 3; i += 1) await paid(budget, '$0.05');
  budget.close();
  const warnings = [];
  // The code comes back with looser limits (a kit's defaults, say): the stored ones stay.
  const restarted = open({ perPayment: '$2.50', perDay: '$5', onWarning: message => warnings.push(message) });
  await assert.rejects(paid(restarted, '$1.00'), refusedFor('per_payment'));
  await assert.rejects(paid(restarted, '$0.05'), refusedFor('budget'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /keeps its stored limits \(\$0\.15 per 24h, at most \$0\.05 a payment\)/);
  assert.match(warnings[0], /npx walletcap set --wallet 0xd797\S+ --path .* --per-day 5 --per-payment 2\.50/);
  const status = restarted.status();
  assert.equal(status.cap, 150_000n);
  assert.equal(status.perPayment, 50_000n);
});

test('code can lower a limit for everyone that opens the file', async () => {
  const { budget, open } = fixture();
  const tighter = open({ perPayment: '$10', perDay: '$100' });
  assert.equal(tighter.status().cap, 100_000_000n);
  // Every other process now sees the lower limits, even one that asks for the old ones.
  await assert.rejects(paid(budget, '$20'), refusedFor('per_payment'));
  assert.equal(open({ perPayment: '$50', perDay: '$150', onWarning: () => {} }).status().cap, 100_000_000n);
});

test('raising a limit keeps what was spent: the total stays a total', async () => {
  const { budget } = fixture({ perPayment: '$0.05', perDay: '$0.15' });
  for (let i = 0; i < 3; i += 1) await paid(budget, '$0.05');
  const raised = budget.setLimits({ perDay: '$0.20' });
  assert.equal(raised.spent, 150_000n);
  assert.equal(raised.remaining, 50_000n);
  await paid(budget, '$0.05');
  await assert.rejects(paid(budget, '$0.05'), refusedFor('budget'));
});

test('the window cannot change after spend, so the count cannot be reset', async () => {
  const { budget } = fixture({ perPayment: '$0.05', perDay: '$0.15' });
  await paid(budget, '$0.05');
  assert.throws(() => budget.setLimits({ cap: '$0.15', window: '1ms' }), /window cannot change/);
  assert.equal(budget.status().spent, 50_000n);
});

test('lowering a limit below what was spent refuses until the spend ages out', async () => {
  const { budget, clock } = fixture();
  await paid(budget, '$50');
  await paid(budget, '$50');
  assert.equal(budget.setLimits({ perDay: '$60' }).remaining, 0n);
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
  clock.now += DAY + 1;
  await paid(budget, '$50');
});

test('spend counts for one rolling window from when it settled', async () => {
  const { budget, clock } = fixture({ perDay: '$150' });
  await paid(budget, '$100');
  clock.now += DAY / 2;
  await paid(budget, '$50');
  clock.now += DAY / 2; // the first payment is exactly a day old: it still counts
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
  clock.now += 1;
  await paid(budget, '$100');
  assert.equal(budget.status().spent, 150_000_000n);
});

test('a payment that fails halfway keeps counting; one tagged notSent is given back', async () => {
  const { budget } = fixture();
  await assert.rejects(budget.pay('$50', async () => { throw new Error('rpc timeout'); }), /rpc timeout/);
  assert.equal(budget.status().inFlight, 50_000_000n);
  await assert.rejects(budget.pay('$50', async () => { throw notSent(new Error('card declined')); }), /card declined/);
  await assert.rejects(budget.pay('$50', async () => { throw notSent('never broadcast'); }), /never broadcast/);
  assert.deepEqual([budget.status().spent, budget.status().inFlight], [0n, 50_000_000n]);
  const [newest] = budget.history();
  assert.equal(newest.status, 'unknown');
});

test('an error never settles a payment: an unknown outcome counts until its owner releases it', async () => {
  const { budget, clock } = fixture({ perDay: '$150' });
  // A transfer whose receipt wait timed out can still be mined hours later.
  await assert.rejects(budget.pay('$150', async () => { throw new Error('receipt timeout'); }), /receipt timeout/);
  clock.now += 30 * DAY;
  const status = budget.status();
  assert.deepEqual([status.spent, status.inFlight, status.remaining], [0n, 150_000_000n, 0n]);
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
  const [unknown] = budget.history();
  assert.deepEqual([unknown.status, unknown.counting], ['unknown', true]);
});

test('an unknown outcome with a settle-by time counts until one window past it', async () => {
  const { budget, clock } = fixture({ perDay: '$150' });
  const settlesBy = new Date(clock.now + 300_000);
  await assert.rejects(budget.pay('$150', async () => { throw new Error('rpc timeout'); }, { settlesBy }), /rpc timeout/);
  clock.now += 300_000 + DAY;
  assert.equal(budget.status().inFlight, 150_000_000n);
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
  clock.now += 1;
  assert.equal(budget.status().inFlight, 0n);
  assert.equal(budget.history()[0].status, 'expired');
  await paid(budget, '$150');
});

test('pay() returns what the payment returns and keeps its transaction hash', async () => {
  const { budget } = fixture();
  let seen;
  const result = await budget.pay('$5', async reservation => {
    seen = reservation;
    return { hash: TX, ok: true };
  }, { to: '0x4165cb72De51A67aac32DC33197d779552205efD', note: 'one API call' });
  assert.deepEqual(result, { hash: TX, ok: true });
  assert.match(seen.id, /^spend-[0-9a-f]{32}$/);
  assert.equal(seen.open, false);
  const [entry] = budget.history();
  assert.deepEqual([entry.status, entry.amount, entry.tx, entry.to, entry.note], ['settled', 5_000_000n, TX, '0x4165cb72De51A67aac32DC33197d779552205efD', 'one API call']);
});

test('a reservation counts while the payment is in flight, and once only', async () => {
  const { budget } = fixture({ perDay: '$150' });
  const held = budget.reserve('$100');
  await assert.rejects(paid(budget, '$100'), refusedFor('budget'));
  assert.equal(budget.status().inFlight, 100_000_000n);
  held.commit({ tx: TX });
  assert.throws(() => held.commit(), /already committed/);
  assert.throws(() => held.release(), /already committed/);
  const other = budget.reserve('$50');
  other.release();
  assert.equal(budget.status().spent, 100_000_000n);
  assert.equal(budget.status().inFlight, 0n);
});

test('a reservation with a settle-by time stops counting a window after it', () => {
  const { budget, clock } = fixture({ perDay: '$150' });
  budget.reserve('$100', { settlesBy: new Date(clock.now + 300_000) });
  clock.now += 300_000 + DAY;
  assert.equal(budget.status().inFlight, 100_000_000n);
  clock.now += 1;
  assert.equal(budget.status().inFlight, 0n);
  assert.equal(budget.history()[0].status, 'expired');
});

test('a settle-by time already past counts as now, so the reservation still holds the money', async () => {
  const { budget, clock } = fixture({ perDay: '$150' });
  // 0.2.x stored the past moment as given: the reservation never counted, and a second $150 passed.
  const held = budget.reserve('$150', { settlesBy: new Date(0) });
  await assert.rejects(paid(budget, '$150'), refusedFor('budget'));
  clock.now += DAY;
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
  clock.now += 1;
  assert.equal(budget.status().inFlight, 0n);
  held.commit(); // settled late after all: it counts again, for a window from now
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
});

test('amounts and limits stop at a billion dollars, so no sum of payments can overflow', async () => {
  const { budget, clock } = fixture({ perDay: '$1,000,000,000' });
  assert.equal(MAX_AMOUNT, 1_000_000_000_000_000n);
  for (const tooMuch of ['$1,000,000,000.000001', MAX_AMOUNT + 1n, (1n << 63n) - 1n]) {
    assert.throws(() => budget.reserve(tooMuch), /more than \$1,000,000,000\.00/);
    assert.throws(() => budget.setLimits({ perDay: tooMuch }), /more than \$1,000,000,000\.00/);
  }
  // Two holds of the most a budget can hold count at once: one lapsed, then settled late.
  const first = budget.reserve(MAX_AMOUNT, { settlesBy: new Date(clock.now) });
  clock.now += DAY + 1;
  const second = budget.reserve(MAX_AMOUNT);
  first.commit();
  // 0.2.x took near-2^63 amounts, and two of them overflowed SQLite's SUM: every payment failed.
  const status = budget.status();
  assert.deepEqual([status.spent, status.inFlight, status.remaining], [MAX_AMOUNT, MAX_AMOUNT, 0n]);
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
  second.release();
});

test('the per-payment limit and the payment count hold too', async () => {
  const { budget } = fixture({ perPayment: '$50', perDay: '$150', maxPayments: 2 });
  await assert.rejects(paid(budget, '$50.01'), refusedFor('per_payment'));
  await paid(budget, '$1');
  await paid(budget, '$1');
  await assert.rejects(paid(budget, '$1'), refusedFor('uses'));
});

test('check() answers without taking anything', () => {
  const { budget } = fixture({ perDay: '$150' });
  assert.deepEqual(budget.check('$150'), { ok: true, remaining: 150_000_000n });
  const refused = budget.check('$151');
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'budget');
  assert.equal(budget.status().inFlight, 0n);
});

test('freezing stops every payment in every process until unfrozen', async () => {
  const { budget, open } = fixture();
  open().freeze();
  await assert.rejects(paid(budget, '$1'), refusedFor('revoked'));
  assert.equal(budget.status().frozen, true);
  assert.equal(budget.status().remaining, 0n);
  budget.unfreeze();
  await paid(budget, '$1');
});

test('checksummed, lowercase and CAIP-10 addresses spend from one budget', async () => {
  const { path } = fixture({ perDay: '$150' });
  const a = openBudget({ wallet: '0xd797ead28C38575FDf4fC523866287372340Ca02', path });
  const b = openBudget({ wallet: `eip155:8453:${WALLET}`, path });
  await paid(a, '$100');
  await assert.rejects(paid(b, '$100'), refusedFor('budget'));
});

test('a new wallet needs a cap, and a typo in an option is an error, not a missing limit', () => {
  const { path } = fixture();
  assert.throws(() => openBudget({ wallet: '0x0000000000000000000000000000000000000001', path, create: true }), /give it a rolling limit/);
  assert.throws(() => openBudget({ wallet: WALLET, path, perday: '$5' }), /unknown option perday; did you mean perDay\?/);
  assert.throws(() => openBudget({ wallet: WALLET, path, per_payment: '$5' }), /did you mean perPayment\?/);
});

test('with create: false only an owner makes the budget; nothing falls back to defaults', () => {
  const missing = join(DIR, 'never-created.sqlite');
  assert.throws(() => openBudget({ wallet: WALLET, path: missing, create: false, perDay: '$5' }), /no budget file/);
  const { path } = fixture();
  assert.throws(() => openBudget({ wallet: '0x0000000000000000000000000000000000000002', path, create: false, perDay: '$5' }), /has no budget/);
});

test('the default is fail-closed: a missing budget is not created', () => {
  const missing = join(DIR, 'default-missing.sqlite');
  assert.throws(() => openBudget({ wallet: WALLET, path: missing, perDay: '$5' }), /no budget file/);
  const created = openBudget({ wallet: WALLET, path: missing, perDay: '$5', create: true });
  assert.equal(created.status().cap, 5_000_000n);
  created.close();
});

test('a file that is not a budget is refused, not replaced', () => {
  const path = join(DIR, 'corrupt.sqlite');
  writeFileSync(path, 'this is not a database, and it is not empty either: '.repeat(100));
  assert.throws(() => openBudget({ wallet: WALLET, path, perDay: '$5' }), { name: 'BudgetError', message: /cannot be used/ });
});

test('zero and malformed amounts are refused before anything is reserved', async () => {
  const { budget } = fixture();
  await assert.rejects(budget.pay('$0', async () => TX), /more than \$0/);
  await assert.rejects(budget.pay('$5', 'not a function'), /fn is missing/);
  assert.throws(() => budget.reserve('five dollars'), { name: 'BudgetError' });
  assert.equal(budget.status().payments, 0n);
});

test('the clock is not an option: no process can move its own time to empty the budget', async () => {
  const { path, budget } = fixture({ perDay: '$150' });
  await paid(budget, '$150');
  // 0.2.x let each process bring its own clock; one running a day ahead saw an empty budget.
  assert.throws(() => openBudget({ wallet: WALLET, path, clock: () => Date.now() + DAY + 1 }), /unknown option clock/);
  assert.throws(() => budget.cdpStore({ asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', clock: Date.now }), /unknown option clock/);
  assert.throws(() => new SharedBudgetStore({ path, instrument: WALLET, asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', clock: Date.now }), /unknown option clock/);
  await assert.rejects(paid(openBudget({ wallet: WALLET, path }), '$150'), refusedFor('budget'));
});
