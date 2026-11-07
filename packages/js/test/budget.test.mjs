// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { resetClock, setClock } from '../dist/core/_clock.js';
import {
  Budget, BudgetRefused, BudgetUnavailable, MAX_AMOUNT, notSent, openBudget, openOwner, Owner, PaymentNotRecorded, UsageError,
} from 'walletcap';
import { cdpStore } from 'walletcap/cdp';
import { Ledger } from '../dist/core/ledger.js';

const DIR = mkdtempSync(join(tmpdir(), 'walletcap-'));
after(() => rmSync(DIR, { recursive: true, force: true }));
afterEach(resetClock);

let files = 0;
const WALLET = '0xd797ead28c38575fdf4fc523866287372340ca02';
const DAY = 86_400_000;
const TX = `0x${'ab'.repeat(32)}`;

/** A fresh file and a clock the test moves (the ledger's own clock, through the internal hook). */
const fixture = async (limits = { perPayment: '$50', perDay: '$150' }) => {
  const path = join(DIR, `budget-${files++}.sqlite`);
  const clock = { now: 1_800_000_000_000 };
  setClock(() => clock.now);
  const open = (more = {}) => openBudget({ wallet: WALLET, path, create: true, ...more });
  const budget = await open(limits);
  return { path, clock, open, budget, owner: await openOwner({ path }) };
};

const refusedFor = code => error => error instanceof BudgetRefused && error.code === code;
const paid = async (budget, amount) => budget.pay(amount, async () => TX);

test('the cap holds across payments and says why it refused', async () => {
  const { budget } = await fixture();
  for (let i = 0; i < 3; i += 1) await paid(budget, '$50');
  await assert.rejects(paid(budget, '$1'), error => refusedFor('budget')(error) && /\$150\.00 limit \(\$0\.00 left\)/.test(error.message));
  assert.equal((await budget.status()).spent, 150_000_000n);
  assert.match((await budget.status()).summary, /\$150\.00 spent of \$150\.00 per 24h, \$0\.00 left/);
});

