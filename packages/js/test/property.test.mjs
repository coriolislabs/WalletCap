// SPDX-License-Identifier: Apache-2.0
// Random sequences of holds, settlements, voids, bounds, notes, owner changes and clock moves,
// run against the ledger (spec/schema.sql through this package's client) and against a small
// model of spec/ledger.md written here from the spec, not from the SQL. After every step they must
// agree on what was admitted or refused, and why, on the budget's status, and on every payment's
// state. The Python suite runs the same kind of test with Hypothesis (tests/test_property.py).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import fc from 'fast-check';
import { resetClock, setClock } from '../dist/core/_clock.js';
import { BudgetRefused, UsageError } from '../dist/core/errors.js';
import { Ledger } from '../dist/core/ledger.js';

const DIR = mkdtempSync(join(tmpdir(), 'walletcap-property-'));
// Windows keeps a budget file a test left open; its temp folder is cleared later.
after(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* open on Windows */
  }
});
afterEach(resetClock);

const WALLET = '0xd797ead28c38575fdf4fc523866287372340ca02';
const START = 1_800_000_000_000;
const UNBOUNDED_HOLD_MS = 3_660_000;

// --- The model: spec/ledger.md, in plain JavaScript numbers ------------------------------------

class Model {
  constructor(limits) {
    this.now = START;
    Object.assign(this, { cap: limits.cap, window: limits.window, perPayment: limits.perPayment, maxPayments: limits.maxPayments });
    this.frozen = false;
    this.payments = new Map(); // id -> { amount, state, heldAt, until, settledAt, outcome, order }
    this.order = 0;
  }

  // The moment a payment's window counts back to, or null when it counts for nothing.
  static countsFrom(p) {
    if (p.state === 'void') return null;
    if (p.state === 'held') return p.until === null ? Number.POSITIVE_INFINITY : Math.max(p.until, p.heldAt);
    return Math.max(p.settledAt, p.until ?? p.settledAt, p.heldAt);
  }

  counting(window = this.window) {
    return [...this.payments.values()].filter(p => {
      const from = Model.countsFrom(p);
      return from !== null && from >= this.now - window;
    });
  }

  verdict(amount, limits) {
    const counting = this.counting();
    const counted = counting.reduce((sum, p) => sum + p.amount, 0);
    const room =
      this.frozen || (this.maxPayments !== null && counting.length >= this.maxPayments)
        ? 0
        : Math.max(0, Math.min(this.cap - counted, this.perPayment ?? this.cap - counted));
    if (amount > room) {
      if (this.frozen) return { code: 'frozen', source: 'budget' };
      if (this.perPayment !== null && amount > this.perPayment) return { code: 'per_payment', source: 'budget' };
      if (counted + amount > this.cap) return { code: 'budget', source: 'budget' };
      return { code: 'max_payments', source: 'budget' };
    }
    const own = this.counting(limits.windowMs ?? this.window);
    const ownCounted = own.reduce((sum, p) => sum + p.amount, 0);
    if (limits.perPayment != null && amount > limits.perPayment) return { code: 'per_payment', source: 'process' };
    if (limits.cap != null && ownCounted + amount > limits.cap) return { code: 'budget', source: 'process' };
    if (limits.maxPayments != null && own.length >= limits.maxPayments) return { code: 'max_payments', source: 'process' };
    return null;
  }

  hold({ id, amount, until, within, limits, rail }) {
    const existing = id === null ? undefined : this.payments.get(id);
    // An id is one payment, held once: an existing id is refused, whatever its state.
    if (existing !== undefined) return { usage: true };
    if (until !== null && until <= this.now) return { usage: true };
    const refused = this.verdict(amount, limits);
    if (refused !== null) return { refused };
    const payment = {
      amount,
      rail,
      state: 'held',
      heldAt: this.now,
      lastAt: this.now,
      until: until ?? (within === null ? null : this.now + within),
      settledAt: null,
      outcome: null,
      order: this.order++,
    };
    return { ok: true, payment };
  }

  settle(id) {
    const p = this.payments.get(id);
    if (p === undefined) return { usage: true };
    if (p.state !== 'settled') Object.assign(p, { state: 'settled', settledAt: this.now });
    return { ok: true };
  }

  void(id) {
    const p = this.payments.get(id);
    if (p === undefined || p.state === 'settled') return { usage: true };
    p.state = 'void';
    return { ok: true };
  }

  bound(id, until) {
    const p = this.payments.get(id);
    if (p === undefined) return { usage: true };
    if (p.state !== 'held' || p.until !== null) return { ok: true };
    if (until <= this.now) return { usage: true };
    p.until = until;
    return { ok: true };
  }

