// SPDX-License-Identifier: Apache-2.0
// The decision log. The ledger records the payments a budget admitted; a refusal used to leave
// nothing behind but the error. Every decision a payer's handle makes (a hold admitted or refused,
// and each move of a hold it took) reaches its onDecision callback and, when WALLETCAP_LOG names
// a file, one JSON line there. The log comes after the ledger and can't change what it answered.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { resetClock, setClock } from '../dist/core/_clock.js';
import { decisionLogFile } from '../dist/core/_decisions.js';
import { BudgetRefused, notSent, openBudget, openOwner, UsageError } from 'walletcap';
import { guardAgenticWallet } from 'walletcap/agentic';
import { cdpStore } from 'walletcap/cdp';
import { guard } from 'walletcap/x402';
import { race } from './support/race.mjs';
import { NETWORK, PAY_TO, USDC, x402 } from './support/x402-kit.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'walletcap-decisions-'));
// Windows keeps a budget file a test left open; its temp folder is cleared later.
after(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* open on Windows */
  }
});
// A log the developer's own shell names must not take these tests' decisions.
delete process.env.WALLETCAP_LOG;
afterEach(() => {
  resetClock();
  delete process.env.WALLETCAP_LOG;
});

const kit = await x402();
const WALLET = '0xd797ead28c38575fdf4fc523866287372340ca02';
const TX = `0x${'ab'.repeat(32)}`;
const T0 = 1_800_000_000_000;
const FIELDS = ['decision', 'at', 'wallet', 'amount', 'id', 'rail', 'to', 'code', 'source', 'brief', 'outcome', 'settlesBy', 'tx'];
const WIRE = ['decision', 'at', 'wallet', 'amount', 'id', 'rail', 'to', 'code', 'source', 'brief', 'outcome', 'settles_by', 'tx'];
const NONE = { id: null, to: null, code: null, source: null, brief: null, outcome: null, settlesBy: null, tx: null };
let files = 0;

/** A fresh budget whose decisions are collected, on a clock the test moves. `log` is WALLETCAP_LOG while it opens. */
const fixture = async ({ log, now = T0, wallet = WALLET, limits = { perPayment: '$50', perDay: '$150' }, ...options } = {}) => {
  const path = join(DIR, `budget-${files++}.sqlite`);
  const clock = { now };
  setClock(() => clock.now);
  const decisions = [];
  if (log !== undefined) process.env.WALLETCAP_LOG = log;
  const budget = await openBudget({ wallet, path, create: true, onDecision: decision => decisions.push(decision), ...limits, ...options });
  // The log file is the one named when the budget was opened: the variable can go.
  delete process.env.WALLETCAP_LOG;
  return { path, clock, budget, decisions };
};

const kinds = decisions => decisions.map(decision => decision.decision);
const plain = decision => ({ ...decision });
const linesOf = file => {
  const text = readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'), 'the last line is whole');
  assert.match(text, /^[\n -~]*$/, 'the log is ASCII');
  return text.slice(0, -1).split('\n');
};
const refusedFor = code => error => error instanceof BudgetRefused && error.code === code;
const turn = () => new Promise(resolve => setImmediate(resolve));

/** What `run` made walletcap warn, as process.emitWarning was given it. */
const warned = async run => {
  const warnings = [];
  const emitWarning = process.emitWarning;
  process.emitWarning = (message, options) => warnings.push({ message: String(message), ...options });
  try {
    await run();
    // A rejected callback is caught a turn of the event loop later.
    await turn();
  } finally {
    process.emitWarning = emitWarning;
  }
  return warnings;
};

