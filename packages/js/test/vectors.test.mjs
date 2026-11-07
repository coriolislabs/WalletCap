// SPDX-License-Identifier: Apache-2.0
// spec/vectors/ledger.json: the admission sequences the Python suite runs too
// (tests/test_vectors.py), against this package's ledger client.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { resetClock, setClock } from '../dist/core/_clock.js';
import { BudgetRefused, UsageError } from '../dist/core/errors.js';
import { Ledger } from '../dist/core/ledger.js';

const VECTORS = JSON.parse(readFileSync(new URL('../../../spec/vectors/ledger.json', import.meta.url), 'utf8'));
const DIR = mkdtempSync(join(tmpdir(), 'walletcap-vectors-'));
after(() => rmSync(DIR, { recursive: true, force: true }));
afterEach(resetClock);

const big = value => (value === undefined || value === null ? null : BigInt(value));
const outcome = async (work, expect, check) => {
  let result;
  try {
    result = await work();
  } catch (error) {
    if (expect.refused !== undefined && error instanceof BudgetRefused) {
      assert.deepEqual({ refused: error.code, source: error.source, brief: error.brief },
        { refused: expect.refused, source: expect.source, brief: expect.brief });
      return;
    }
    if (expect.error === 'usage' && error instanceof UsageError) return;
    throw error;
  }
  assert.equal(expect.refused ?? expect.error, undefined, `expected ${JSON.stringify(expect)}, got ${JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? String(v) : v))}`);
  check(result);
};

for (const [index, vector] of VECTORS.cases.entries()) {
  test(`vector: ${vector.name}`, async () => {
    let now = BigInt(VECTORS.start);
    setClock(() => now);
    const ledger = await Ledger.open(join(DIR, `vector-${index}.sqlite`), { create: true });
    const wallet = VECTORS.wallet;
    const { budget } = vector;
    await ledger.createBudget(wallet, {
      cap: big(budget.cap), windowMs: big(budget.window_ms), perPayment: big(budget.per_payment), maxPayments: big(budget.max_payments),
    });
    try {
      for (const [n, step] of vector.steps.entries()) {
        const expect = step.expect ?? {};
        const at = `step ${n} (${step.op})`;
        const until = step.until_from_now === undefined ? null : now + BigInt(step.until_from_now);
        switch (step.op) {
          case 'advance': now += BigInt(step.ms); break;
          case 'freeze': await ledger.freeze(wallet); break;
          case 'unfreeze': await ledger.unfreeze(wallet); break;
          case 'hold': {
            const limits = step.limits ?? {};
            await outcome(() => ledger.hold(wallet, BigInt(step.amount), {
              payment: step.id ?? null, until, withinMs: big(step.within_ms), rail: 'vector',
              limits: { perPayment: big(limits.per_payment), cap: big(limits.cap), windowMs: big(limits.window_ms), maxPayments: big(limits.max_payments) },
            }), expect, held => { if (expect.held !== '*') assert.equal(held.payment, expect.held, at); });
            break;
          }
          case 'settle': await outcome(() => ledger.settle(step.id, { evidence: step.evidence ?? null }), expect, row => assert.equal(row.state, expect.state, at)); break;
          case 'void': await outcome(() => ledger.void(step.id), expect, row => assert.equal(row.state, expect.state, at)); break;
          case 'note': await outcome(() => ledger.note(step.id, step.outcome, { evidence: step.evidence ?? null }), expect, row => assert.equal(row.state, expect.state, at)); break;
          case 'bound': await outcome(() => ledger.bound(step.id, { until, withinMs: big(step.within_ms) }), expect, row => assert.equal(row.state, expect.state, at)); break;
          case 'set_limits': await outcome(() => ledger.setLimits(wallet, {
            ...(step.cap === undefined ? {} : { cap: BigInt(step.cap) }), ...(step.window_ms === undefined ? {} : { windowMs: BigInt(step.window_ms) }),
          }), expect, () => {}); break;
          case 'void_unknown': assert.deepEqual((await ledger.voidUnknown(wallet, BigInt(step.older_than_ms))).map(row => row.payment), expect.voided, at); break;
          case 'holds': assert.deepEqual((await ledger.counting(wallet, { heldOnly: true })).map(row => row.payment), expect.ids, at); break;
          case 'status': {
            const s = await ledger.status(wallet);
            const got = { spent: s.spent, in_flight: s.in_flight, remaining: s.remaining, payments: s.payments, frozen: s.frozen_at !== null, cap: s.cap, window_ms: s.window_ms };
            for (const [key, value] of Object.entries(expect)) assert.equal(got[key], typeof value === 'number' ? BigInt(value) : value, `${at}: ${key}`);
            break;
          }
          default: throw new Error(`unknown op ${step.op}`);
        }
      }
    } finally {
      ledger.close();
    }
  });
}