  note(id, outcome) {
    const p = this.payments.get(id);
    if (p === undefined) return { usage: true };
    // A note on a held payment is an entry: the bulk release's hour and a minute counts from it.
    if (p.state === 'held') Object.assign(p, { outcome, lastAt: this.now });
    return { ok: true };
  }

  setLimits(change) {
    if (change.window !== undefined && change.window !== this.window && this.counting().length > 0) return { usage: true };
    Object.assign(this, change);
    return { ok: true };
  }

  voidUnknown(olderThan) {
    const voided = [...this.payments.entries()]
      .filter(
        ([, p]) =>
          p.state === 'held' &&
          (p.outcome === 'unknown' || p.outcome === 'refused') &&
          p.heldAt <= this.now - olderThan &&
          // With no until, only an x402 hold has a bound: its authorization lasts an hour at most.
          (p.until !== null ? p.until <= this.now : p.rail === 'x402' && p.lastAt <= this.now - UNBOUNDED_HOLD_MS),
      )
      .sort(([, a], [, b]) => a.order - b.order);
    for (const [, p] of voided) p.state = 'void';
    return voided.map(([id]) => id);
  }

  status() {
    const counting = this.counting();
    const sum = state => counting.filter(p => p.state === state).reduce((total, p) => total + p.amount, 0);
    const counted = counting.reduce((total, p) => total + p.amount, 0);
    return { spent: sum('settled'), inFlight: sum('held'), payments: counting.length, remaining: this.frozen ? 0 : Math.max(this.cap - counted, 0) };
  }

  holds() {
    return [...this.payments.entries()]
      .filter(([, p]) => p.state === 'held' && this.counting().includes(p))
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([id]) => id);
  }
}

// --- The operations ------------------------------------------------------------------------

const amount = fc.constantFrom(1, 10, 25, 40, 41, 50, 60, 100, 101);
const pick = fc.nat({ max: 7 });
const limits = fc.record({
  perPayment: fc.option(fc.constantFrom(10, 30, 50), { nil: null }),
  cap: fc.option(fc.constantFrom(20, 60, 100), { nil: null }),
  windowMs: fc.option(fc.constantFrom(300, 1000, 5000), { nil: null }),
  maxPayments: fc.option(fc.constantFrom(1, 2, 3), { nil: null }),
});
const op = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      op: fc.constant('hold'),
      id: fc.option(fc.constantFrom('a', 'b', 'c', 'd'), { nil: null }),
      amount,
      until: fc.option(fc.integer({ min: -2, max: 3000 }), { nil: null }),
      within: fc.option(fc.constantFrom(1, 400, 2000), { nil: null }),
      limits: fc.option(limits, { nil: null }),
      rail: fc.constantFrom('x402', 'js'),
    }),
  },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('settle'), pick }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('void'), pick }) },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('bound'),
      pick,
      until: fc.option(fc.integer({ min: -2, max: 3000 }), { nil: null }),
      within: fc.constantFrom(1, 700, 4000),
    }),
  },
  { weight: 4, arbitrary: fc.record({ op: fc.constant('note'), pick, outcome: fc.constantFrom('unknown', 'refused') }) },
  // Steps that land on a window's edge as often as past it: the counting rule is inclusive there.
  {
    weight: 5,
    arbitrary: fc.record({
      op: fc.constant('advance'),
      ms: fc.constantFrom(1, 299, 300, 301, 500, 999, 1000, 1001, 2000, 2001, 2500, UNBOUNDED_HOLD_MS, UNBOUNDED_HOLD_MS + 1),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant('limits'),
      change: fc.oneof(
        fc.record({ cap: fc.constantFrom(0, 50, 100, 200) }),
        fc.record({ window: fc.constantFrom(500, 1000, 2000) }),
        fc.record({ maxPayments: fc.constantFrom(null, 2, 4) }),
      ),
    }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constantFrom('freeze', 'unfreeze') }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('voidUnknown'), olderThan: fc.constantFrom(0, 500, 5000) }) },
);
const budgetLimits = fc.record({
  cap: fc.constantFrom(100, 150),
  window: fc.constantFrom(1000, 2000),
  perPayment: fc.option(fc.constantFrom(40, 100), { nil: null }),
  maxPayments: fc.option(fc.constantFrom(3, 5), { nil: null }),
});

// What the ledger did, in the model's terms.
const outcomeOf = async work => {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof BudgetRefused) return { refused: { code: error.code, source: error.source } };
    if (error instanceof UsageError) return { usage: true };
    throw error;
  }
};
const big = value => (value === null || value === undefined ? null : BigInt(value));
let runs = 0;