test('each of the six decisions reaches the callback once, with every field', async () => {
  const { budget, decisions, clock } = await fixture();
  const hold = await budget.hold('$5', { id: 'order-1', to: 'shop.example', rail: 'card' });
  clock.now += 1000;
  await hold.settlesBy(new Date(T0 + 600_000));
  clock.now += 1000;
  await hold.note('refused', 'the payee answered 402');
  clock.now += 1000;
  await hold.settle({ tx: TX });
  clock.now += 1000;
  const other = await budget.hold('$7', { settlesWithin: 60_000 });
  await other.void();
  await assert.rejects(budget.hold('$51', { details: { payTo: '0xpayee' } }), refusedFor('per_payment'));

  assert.deepEqual(kinds(decisions), ['held', 'bound', 'noted', 'settled', 'held', 'void', 'refused']);
  for (const decision of decisions) assert.deepEqual(Object.keys(decision), FIELDS, decision.decision);
  const order = { wallet: WALLET, amount: 5_000_000n, id: 'order-1', rail: 'card', to: 'shop.example' };
  const until = new Date(T0 + 600_000);
  assert.deepEqual(decisions.slice(0, 4).map(plain), [
    { ...NONE, decision: 'held', at: new Date(T0), ...order },
    { ...NONE, decision: 'bound', at: new Date(T0 + 1000), ...order, settlesBy: until },
    { ...NONE, decision: 'noted', at: new Date(T0 + 2000), ...order, settlesBy: until, outcome: 'refused' },
    { ...NONE, decision: 'settled', at: new Date(T0 + 3000), ...order, settlesBy: until, tx: TX },
  ]);
  const second = { wallet: WALLET, amount: 7_000_000n, id: other.id, rail: 'js', settlesBy: new Date(T0 + 4000 + 60_000) };
  assert.deepEqual(decisions.slice(4, 6).map(plain), [
    { ...NONE, decision: 'held', at: new Date(T0 + 4000), ...second },
    { ...NONE, decision: 'void', at: new Date(T0 + 4000), ...second },
  ]);
  assert.deepEqual(plain(decisions[6]), {
    ...NONE,
    decision: 'refused',
    at: new Date(T0 + 4000),
    wallet: WALLET,
    amount: 51_000_000n,
    rail: 'js',
    to: '0xpayee',
    code: 'per_payment',
    source: 'budget',
    brief: "$51.00 is over 0xd797…ca02's $50.00 limit per payment",
  });
  budget.close();
});

test('a refusal carries its code, its source and its brief, the amount asked, and no id', async () => {
  const { budget, decisions, path } = await fixture({ limits: { perDay: '$10', maxPayments: 2 } });
  const open = await budget.hold('$6');
  // Over the cap while a payment is open: the error's message names that payment for its owner, the brief doesn't.
  const over = await budget.hold('$5').catch(error => error);
  assert.ok(refusedFor('budget')(over));
  assert.ok(over.message.includes(open.id));
  // This process's own, tighter limit.
  const tighter = [];
  const careful = await openBudget({ wallet: WALLET, path, perPayment: '$2', onDecision: decision => tighter.push(decision) });
  await assert.rejects(careful.hold('$3'), refusedFor('per_payment'));
  await budget.hold('$1');
  await assert.rejects(budget.hold('$1'), refusedFor('max_payments'));
  const owner = await openOwner({ path });
  await owner.freeze(WALLET);
  await assert.rejects(budget.hold('$1'), refusedFor('frozen'));

  const refusals = [...decisions, ...tighter].filter(decision => decision.decision === 'refused');
  assert.deepEqual(
    refusals.map(({ code, source, amount, id }) => [code, source, amount, id]),
    [
      ['budget', 'budget', 5_000_000n, null],
      ['max_payments', 'budget', 1_000_000n, null],
      ['frozen', 'budget', 1_000_000n, null],
      ['per_payment', 'process', 3_000_000n, null],
    ],
  );
  assert.equal(refusals[0].brief, over.brief);
  assert.notEqual(refusals[0].brief, over.message);
  for (const refusal of refusals) assert.ok(!refusal.brief.includes(open.id), refusal.brief);
  assert.equal(refusals[3].brief, '$3.00 is over the $2.00 limit per payment this process set');
  for (const handle of [budget, careful, owner]) handle.close();
});