test('a restart reads the same count, and cannot raise the limits it finds', async () => {
  const { budget, open } = await fixture({ perPayment: '$0.05', perDay: '$0.15' });
  for (let i = 0; i < 3; i += 1) await paid(budget, '$0.05');
  budget.close();
  const warnings = [];
  // The code comes back with looser limits (a kit's defaults, say): the stored ones stay.
  const restarted = await open({ perPayment: '$2.50', perDay: '$5', onWarning: message => warnings.push(message) });
  await assert.rejects(paid(restarted, '$1.00'), refusedFor('per_payment'));
  await assert.rejects(paid(restarted, '$0.05'), refusedFor('budget'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /keeps its stored limits \(\$0\.15 per 24h, at most \$0\.05 a payment\)/);
  assert.match(warnings[0], /npx walletcap set --wallet 0xd797\S+ --path .* --per-day 5 --per-payment 2\.50/);
  const status = await restarted.status();
  assert.equal(status.cap, 150_000n);
  assert.equal(status.perPayment, 50_000n);
});

test("a payer's tighter limits bind its own process only", async () => {
  const { budget, open } = await fixture();
  // 0.3.0 wrote a payer's tighter limits into the file, for everyone that opened it.
  const tighter = await open({ perPayment: '$10', perHour: '$25' });
  await assert.rejects(paid(tighter, '$20'), error => refusedFor('per_payment')(error) && error.source === 'process'
    && error.message === '$20.00 is over the $10.00 limit per payment this process set');
  await paid(tighter, '$10');
  await paid(tighter, '$10');
  await assert.rejects(paid(tighter, '$10'), error => refusedFor('budget')(error) && error.source === 'process' && /over the \$25\.00 limit this process set \(\$5\.00 left\)/.test(error.message));
  assert.deepEqual((await tighter.check('$10')).code, 'budget');
  // The budget itself is as its owner set it: another process pays $50 at once.
  assert.deepEqual([(await budget.status()).cap, (await budget.status()).perPayment], [150_000_000n, 50_000_000n]);
  await paid(budget, '$50');
  assert.equal((await budget.status()).spent, 70_000_000n);
});

test('raising a limit keeps what was spent: the total stays a total', async () => {
  const { budget, owner } = await fixture({ perPayment: '$0.05', perDay: '$0.15' });
  for (let i = 0; i < 3; i += 1) await paid(budget, '$0.05');
  const raised = await owner.setLimits(WALLET, { perDay: '$0.20' });
  assert.equal(raised.spent, 150_000n);
  assert.equal(raised.remaining, 50_000n);
  await paid(budget, '$0.05');
  await assert.rejects(paid(budget, '$0.05'), refusedFor('budget'));
});

test('the window cannot change after spend, so the count cannot be reset', async () => {
  const { budget, owner } = await fixture({ perPayment: '$0.05', perDay: '$0.15' });
  await paid(budget, '$0.05');
  await assert.rejects(owner.setLimits(WALLET, { cap: '$0.15', window: '1ms' }), /window can't change while payments count/);
  assert.equal((await budget.status()).spent, 50_000n);
});

test('lowering a limit below what was spent refuses until the spend ages out', async () => {
  const { budget, clock, owner } = await fixture();
  await paid(budget, '$50');
  await paid(budget, '$50');
  assert.equal((await owner.setLimits(WALLET, { perDay: '$60' })).remaining, 0n);
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
  clock.now += DAY + 1;
  await paid(budget, '$50');
});

test('spend counts for one rolling window from when it settled', async () => {
  const { budget, clock } = await fixture({ perDay: '$150' });
  await paid(budget, '$100');
  clock.now += DAY / 2;
  await paid(budget, '$50');
  clock.now += DAY / 2; // the first payment is exactly a day old: it still counts
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
  clock.now += 1;
  await paid(budget, '$100');
  assert.equal((await budget.status()).spent, 150_000_000n);
});

test('a payment that fails halfway keeps counting; one tagged notSent is given back', async () => {
  const { budget } = await fixture();
  await assert.rejects(budget.pay('$50', async () => { throw new Error('rpc timeout'); }), /rpc timeout/);
  assert.equal((await budget.status()).inFlight, 50_000_000n);
  await assert.rejects(budget.pay('$50', async () => { throw notSent(new Error('card declined')); }), /card declined/);
  await assert.rejects(budget.pay('$50', async () => { throw notSent('never broadcast'); }), /never broadcast/);
  assert.deepEqual([(await budget.status()).spent, (await budget.status()).inFlight], [0n, 50_000_000n]);
  // The ledger keeps every payment: the two that never left are void, and count nothing.
  assert.deepEqual((await budget.history()).map(row => row.status), ['void', 'void', 'unknown']);
});

test('an error never settles a payment: an unknown outcome counts until its owner releases it', async () => {
  const { budget, clock } = await fixture({ perDay: '$150' });
  // A transfer whose receipt wait timed out can still be mined hours later.
  await assert.rejects(budget.pay('$150', async () => { throw new Error('receipt timeout'); }), /receipt timeout/);
  clock.now += 30 * DAY;
  const status = await budget.status();
  assert.deepEqual([status.spent, status.inFlight, status.remaining], [0n, 150_000_000n, 0n]);
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
  const [unknown] = await budget.history();
  assert.deepEqual([unknown.status, unknown.counting], ['unknown', true]);
});

test('an unknown outcome with a settle-by time counts until one window past it', async () => {
  const { budget, clock } = await fixture({ perDay: '$150' });
  const settlesBy = new Date(clock.now + 300_000);
  await assert.rejects(budget.pay('$150', async () => { throw new Error('rpc timeout'); }, { settlesBy }), /rpc timeout/);
  clock.now += 300_000 + DAY;
  assert.equal((await budget.status()).inFlight, 150_000_000n);
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
  clock.now += 1;
  assert.equal((await budget.status()).inFlight, 0n);
  assert.equal((await budget.history())[0].status, 'expired');
  await paid(budget, '$150');
});

test('pay() returns what the payment returns and keeps its transaction hash', async () => {
  const { budget } = await fixture();
  let seen;
  const result = await budget.pay('$5', async hold => {
    seen = hold;
    return { hash: TX, ok: true };
  }, { to: '0x4165cb72De51A67aac32DC33197d779552205efD', note: 'one API call' });
  assert.deepEqual(result, { hash: TX, ok: true });
  assert.match(seen.id, /^wc-[0-9a-f]{32}$/);
  assert.deepEqual([seen.state, seen.created], ['settled', true]);
  const [entry] = await budget.history();
  assert.deepEqual([entry.status, entry.amount, entry.tx, entry.to, entry.note], ['settled', 5_000_000n, TX, '0x4165cb72De51A67aac32DC33197d779552205efD', 'one API call']);
});

test("a settlement never shortens a hold: it counts until one window past the hold's settle-by time", async () => {
  const { budget, clock } = await fixture({ perDay: '$150' });
  // A payee can answer "settled" at once and keep a signed authorization that is valid two days.
  const held = await budget.hold('$150', { settlesBy: new Date(clock.now + 2 * DAY) });
  await held.settle({ tx: TX });
  clock.now += DAY + 1;
  assert.equal((await budget.status()).spent, 150_000_000n);
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
  clock.now += 2 * DAY - 1; // the settle-by time plus one window
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
  assert.deepEqual([(await budget.history())[0].status, (await budget.history())[0].counting], ['settled', true]);
  clock.now += 1;
  assert.equal((await budget.status()).spent, 0n);
  await paid(budget, '$150');
});

test('a refusal names the open payments that take up the room, and holds() lists them', async () => {
  const { budget, clock } = await fixture({ perDay: '$150', maxPayments: 3 });
  for (const amount of ['$10', '$20']) await assert.rejects(budget.pay(amount, async () => { throw new Error('rpc timeout'); }), /rpc timeout/);
  clock.now += 3_600_000;
  await budget.hold('$5', { settlesBy: new Date(clock.now + 300_000) });
  const holds = await budget.holds();
  assert.deepEqual(holds.map(hold => [hold.reason, hold.amount, hold.ageMs, hold.countsUntil === null]), [
    ['unknown', 10_000_000n, 3_600_000n, true], ['unknown', 20_000_000n, 3_600_000n, true], ['in flight', 5_000_000n, 0n, false],
  ]);
  assert.equal(holds[0].error, 'rpc timeout');
  assert.equal(holds[2].countsUntil.getTime(), clock.now + 300_000 + DAY);
  // 0.3.0 said "already made 3 payments in the last 24h", naming none of them.
  const used = await budget.check('$1');
  assert.equal(used.code, 'max_payments');
  assert.match(used.message, /has 3 payments counting in the last 24h, the most its budget allows, and 3 of them are still open \(wc-\w+, wc-\w+, wc-\w+; walletcap holds lists them/);
  const { budget: other } = await fixture({ perDay: '$150' });
  await assert.rejects(other.pay('$100', async () => { throw new Error('rpc timeout'); }), /rpc timeout/);
  assert.match((await other.check('$60')).message, /over its \$150\.00 limit \(\$50\.00 left\); \$100\.00 of it is 1 open payment \(wc-\w+; walletcap holds lists them/);
});

test('a payment that went through but cannot be recorded throws PaymentNotRecorded, which is none of the other errors', async () => {
  const { path, budget } = await fixture({ perDay: '$150' });
  let id;
  // The ledger becomes unusable between the payment and its record (here, it is closed).
  const error = await budget.pay('$5', async hold => { id = hold.id; budget.close(); return TX; }).catch(caught => caught);
  assert.ok(error instanceof PaymentNotRecorded, error);
  // Code that retries on any of the other three must not pay twice.
  for (const other of [BudgetUnavailable, BudgetRefused, UsageError]) assert.equal(error instanceof other, false, other.name);
  assert.equal(error.name, 'PaymentNotRecorded');
  assert.equal(error.paymentId, id);
  assert.ok(error.cause instanceof BudgetUnavailable);
  assert.ok(error.message.endsWith(`still counts as in flight (${id})`), error.message);
  assert.equal((await (await openBudget({ wallet: WALLET, path })).status()).inFlight, 5_000_000n);
});

test('a hold counts while the payment is in flight, and once only', async () => {
  const { budget } = await fixture({ perDay: '$150' });
  const held = await budget.hold('$100');
  await assert.rejects(paid(budget, '$100'), refusedFor('budget'));
  assert.equal((await budget.status()).inFlight, 100_000_000n);
  await held.settle({ tx: TX });
  // Settling again is the same settlement; a settled payment can't be voided.
  await held.settle();
  assert.equal(held.state, 'settled');
  await assert.rejects(held.void(), error => error instanceof UsageError && /a settled payment can't be voided/.test(error.message));
  const other = await budget.hold('$50');
  await other.void();
  assert.equal((await budget.status()).spent, 100_000_000n);
  assert.equal((await budget.status()).inFlight, 0n);
});

test('a hold with a settle-by time stops counting a window after it', async () => {
  const { budget, clock } = await fixture({ perDay: '$150' });
  await budget.hold('$100', { settlesBy: new Date(clock.now + 300_000) });
  clock.now += 300_000 + DAY;
  assert.equal((await budget.status()).inFlight, 100_000_000n);
  clock.now += 1;
  assert.equal((await budget.status()).inFlight, 0n);
  assert.equal((await budget.history())[0].status, 'expired');
});

test("a settle-by time that isn't after now is refused: a payment can't settle before it is made", async () => {
  const { budget, clock } = await fixture({ perDay: '$150' });
  // 0.2.x stored a past moment as given, so the reservation never counted and a second $150 passed.
  for (const settlesBy of [new Date(0), clock.now - 1, new Date(clock.now)]) {
    await assert.rejects(budget.hold('$150', { settlesBy }), /is not after now/);
    await assert.rejects(budget.pay('$150', async () => TX, { settlesBy }), /is not after now/);
  }
  assert.equal((await budget.status()).payments, 0n);
  const held = await budget.hold('$150', { settlesBy: new Date(clock.now + 1) });
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
  clock.now += DAY + 2;
  assert.equal((await budget.status()).inFlight, 0n);
  await held.settle(); // settled late after all: it counts again, for a window from now
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
});

test('amounts and limits stop at a billion dollars, so no sum of payments can overflow', async () => {
  const { budget, clock, owner } = await fixture({ perDay: '$1,000,000,000' });
  assert.equal(MAX_AMOUNT, 1_000_000_000_000_000n);
  for (const tooMuch of ['$1,000,000,000.000001', MAX_AMOUNT + 1n, (1n << 63n) - 1n]) {
    await assert.rejects(budget.hold(tooMuch), /more than \$1,000,000,000\.00/);
    await assert.rejects(owner.setLimits(WALLET, { perDay: tooMuch }), /more than \$1,000,000,000\.00/);
  }
  // Two holds of the most a budget can hold count at once: one lapsed, then settled late.
  const first = await budget.hold(MAX_AMOUNT, { settlesBy: new Date(clock.now + 1) });
  clock.now += DAY + 2;
  const second = await budget.hold(MAX_AMOUNT);
  await first.settle();
  // 0.2.x took near-2^63 amounts, and two of them overflowed SQLite's SUM: every payment failed.
  const status = await budget.status();
  assert.deepEqual([status.spent, status.inFlight, status.remaining], [MAX_AMOUNT, MAX_AMOUNT, 0n]);
  await assert.rejects(paid(budget, '$1'), refusedFor('budget'));
  await second.void();
});

test('the per-payment limit and the payment count hold too', async () => {
  const { budget } = await fixture({ perPayment: '$50', perDay: '$150', maxPayments: 2 });
  await assert.rejects(paid(budget, '$50.01'), refusedFor('per_payment'));
  await paid(budget, '$1');
  await paid(budget, '$1');
  await assert.rejects(paid(budget, '$1'), refusedFor('max_payments'));
});

test('check() answers without taking anything', async () => {
  const { budget } = await fixture({ perDay: '$150' });
  assert.deepEqual(await budget.check('$150'), { ok: true, remaining: 150_000_000n });
  const refused = await budget.check('$151');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'budget');
  assert.equal((await budget.status()).inFlight, 0n);
});

test('freezing stops every payment in every process until unfrozen', async () => {
  const { budget, owner } = await fixture();
  await owner.freeze(WALLET);
  await assert.rejects(paid(budget, '$1'), refusedFor('frozen'));
  assert.equal((await budget.status()).frozen, true);
  assert.equal((await budget.status()).remaining, 0n);
  await owner.unfreeze(WALLET);
  await paid(budget, '$1');
});

test('the payer handle has no owner methods, and the owner reconciles with evidence', async () => {
  const { budget, owner, clock } = await fixture({ perDay: '$150' });
  for (const method of ['setLimits', 'freeze', 'unfreeze', 'void', 'settle', 'voidUnknown', 'reserve']) assert.equal(budget[method], undefined, method);
  assert.ok(budget instanceof Budget && owner instanceof Owner);
  const lost = await budget.hold('$100');
  await lost.note('unknown', 'rpc timeout');
  // The chain shows the authorization unused past its expiry: the owner voids it, with that evidence.
  const voided = await owner.void(lost.id, { evidence: 'authorizationState false after validBefore' });
  assert.deepEqual([voided.state, voided.counting, (await budget.status()).inFlight], ['void', false, 0n]);
  // Later evidence that it paid after all: VOID -> SETTLED, and it counts again.
  const settled = await owner.settle(lost.id, { evidence: TX });
  assert.deepEqual([settled.state, settled.tx, settled.countsUntil.getTime()], ['settled', TX, clock.now + DAY]);
  await assert.rejects(owner.void(lost.id), error => error instanceof UsageError && /a settled payment can't be voided/.test(error.message));
  await assert.rejects(owner.void('wc-nobody'), UsageError);
  assert.equal((await owner.payment(lost.id)).wallet, WALLET);
  assert.equal(await owner.payment('wc-nobody'), null);
});

test('one id is one payment: holding it again returns it, and pay() never makes it twice', async () => {
  const { budget } = await fixture({ perDay: '$150' });
  const first = await budget.hold('$40', { id: 'order-17' });
  const again = await budget.hold('$40', { id: 'order-17' });
  assert.deepEqual([first.created, again.created, again.id, (await budget.status()).payments], [true, false, 'order-17', 1n]);
  await assert.rejects(budget.hold('$41', { id: 'order-17' }), error => error instanceof UsageError && /already in the ledger/.test(error.message));
  let ran = false;
  await assert.rejects(budget.pay('$40', async () => { ran = true; }, { id: 'order-17' }), UsageError);
  assert.equal(ran, false);
});

test('the four errors share no base, and say what happened', async () => {
  const errors = [BudgetUnavailable, BudgetRefused, PaymentNotRecorded, UsageError];
  for (const a of errors) for (const b of errors) if (a !== b) assert.equal(a.prototype instanceof b, false, `${a.name} extends ${b.name}`);
  await assert.rejects(openBudget({ wallet: WALLET, path: join(DIR, 'none.sqlite') }), BudgetUnavailable);
  await assert.rejects(openBudget({ wallet: 'has space', path: join(DIR, 'none.sqlite') }), UsageError);
  const { budget } = await fixture({ perDay: '$1' });
  await assert.rejects(budget.hold('$2'), error => error instanceof BudgetRefused && error.code === 'budget' && error.source === 'budget' && typeof error.brief === 'string');
});

test('checksummed, lowercase and CAIP-10 addresses spend from one budget', async () => {
  const { path } = await fixture({ perDay: '$150' });
  const a = await openBudget({ wallet: '0xd797ead28C38575FDf4fC523866287372340Ca02', path });
  const b = await openBudget({ wallet: `eip155:8453:${WALLET}`, path });
  await paid(a, '$100');
  await assert.rejects(paid(b, '$100'), refusedFor('budget'));
});

test('a new wallet needs a cap, and a typo in an option is an error, not a missing limit', async () => {
  const { path } = await fixture();
  await assert.rejects(openBudget({ wallet: '0x0000000000000000000000000000000000000001', path, create: true }), /give it a rolling limit/);
  await assert.rejects(openBudget({ wallet: WALLET, path, perday: '$5' }), /unknown option perday; did you mean perDay\?/);
  await assert.rejects(openBudget({ wallet: WALLET, path, per_payment: '$5' }), /did you mean perPayment\?/);
});

test('with create: false only an owner makes the budget; nothing falls back to defaults', async () => {
  const missing = join(DIR, 'never-created.sqlite');
  await assert.rejects(openBudget({ wallet: WALLET, path: missing, create: false, perDay: '$5' }), /no budget file/);
  const { path } = await fixture();
  await assert.rejects(openBudget({ wallet: '0x0000000000000000000000000000000000000002', path, create: false, perDay: '$5' }), /has no budget/);
});

test('the default is fail-closed: a missing budget is not created', async () => {
  const missing = join(DIR, 'default-missing.sqlite');
  await assert.rejects(openBudget({ wallet: WALLET, path: missing, perDay: '$5' }), /no budget file/);
  const created = await openBudget({ wallet: WALLET, path: missing, perDay: '$5', create: true });
  assert.equal((await created.status()).cap, 5_000_000n);
  created.close();
});

test('a file that is not a budget is refused, not replaced', async () => {
  const path = join(DIR, 'corrupt.sqlite');
  writeFileSync(path, 'this is not a database, and it is not empty either: '.repeat(100));
  await assert.rejects(openBudget({ wallet: WALLET, path, perDay: '$5' }), { name: 'BudgetUnavailable', message: /cannot be used/ });
});

test('zero and malformed amounts are refused before anything is reserved', async () => {
  const { budget } = await fixture();
  await assert.rejects(budget.pay('$0', async () => TX), /more than \$0/);
  await assert.rejects(budget.pay('$5', 'not a function'), /fn is missing/);
  await assert.rejects(budget.hold('five dollars'), { name: 'UsageError' });
  assert.equal((await budget.status()).payments, 0n);
});

test('the clock is not an option: no process can move its own time to empty the budget', async () => {
  const { path, budget } = await fixture({ perDay: '$150' });
  await paid(budget, '$150');
  // 0.2.x let each process bring its own clock; one running a day ahead saw an empty budget.
  await assert.rejects(openBudget({ wallet: WALLET, path, clock: () => Date.now() + DAY + 1 }), /unknown option clock/);
  assert.throws(() => cdpStore(budget, { asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', clock: Date.now }), /unknown option clock/);
  await assert.rejects(paid(await openBudget({ wallet: WALLET, path }), '$150'), refusedFor('budget'));
});

const FIXTURES = new URL('../../../spec/fixtures/', import.meta.url);
const T0 = 1_800_000_000_000;
const APP = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const MERGED = '0x4165cb72De51A67aac32DC33197d779552205efD';
const CHECKSUMMED = '0xd797ead28C38575FDf4fC523866287372340Ca02';
const fromFixture = name => {
  const path = join(DIR, `budget-${files++}.sqlite`);
  copyFileSync(new URL(name, FIXTURES), path);
  return path;
};

test('the upgrade says what it did: a warning names the merged limits, and a wallet in two units is frozen, not the file', async () => {
  setClock(() => T0);
  const path = fromFixture('schema-1.sqlite');
  // 0.2.4 kept $150 a day under the app's checksummed address and $100 under the lowercase one:
  // the upgrade kept $100. Code that asks for $150 is told why the stored limit is lower.
  const warnings = [];
  (await openBudget({ wallet: APP, path, perDay: '$150', onWarning: message => warnings.push(message) })).close();
  assert.ok(warnings[0].endsWith("The 0.3.0 upgrade merged the budget 0.2.x kept under 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed into this one, "
    + "with the tighter of each limit; its owner can change them with 'walletcap set'"), warnings[0]);
  // Another wallet kept a budget in wei beside its dollar one: that wallet alone is refused, and says why.
  const frozen = await openBudget({ wallet: CHECKSUMMED, path });
  await assert.rejects(paid(frozen, '$1'), error => refusedFor('frozen')(error) && error.message.endsWith(
    'The 0.3.0 upgrade froze it: 0.2.x also kept a budget in wei under 0xd797ead28C38575FDf4fC523866287372340Ca02 for this wallet, '
      + "which can't be merged with this one in usd, so that budget no longer counts",
  ));
  await paid(await openBudget({ wallet: APP, path }), '$1');
  const owner = await openOwner({ path });
  await owner.unfreeze(CHECKSUMMED);
  await paid(frozen, '$1');
  await owner.freeze(CHECKSUMMED);
  await assert.rejects(paid(frozen, '$1'), error => refusedFor('frozen')(error) && !/0\.3\.0 upgrade/.test(error.message));
});

test('a 0.2.x file is upgraded on open: every spelling of a wallet becomes one budget, and every payment still counts', async () => {
  setClock(() => T0);
  const path = fromFixture('schema-1.sqlite');
  const upgraded = await openBudget({ wallet: MERGED, path });
  const status = await upgraded.status();
  // The tighter of every limit: the smallest cap and per-payment limit, and the longest window.
  assert.deepEqual([status.cap, status.window, status.perPayment, status.maxPayments], [150_000_000n, 86_400_000n, 50_000_000n, 10n]);
  assert.deepEqual([status.spent, status.inFlight, status.remaining], [110_000_000n, 20_000_000n, 20_000_000n]);
  await assert.rejects(paid(upgraded, '$20.01'), refusedFor('budget'));
  await paid(upgraded, '$20');
  assert.deepEqual((await upgraded.history()).map(row => row.id).sort(), ['spend-a', 'spend-b', 'spend-c', (await upgraded.history())[0].id].sort());
  const ledger = await Ledger.open(path);
  try {
    assert.deepEqual((await ledger.budgets()).map(row => row.wallet).filter(wallet => wallet.startsWith('0x41')), [MERGED.toLowerCase()]);
  } finally {
    ledger.close();
  }
  // Another process opening the same wallet through its CAIP-10 name sees the same count.
  const caip10 = await openBudget({ wallet: `eip155:8453:${MERGED}`, path });
  try {
    assert.equal((await caip10.status()).remaining, 0n);
  } finally {
    caip10.close();
  }
});
