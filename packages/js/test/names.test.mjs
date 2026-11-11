// SPDX-License-Identifier: Apache-2.0
// spec/vectors/names.json: the public names both packages share. The Python suite checks the same
// list in snake_case (packages/python/tests/test_names.py).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { resetClock, setClock } from '../dist/core/_clock.js';

// Looked up by name, so taken as one object.
const walletcap = { ...(await import('../dist/index.js')) };
const NAMES = JSON.parse(readFileSync(new URL('../../../spec/vectors/names.json', import.meta.url), 'utf8'));
const DIR = mkdtempSync(join(tmpdir(), 'walletcap-names-'));
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
const sorted = keys => [...keys].sort();

test('the package exports every shared name', () => {
  for (const name of NAMES.exports) assert.ok(name in walletcap, name);
});

test('the handles have the shared methods and properties', () => {
  for (const [name, methods] of Object.entries(NAMES.methods)) {
    for (const method of methods) assert.equal(typeof walletcap[name].prototype[method], 'function', `${name}.${method}`);
  }
  for (const [name, properties] of Object.entries(NAMES.properties)) {
    if (name === 'Status') continue; // a field of a plain object here, checked below
    for (const property of properties) {
      assert.ok(Object.getOwnPropertyDescriptor(walletcap[name].prototype, property)?.get, `${name}.${property}`);
    }
  }
});

test('the objects the API returns have the shared fields, and no others', async () => {
  const path = join(DIR, 'fields.sqlite');
  const owner = await walletcap.openOwner({ path, create: true });
  await owner.setLimits(WALLET, { perDay: '$150' });
  // Two hours ago: an x402 payment that failed, whose authorization has since expired.
  const now = Date.now();
  setClock(() => now - 7_200_000);
  const decisions = [];
  const budget = await walletcap.openBudget({ wallet: WALLET, path, onDecision: decision => decisions.push(decision) });
  const stale = await budget.hold('$4', { rail: 'x402', settlesBy: new Date(now - 3_600_000) });
  await stale.note('unknown', 'receipt timeout');
  resetClock();
  await budget.pay('$5', async () => `0x${'ab'.repeat(32)}`);
  const held = await budget.hold('$3', { settlesWithin: 600_000 });
  const objects = {
    Check: await budget.check('$1'),
    Status: await budget.status(),
    Payment: (await budget.history())[0],
    PaymentRecord: await owner.payment(held.id),
    HeldPayment: (await budget.holds())[0],
    BudgetLimits: (await owner.budgets())[0],
    VoidedPayment: (await owner.voidUnknown(WALLET, { olderThan: '1h' }))[0],
    Decision: decisions[0],
  };
  for (const [name, fields] of Object.entries(NAMES.fields)) {
    const expected = name === 'Status' ? [...fields, ...NAMES.properties.Status] : fields;
    assert.deepEqual(sorted(Object.keys(objects[name])), sorted(expected), name);
  }
  budget.close();
  owner.close();
});

test('the errors carry the shared fields', () => {
  const refused = new walletcap.BudgetRefused('budget', 'over');
  for (const field of NAMES.errors.BudgetRefused) assert.ok(field in refused, `BudgetRefused.${field}`);
  const lost = new walletcap.PaymentNotRecorded('wc-1', { cause: new Error('locked') });
  for (const field of NAMES.errors.PaymentNotRecorded) assert.ok(field in lost, `PaymentNotRecorded.${field}`);
});

test('every shared option is one the call takes, and an unknown one is refused', async () => {
  const path = join(DIR, 'options.sqlite');
  const owner = await walletcap.openOwner({ path, create: true });
  await owner.setLimits(WALLET, { perDay: '$150' });
  const budget = await walletcap.openBudget({ wallet: WALLET, path });
  const unknown = error => error instanceof walletcap.UsageError && /unknown option/.test(error.message);
  // A wrong value may be refused, but never as an unknown option.
  const takes = async (call, key) => {
    try {
      await call({ [key]: Symbol('wrong') });
    } catch (error) {
      assert.ok(!unknown(error), `${key}: ${error.message}`);
    }
  };
  for (const key of NAMES.options.openBudget) await takes(options => walletcap.openBudget({ wallet: WALLET, path, ...options }), key);
  for (const key of NAMES.options.openOwner) await takes(options => walletcap.openOwner({ path, ...options }), key);
  for (const key of NAMES.options.hold) await takes(options => budget.hold('$1', options), key);
  for (const key of NAMES.options.setLimits) await takes(options => owner.setLimits(WALLET, options), key);
  for (const key of NAMES.options.voidUnknown) await takes(options => owner.voidUnknown(WALLET, options), key);
  await assert.rejects(budget.hold('$1', { settlesWithinMs: 1000 }), unknown);
  await assert.rejects(walletcap.openBudget({ wallet: WALLET, path, busyTimeoutSeconds: 1 }), unknown);
  budget.close();
  owner.close();
});

test('the string unions match the shared values', () => {
  const declared = (file, type) => {
    const text = readFileSync(new URL(`../dist/core/${file}`, import.meta.url), 'utf8');
    const match = new RegExp(`export type ${type} = ([^;]+);`).exec(text);
    assert.ok(match, `${type} in ${file}`);
    return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  };
  assert.deepEqual(declared('errors.d.ts', 'RefusalCode'), NAMES.values.RefusalCode);
  assert.deepEqual(declared('errors.d.ts', 'RefusalSource'), NAMES.values.RefusalSource);
  assert.deepEqual(declared('ledger.d.ts', 'PaymentState'), NAMES.values.PaymentState);
  assert.deepEqual(declared('ledger.d.ts', 'Outcome'), NAMES.values.Outcome);
});