test('pay() is held then settled, and a throw is held then noted unknown, or void for notSent()', async () => {
  const { budget, decisions } = await fixture();
  assert.equal(await budget.pay('$5', async () => TX, { to: 'shop.example' }), TX);
  await assert.rejects(
    budget.pay('$6', async () => {
      throw new Error('socket hang up');
    }),
    /socket hang up/,
  );
  await assert.rejects(
    budget.pay('$7', async () => {
      throw notSent('card declined');
    }),
    /card declined/,
  );
  await assert.rejects(
    budget.pay('$500', async () => TX),
    refusedFor('per_payment'),
  );
  assert.deepEqual(
    decisions.map(({ decision, amount, outcome, tx }) => [decision, amount, outcome, tx]),
    [
      ['held', 5_000_000n, null, null],
      ['settled', 5_000_000n, null, TX],
      ['held', 6_000_000n, null, null],
      ['noted', 6_000_000n, 'unknown', null],
      ['held', 7_000_000n, null, null],
      ['void', 7_000_000n, null, null],
      ['refused', 500_000_000n, null, null],
    ],
  );
  // Each payment's decisions are about one id.
  assert.equal(decisions[0].id, decisions[1].id);
  assert.equal(decisions[2].id, decisions[3].id);
  assert.notEqual(decisions[0].id, decisions[2].id);
  budget.close();
});

test('a move already made is not decided again', async () => {
  const { budget, decisions } = await fixture();
  const hold = await budget.hold('$5');
  await hold.settlesWithin(60_000);
  await hold.settlesWithin(120_000);
  await hold.settle({ tx: TX });
  await hold.settle({ tx: TX });
  const other = await budget.hold('$5');
  await other.void();
  await other.void();
  assert.deepEqual(kinds(decisions), ['held', 'bound', 'settled', 'held', 'void']);
  budget.close();
});

test("check() reports nothing, and neither do reads or the owner's handle", async () => {
  const log = join(DIR, 'quiet.jsonl');
  const { budget, decisions, path } = await fixture({ log });
  const hold = await budget.hold('$5');
  assert.equal((await budget.check('$1')).ok, true);
  assert.equal((await budget.check('$500')).ok, false);
  await budget.status();
  await budget.history();
  await budget.holds();
  await budget.payment(hold.id);
  // The owner's handle moves the payment; it is the payer's handle that has a decision log.
  process.env.WALLETCAP_LOG = log;
  const owner = await openOwner({ path });
  await owner.settle(hold.id, { evidence: 'seen on chain' });
  await owner.status(WALLET);
  assert.deepEqual(kinds(decisions), ['held']);
  assert.equal(linesOf(log).length, 1);
  budget.close();
  owner.close();
});

test('a callback that throws changes nothing: the payment settles, the refusal is the same, and the handle warns once', async () => {
  const { budget: plainBudget, path } = await fixture();
  let calls = 0;
  let budget;
  const warnings = await warned(async () => {
    budget = await openBudget({
      wallet: WALLET,
      path,
      onDecision: decision => {
        calls += 1;
        // What a payee sent is in the error's message, as a careless callback would put it there.
        throw new TypeError(`cannot log ${decision.to}`);
      },
    });
    assert.equal(await budget.pay('$5', async () => TX, { to: 'shop\u001b[2J\n.example' }), TX);
    const refusal = await budget.hold('$500').catch(error => error);
    const expected = await plainBudget.hold('$500').catch(error => error);
    assert.ok(refusedFor('per_payment')(refusal));
    assert.deepEqual([refusal.message, refusal.code, refusal.source, refusal.brief], [expected.message, expected.code, expected.source, expected.brief]);
    const hold = await budget.hold('$6');
    await hold.void();
    assert.equal(hold.state, 'void');
  });
  assert.equal(calls, 5, 'the callback is still called for every decision');
  const status = await budget.status();
  assert.deepEqual([status.spent, status.inFlight, status.payments], [5_000_000n, 0n, 1n]);
  assert.equal(warnings.length, 1);
  assert.deepEqual([warnings[0].type, warnings[0].code], ['BudgetWarning', 'WALLETCAP_DECISION_LOG']);
  assert.match(warnings[0].message, /the onDecision callback failed \(TypeError\)/);
  // The warning names the error's class, never its message.
  assert.ok(!warnings[0].message.includes('shop'), warnings[0].message);
  budget.close();
  plainBudget.close();
});