test('the ledger and the model of spec/ledger.md agree on every step of random histories', async () => {
  await fc.assert(
    fc.asyncProperty(budgetLimits, fc.array(op, { minLength: 20, maxLength: 80 }), async (start, ops) => {
      const model = new Model(start);
      setClock(() => model.now);
      const ledger = await Ledger.open(join(DIR, `property-${runs++}.sqlite`), { create: true });
      try {
        await ledger.createBudget(WALLET, {
          cap: big(start.cap),
          windowMs: big(start.window),
          perPayment: big(start.perPayment),
          maxPayments: big(start.maxPayments),
        });
        const known = [];
        const holders = new Map();
        const target = n => (known.length === 0 || n === 7 ? 'missing' : known[n % known.length]);
        for (const [index, step] of ops.entries()) {
          const where = `step ${index}: ${JSON.stringify(step)}`;
          let expected;
          let actual;
          if (step.op === 'hold') {
            const until = step.until === null ? null : model.now + step.until;
            const within = until === null ? step.within : null;
            const own = step.limits ?? {};
            expected = model.hold({ id: step.id, amount: step.amount, until, within, limits: own, rail: step.rail });
            actual = await outcomeOf(() =>
              ledger.hold(WALLET, BigInt(step.amount), {
                payment: step.id,
                rail: step.rail,
                until: big(until),
                withinMs: big(within),
                limits: { perPayment: big(own.perPayment), cap: big(own.cap), windowMs: big(own.windowMs), maxPayments: big(own.maxPayments) },
              }),
            );
            if (actual.ok) {
              model.payments.set(actual.value.payment, expected.payment);
              known.push(actual.value.payment);
              holders.set(actual.value.payment, actual.value.holder);
            }
            if (actual.ok) actual = { ok: true };
          } else if (['settle', 'void', 'note', 'bound'].includes(step.op)) {
            const id = target(step.pick);
            if (step.op === 'settle') expected = model.settle(id);
            if (step.op === 'void') expected = model.void(id);
            if (step.op === 'note') expected = model.note(id, step.outcome);
            const until = step.op === 'bound' ? (step.until === null ? model.now + step.within : model.now + step.until) : null;
            if (step.op === 'bound') expected = model.bound(id, until);
            actual = await outcomeOf(() => {
              const holder = holders.get(id) ?? null;
              if (step.op === 'settle') return ledger.settle(id, { holder });
              if (step.op === 'void') return ledger.void(id, { holder });
              if (step.op === 'note') return ledger.note(id, step.outcome, { holder });
              return step.until === null ? ledger.bound(id, { withinMs: BigInt(step.within), holder }) : ledger.bound(id, { until: BigInt(until), holder });
            });
            if (actual.ok) actual = { ok: true };
          } else if (step.op === 'advance') {
            model.now += step.ms;
            expected = actual = { ok: true };
          } else if (step.op === 'limits') {
            expected = model.setLimits(step.change);
            const { cap, window, maxPayments } = step.change;
            actual = await outcomeOf(() =>
              ledger.setLimits(WALLET, {
                ...(cap === undefined ? {} : { cap: BigInt(cap) }),
                ...(window === undefined ? {} : { windowMs: BigInt(window) }),
                ...(maxPayments === undefined ? {} : { maxPayments: big(maxPayments) }),
              }),
            );
            if (actual.ok) actual = { ok: true };
          } else if (step.op === 'freeze' || step.op === 'unfreeze') {
            model.frozen = step.op === 'freeze';
            await ledger[step.op](WALLET);
            expected = actual = { ok: true };
          } else {
            expected = { voided: model.voidUnknown(step.olderThan) };
            actual = { voided: (await ledger.voidUnknown(WALLET, BigInt(step.olderThan))).map(row => row.payment) };
          }
          const { payment: _payment, ...comparable } = expected;
          assert.deepEqual(actual, comparable, where);
          const status = await ledger.status(WALLET);
          assert.deepEqual(
            { spent: Number(status.spent), inFlight: Number(status.in_flight), payments: Number(status.payments), remaining: Number(status.remaining) },
            model.status(),
            where,
          );
          for (const id of known) assert.equal((await ledger.payment(id)).state, model.payments.get(id).state, `${where}: ${id}`);
          assert.deepEqual(
            (await ledger.counting(WALLET, { heldOnly: true })).map(row => row.payment),
            model.holds(),
            where,
          );
        }
      } finally {
        ledger.close();
      }
    }),
    { numRuns: 300 },
  );
  assert.ok(runs >= 300, `only ${runs} runs`);
});