test('an async callback is not waited for, and its rejection is swallowed with the same one warning', async () => {
  const rejections = [];
  const unhandled = reason => rejections.push(reason);
  process.on('unhandledRejection', unhandled);
  try {
    let never;
    const pending = await fixture({ onDecision: () => new Promise(() => {}) });
    // A callback whose promise never settles holds nothing up.
    assert.equal(await pending.budget.pay('$5', async () => TX), TX);
    pending.budget.close();
    const warnings = await warned(async () => {
      never = await fixture({
        onDecision: async () => {
          throw new RangeError('the metrics queue is full');
        },
      });
      assert.equal(await never.budget.pay('$5', async () => TX), TX);
      await assert.rejects(never.budget.hold('$500'), refusedFor('per_payment'));
      await turn();
    });
    await turn();
    assert.deepEqual(rejections, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /the onDecision callback failed \(RangeError\)/);
    assert.equal((await never.budget.status()).spent, 5_000_000n);
    never.budget.close();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});

test("a log file that can't be written changes nothing, and each handle warns once", async () => {
  // A file where the log's folder should be: the log can be neither created nor appended to.
  const blocker = join(DIR, 'not-a-folder');
  writeFileSync(blocker, '');
  const log = join(blocker, 'decisions.jsonl');
  let first;
  let second;
  const warnings = await warned(async () => {
    first = await fixture({ log });
    assert.equal(await first.budget.pay('$5', async () => TX), TX);
    await assert.rejects(first.budget.hold('$500'), refusedFor('per_payment'));
    assert.equal(await first.budget.pay('$5', async () => TX), TX);
    process.env.WALLETCAP_LOG = log;
    second = await openBudget({ wallet: WALLET, path: first.path });
    await assert.rejects(second.hold('$500'), refusedFor('per_payment'));
    await assert.rejects(second.hold('$500'), refusedFor('per_payment'));
  });
  // The callback is told all the same.
  assert.deepEqual(kinds(first.decisions), ['held', 'settled', 'refused', 'held', 'settled']);
  assert.equal((await first.budget.status()).spent, 10_000_000n);
  assert.equal(warnings.length, 2, 'one for each handle, not one for each payment');
  for (const warning of warnings) {
    assert.deepEqual([warning.type, warning.code], ['BudgetWarning', 'WALLETCAP_DECISION_LOG']);
    assert.ok(warning.message.includes(`the decision log ${log} can't be written`), warning.message);
  }
  first.budget.close();
  second.close();
});

test('a handle whose callback and whose file both fail warns once for each', async () => {
  const blocker = join(DIR, 'also-not-a-folder');
  writeFileSync(blocker, '');
  let both;
  const warnings = await warned(async () => {
    both = await fixture({
      log: join(blocker, 'decisions.jsonl'),
      onDecision: () => {
        throw new Error('broken');
      },
    });
    for (let i = 0; i < 3; i += 1) assert.equal(await both.budget.pay('$5', async () => TX), TX);
  });
  assert.equal((await both.budget.status()).spent, 15_000_000n);
  assert.deepEqual(warnings.map(warning => /callback|decision log/.exec(warning.message)?.[0]).sort(), ['callback', 'decision log']);
  both.budget.close();
});

test('WALLETCAP_LOG gets one JSON line per decision, in the shared key order, in a file created 0600', async () => {
  const log = join(DIR, 'logs', 'agent', 'decisions.jsonl');
  const { budget, decisions, clock, path } = await fixture({ log });
  await budget.pay('$5', async () => TX, { id: 'order-1', to: 'shop.example', settlesBy: new Date(T0 + 600_000) });
  clock.now += 1500;
  await assert.rejects(budget.hold('$51', { to: 'shop.example', rail: 'card' }), refusedFor('per_payment'));
  const hold = await budget.hold('$2');
  await hold.note('unknown');
  // A handle opened with no WALLETCAP_LOG writes nowhere.
  const unlogged = await openBudget({ wallet: WALLET, path });
  await unlogged.pay('$1', async () => TX);

  const lines = linesOf(log);
  assert.equal(lines.length, 5);
  assert.equal(decisions.length, 5);
  for (const [index, line] of lines.entries()) {
    assert.deepEqual(Object.keys(JSON.parse(line)), WIRE, line);
    // The line is the decision's own JSON: what toJSON() gives, kept out of the decision's keys.
    assert.deepEqual(JSON.parse(line), JSON.parse(JSON.stringify(decisions[index])));
  }
  // Written as JSON.stringify writes it, but in ASCII: the ellipsis in a wallet's short name is an escape.
  assert.equal(lines[0], JSON.stringify(decisions[0]));
  assert.ok(lines[2].includes(String.raw`0xd797\u2026ca02's $50.00 limit`), lines[2]);
  assert.deepEqual(JSON.parse(lines[1]), {
    decision: 'settled',
    at: '2027-01-15T08:00:00.000Z',
    wallet: WALLET,
    amount: '5000000',
    id: 'order-1',
    rail: 'js',
    to: 'shop.example',
    code: null,
    source: null,
    brief: null,
    outcome: null,
    settles_by: '2027-01-15T08:10:00.000Z',
    tx: TX,
  });
  assert.deepEqual(JSON.parse(lines[2]), {
    decision: 'refused',
    at: '2027-01-15T08:00:01.500Z',
    wallet: WALLET,
    amount: '51000000',
    id: null,
    rail: 'card',
    to: 'shop.example',
    code: 'per_payment',
    source: 'budget',
    brief: "$51.00 is over 0xd797…ca02's $50.00 limit per payment",
    outcome: null,
    settles_by: null,
    tx: null,
  });
  if (process.platform !== 'win32') {
    assert.equal(statSync(log).mode & 0o777, 0o600);
    // walletcap made both folders, so both are the owner's alone.
    assert.equal(statSync(dirname(log)).mode & 0o777, 0o700);
    assert.equal(statSync(dirname(dirname(log))).mode & 0o777, 0o700);
  }
  budget.close();
  unlogged.close();
});

test("a payee's text reaches the log as JSON only: a line stays one line of ASCII, and no control byte reaches the file", async () => {
  const log = join(DIR, 'hostile.jsonl');
  // A payee's name that tries to end the line, forge the next one and clear the terminal.
  const to = 'shop\r\n{"decision":"settled","amount":"1"}\u001b[2J\u0000\u0085\u2028 \ud83d';
  const { budget } = await fixture({ log });
  const hold = await budget.hold('$5', { to });
  await hold.settle({ tx: 'receipt\t\u0007' });
  await assert.rejects(budget.hold('$500', { to }), refusedFor('per_payment'));
  const raw = readFileSync(log);
  // Line feeds end the three lines, and nothing else in the file is outside printable ASCII: no
  // control code for a terminal, and no other character a reader could take for the end of a line.
  assert.equal(raw.filter(byte => byte === 0x0a).length, 3);
  assert.equal(raw.filter(byte => (byte < 0x20 || byte > 0x7e) && byte !== 0x0a).length, 0);
  const lines = linesOf(log);
  assert.deepEqual(
    lines.map(line => JSON.parse(line).decision),
    ['held', 'settled', 'refused'],
  );
  for (const line of lines) assert.equal(JSON.parse(line).to, to);
  assert.equal(JSON.parse(lines[1]).tx, 'receipt\t\u0007');
  budget.close();
});

test('WALLETCAP_LOG is read like WALLETCAP_PATH: ~/ is the home folder, and an empty value names no file', () => {
  assert.equal(decisionLogFile({ WALLETCAP_LOG: '~/walletcap/decisions.jsonl' }), join(homedir(), 'walletcap', 'decisions.jsonl'));
  assert.equal(decisionLogFile({ WALLETCAP_LOG: 'decisions.jsonl' }), resolve('decisions.jsonl'));
  assert.equal(decisionLogFile({ WALLETCAP_LOG: '' }), null);
  assert.equal(decisionLogFile({}), null);
});

test('onDecision must be a function', async () => {
  const path = join(DIR, `budget-${files++}.sqlite`);
  await assert.rejects(
    openBudget({ wallet: WALLET, path, create: true, perDay: '$1', onDecision: 'console.log' }),
    error => error instanceof UsageError && /onDecision must be a function/.test(error.message),
  );
});

test('handles in several processes append whole lines to one file', async () => {
  const log = join(DIR, 'shared.jsonl');
  const racing = join(DIR, 'racing');
  mkdirSync(racing);
  const limits = { perPayment: '$1', perDay: '$0.50' };
  // Three handles, thirty payments of a cent each against fifty cents: some are paid, the rest refused.
  const { budget, path, decisions } = await fixture({ log, limits });
  resetClock();
  process.env.WALLETCAP_LOG = log;
  const payments = Array.from({ length: 30 }, () => '$0.01');
  const outcomes = [];
  const [others] = await Promise.all([
    race('payer.mjs', racing, [
      { wallet: WALLET, path, limits, payments },
      { wallet: WALLET, path, limits, payments },
    ]),
    (async () => {
      for (const amount of payments) {
        outcomes.push(
          await budget
            .pay(amount, async () => 'paid')
            .catch(error => {
              if (!(error instanceof BudgetRefused)) throw error;
              return error.code;
            }),
        );
      }
    })(),
  ]);
  const all = [...outcomes, ...others.flatMap(other => other.results)];
  const paid = all.filter(outcome => outcome === 'paid').length;
  assert.equal(paid, 50);
  assert.equal(all.length, 90);
  const lines = linesOf(log).map(line => JSON.parse(line));
  for (const line of lines) assert.deepEqual(Object.keys(line), WIRE);
  // A payment is two lines, held and settled; a refusal is one.
  const count = kind => lines.filter(line => line.decision === kind).length;
  assert.deepEqual([count('held'), count('settled'), count('refused')], [paid, paid, all.length - paid]);
  assert.equal(lines.length, paid * 2 + (all.length - paid));
  assert.equal(decisions.length, outcomes.filter(outcome => outcome === 'paid').length * 2 + outcomes.filter(outcome => outcome !== 'paid').length);
  budget.close();
});

// --- The adapters ------------------------------------------------------------------------------

const X402_SKIP = kit === null && 'the x402 devDependencies are not installed';
// A scheme the guard doesn't count, registered on the real client so its terms reach the guard.
const OPAQUE = { scheme: 'opaque', createPaymentPayload: async version => ({ x402Version: version, payload: { signed: 'elsewhere' } }) };
const SETTLED = { success: true, transaction: TX, network: NETWORK };

/** The real x402 client, guarded, on a budget of ten cents, and how many payloads its wallet has signed. */
const guarded = async () => {
  // The exact scheme's validity is the wall clock's, so the ledger's clock starts there too.
  const state = await fixture({ now: Date.now(), wallet: kit.account.address, limits: { perPayment: '$0.05', perDay: '$0.10' } });
  const signed = { count: 0 };
  const sign = kit.account.signTypedData;
  const account = {
    ...kit.account,
    signTypedData: (...args) => {
      signed.count += 1;
      return sign(...args);
    },
  };
  const { x402Client } = await import('@x402/core/client');
  const { ExactEvmScheme } = await import('@x402/evm/exact/client');
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(account)).register(NETWORK, OPAQUE);
  client.setSpendControls(false); // x402's own default cap stays out of the measurement
  return { ...state, signed, client: guard(client, state.budget) };
};

test('the x402 guard reports a payment as held then settled, each once', { skip: X402_SKIP }, async () => {
  const { budget, decisions, client, clock, signed } = await guarded();
  const payload = await client.createPaymentPayload(kit.required(50_000));
  await client.handlePaymentResponse({ paymentPayload: payload, requirements: payload.accepted, settleResponse: SETTLED });
  const { from, nonce, validBefore } = payload.payload.authorization;
  const payment = {
    wallet: kit.account.address.toLowerCase(),
    amount: 50_000n,
    id: `eip3009:${from.toLowerCase()}:${nonce.toLowerCase()}`,
    rail: 'x402',
    to: PAY_TO,
    settlesBy: new Date(Number(validBefore) * 1000),
  };
  assert.equal(signed.count, 1);
  assert.deepEqual(decisions.map(plain), [
    { ...NONE, decision: 'held', at: new Date(clock.now), ...payment },
    { ...NONE, decision: 'settled', at: new Date(clock.now), ...payment, tx: TX },
  ]);
  budget.close();
});

test('the x402 guard reports what it refuses before signing, each once: over the budget, an asset, a scheme, a validity', {
  skip: X402_SKIP,
}, async () => {
  const { budget, decisions, client, clock, signed } = await guarded();
  for (let i = 0; i < 2; i += 1) await client.createPaymentPayload(kit.required(50_000));
  assert.equal(signed.count, 2);
  decisions.length = 0;
  // The ledger answered the guard's check(), which logs nothing itself: the guard reports it, dated by the ledger.
  clock.now += 5000;
  const over = await client.createPaymentPayload(kit.required(50_000)).catch(error => error);
  assert.ok(refusedFor('budget')(over));
  const unknown = '0x0000000000000000000000000000000000000bad';
  await assert.rejects(client.createPaymentPayload(kit.required(10_000, { asset: unknown })), refusedFor('asset'));
  await assert.rejects(client.createPaymentPayload(kit.required(10_000, { scheme: 'opaque' })), refusedFor('terms'));
  await assert.rejects(client.createPaymentPayload(kit.required(10_000, { maxTimeoutSeconds: 86_400 })), refusedFor('timeout'));
  await assert.rejects(client.createPaymentPayload(kit.required(60_000)), refusedFor('per_payment'));
  assert.equal(signed.count, 2, 'nothing more was signed');

  assert.deepEqual(
    decisions.map(({ decision, code, source, amount, id, rail, to }) => [decision, code, source, amount, id, rail, to]),
    [
      ['refused', 'budget', 'budget', 50_000n, null, 'x402', PAY_TO],
      // An asset the guard can't price has no amount in dollars.
      ['refused', 'asset', 'budget', null, null, 'x402', PAY_TO],
      // A scheme it doesn't count, in an asset it prices: the amount the terms asked.
      ['refused', 'terms', 'budget', 10_000n, null, 'x402', PAY_TO],
      ['refused', 'timeout', 'budget', 10_000n, null, 'x402', PAY_TO],
      ['refused', 'per_payment', 'budget', 60_000n, null, 'x402', PAY_TO],
    ],
  );
  assert.equal(decisions[0].brief, over.message);
  assert.deepEqual(decisions[0].at, new Date(clock.now));
  assert.match(decisions[1].brief, /cannot price 0x0000000000000000000000000000000000000bad/);
  assert.match(decisions[2].brief, /doesn't count the x402 scheme opaque/);
  budget.close();
});

test('a hold the budget refuses after signing is reported once, though the guard throws a copy of the refusal', { skip: X402_SKIP }, async () => {
  const { budget, decisions, client, path, signed } = await guarded();
  // Another process takes the room between the guard's check and its hold.
  const other = await openBudget({ wallet: kit.account.address, path });
  client.onBeforePaymentCreation(async () => {
    for (let i = 0; i < 2; i += 1) await other.hold('$0.05');
  });
  const refusal = await client.createPaymentPayload(kit.required(50_000)).catch(error => error);
  assert.ok(refusedFor('budget')(refusal));
  assert.equal(signed.count, 1, 'the check passed, so the wallet signed');
  assert.deepEqual(
    decisions.map(({ decision, code, amount, id, rail, to, brief }) => [decision, code, amount, id, rail, to, brief]),
    [['refused', 'budget', 50_000n, null, 'x402', PAY_TO, refusal.message]],
  );
  // The agent's copy, like the log's brief, names no other payment.
  assert.ok(!refusal.message.includes('wc-'), refusal.message);
  budget.close();
  other.close();
});

test("the Agentic Wallet wrapper reports each refusal once, its own and the budget's, and a payment as held, bound, settled", async () => {
  const { budget, decisions } = await fixture({ limits: { perPayment: '$0.05', perDay: '$0.15' } });
  const requirement = (overrides = {}) => ({
    scheme: 'exact',
    network: NETWORK,
    asset: USDC,
    amount: '50000',
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: 'USDC', version: '2' },
    ...overrides,
  });
  let offered = [requirement()];
  const answer = { status: 200, headers: { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, transaction: TX })).toString('base64') } };
  const wallet = guardAgenticWallet(budget, {
    request: async channel => (channel === 'send-transaction' ? { transactionHash: TX } : answer),
    discover: async () => offered,
  });
  const send = more => wallet.request('send-transaction', { recipient: PAY_TO, amountAtomic: '50000', chain: 'base-sepolia', ...more });
  const pay = more => wallet.request('make-x402-request', { baseURL: 'https://api.example', path: '/paid', method: 'GET', ...more });
  const seen = () => decisions.splice(0).map(({ decision, code, amount, id, rail, to }) => [decision, code, amount, id === null ? null : 'an id', rail, to]);

  // The budget's own refusal, through the wrapper's hold.
  await assert.rejects(send({ amountAtomic: '60000' }), refusedFor('per_payment'));
  assert.deepEqual(seen(), [['refused', 'per_payment', 60_000n, null, 'awal', PAY_TO]]);
  // The wrapper's, before any hold.
  await assert.rejects(send({ asset: 'ETH', chain: 'base' }), refusedFor('asset'));
  assert.deepEqual(seen(), [['refused', 'asset', null, null, 'awal', PAY_TO]]);
  offered = [requirement({ asset: '0x0000000000000000000000000000000000000bad' })];
  await assert.rejects(pay(), refusedFor('asset'));
  assert.deepEqual(seen(), [['refused', 'asset', null, null, 'awal-x402', PAY_TO]]);
  offered = [requirement({ maxTimeoutSeconds: 86_400 })];
  await assert.rejects(pay(), refusedFor('timeout'));
  assert.deepEqual(seen(), [['refused', 'timeout', 50_000n, null, 'awal-x402', PAY_TO]]);
  offered = [requirement({ scheme: 'batch-settlement' })];
  await assert.rejects(pay(), refusedFor('terms'));
  assert.deepEqual(seen(), [['refused', 'terms', 50_000n, null, 'awal-x402', PAY_TO]]);
  offered = [];
  await assert.rejects(pay(), refusedFor('terms'));
  assert.deepEqual(seen(), [['refused', 'terms', null, null, 'awal-x402', null]]);
  offered = [requirement()];
  await assert.rejects(pay({ maxAmountPerRequest: 1 }), refusedFor('per_payment'));
  assert.deepEqual(seen(), [['refused', 'per_payment', 50_000n, null, 'awal-x402', PAY_TO]]);

  await pay();
  assert.deepEqual(seen(), [
    ['held', null, 50_000n, 'an id', 'awal-x402', PAY_TO],
    ['bound', null, 50_000n, 'an id', 'awal-x402', PAY_TO],
    ['settled', null, 50_000n, 'an id', 'awal-x402', PAY_TO],
  ]);
  await send();
  assert.deepEqual(seen(), [
    ['held', null, 50_000n, 'an id', 'awal', PAY_TO],
    ['settled', null, 50_000n, 'an id', 'awal', PAY_TO],
  ]);
  budget.close();
});

test('the CDP store reports each refusal once: an asset it does not count, and a hold the budget refuses', async () => {
  const { budget, decisions } = await fixture({ limits: { perDay: '$1' } });
  const store = cdpStore(budget, { asset: USDC });
  const entry = { atomicAmount: 600_000n, asset: USDC, network: NETWORK, payTo: PAY_TO, at: Date.now() };
  await store.append(entry);
  await assert.rejects(store.append({ ...entry, asset: '0x0000000000000000000000000000000000000bad' }), refusedFor('asset'));
  // The cap, with a payment open: the store throws the agent's copy of the budget's refusal.
  const over = await store.append(entry).catch(error => error);
  assert.ok(refusedFor('budget')(over));
  assert.deepEqual(
    decisions.map(({ decision, code, amount, rail, to, brief }) => [decision, code, amount, rail, to, brief]),
    [
      ['held', null, 600_000n, 'cdp', PAY_TO, null],
      ['refused', 'asset', null, 'cdp', PAY_TO, `this CDP store counts ${USDC.toLowerCase()}, not 0x0000000000000000000000000000000000000bad`],
      ['refused', 'budget', 600_000n, 'cdp', PAY_TO, over.message],
    ],
  );
  budget.close();
});
