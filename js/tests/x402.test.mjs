// SPDX-License-Identifier: Apache-2.0
// The guard on x402's real client (@x402/core 2.28.0 with the exact EVM scheme).
// Payloads are signed offline; a server's answer is handed to the client's own
// handlePaymentResponse, as @x402/fetch does. Nothing is sent.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { resetClock, setClock } from '../_clock.mjs';
import { BudgetRefused, openBudget } from '../index.mjs';
import { NETWORK, PAY_TO, USDC, x402 } from './support/x402-kit.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'walletcap-x402-'));
after(() => rmSync(DIR, { recursive: true, force: true }));
afterEach(resetClock);
const kit = await x402();
const DAY = 86_400_000;
const TX = `0x${'cd'.repeat(32)}`;
let files = 0;

const setup = (limits = { perPayment: '$0.05', perDay: '$0.15' }) => {
  const clock = { now: Date.now() };
  setClock(() => clock.now);
  const path = join(DIR, `x402-${files++}.sqlite`);
  const budget = openBudget({ wallet: kit.account.address, path, create: true, ...limits });
  return { budget, clock, path, client: budget.guard(kit.client()) };
};
const settled = { success: true, transaction: TX, network: NETWORK };
const pay = async (client, atomic, answer = { settleResponse: settled }) => {
  const payload = await client.createPaymentPayload(kit.required(atomic));
  await client.handlePaymentResponse({ paymentPayload: payload, requirements: payload.accepted, ...answer });
  return payload;
};
const refusedFor = reason => error => error instanceof BudgetRefused && error.reason === reason;

test('settled x402 payments count, and the next one past the cap is refused before it is signed', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { budget, client } = setup();
  for (let i = 0; i < 3; i += 1) await pay(client, 50_000);
  await assert.rejects(pay(client, 50_000), refusedFor('budget'));
  await assert.rejects(pay(client, 1_000_000), refusedFor('per_payment'));
  const status = budget.status();
  assert.equal(status.spent, 150_000n);
  assert.equal(status.inFlight, 0n);
  const [newest] = budget.history();
  assert.deepEqual([newest.status, newest.tx, newest.to, newest.rail], ['settled', TX, PAY_TO, 'x402']);
});

test('a payee that says the payment failed still holds the authorization, so it counts until that expires', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { budget, client, clock } = setup();
  const payload = await pay(client, 50_000, { paymentRequired: kit.required(50_000) });
  assert.equal(budget.status().inFlight, 50_000n);
  assert.equal(budget.history()[0].status, 'refused');
  const validBefore = Number(payload.payload.authorization.validBefore) * 1000;
  clock.now = validBefore + DAY;
  assert.equal(budget.status().inFlight, 50_000n);
  clock.now += 1;
  assert.equal(budget.status().inFlight, 0n);
});

test('a lost answer keeps the payment counting, and a cloned payload is still recognized', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { budget, client } = setup();
  await pay(client, 50_000, { error: new Error('socket hang up') });
  assert.equal(budget.history()[0].status, 'unknown');
  const payload = await client.createPaymentPayload(kit.required(50_000));
  const echoed = JSON.parse(JSON.stringify(payload));
  await client.handlePaymentResponse({ paymentPayload: echoed, requirements: echoed.accepted, settleResponse: settled });
  const status = budget.status();
  assert.equal(status.inFlight, 50_000n);
  assert.equal(status.spent, 50_000n);
});

test('a later control that aborts or fails leaves nothing reserved', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const aborted = setup();
  // Coinbase's CDP controls pin their before-hook last, after this guard's check.
  aborted.client.onBeforePaymentCreation(async () => ({ abort: true, reason: 'another control' }));
  await assert.rejects(pay(aborted.client, 50_000), /another control/);
  assert.equal(aborted.budget.status().payments, 0n);

  const failed = setup();
  failed.client.onAfterPaymentCreation(async () => { throw new Error('a later hook failed'); });
  await assert.rejects(pay(failed.client, 50_000), /a later hook failed/);
  assert.equal(failed.budget.status().payments, 0n);
});

test('an asset the budget cannot price is refused, and a priced one is chosen when offered', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { budget, client } = setup();
  const unknown = '0x0000000000000000000000000000000000000bad';
  await assert.rejects(client.createPaymentPayload(kit.required(1, { asset: unknown })), error => refusedFor('asset')(error) && error.message.includes('decimals: 6'));
  const offer = kit.required(10_000);
  offer.accepts.unshift({ ...offer.accepts[0], asset: unknown });
  const payload = await client.createPaymentPayload(offer);
  assert.equal(payload.accepted.asset, USDC);
  assert.equal(budget.status().inFlight, 10_000n);
});

test('a stablecoin added with its decimals is counted in dollars, rounded up', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const dai = '0x00000000000000000000000000000000000000da';
  const budget = openBudget({ wallet: kit.account.address, path: join(DIR, 'decimals.sqlite'), perDay: '$1', create: true });
  const client = budget.guard(kit.client(), { assets: [{ network: NETWORK, asset: dai, decimals: 18 }] });
  await client.createPaymentPayload(kit.required('100000000000000001', { asset: dai })); // $0.100000000000000001
  assert.equal(budget.status().inFlight, 100_001n);
});

test('a restarted process with a new client finds the same count', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { path, client, budget } = setup();
  for (let i = 0; i < 3; i += 1) await pay(client, 50_000);
  budget.close();
  const restarted = openBudget({ wallet: kit.account.address, path, perPayment: '$2.50', perDay: '$5', onWarning: () => {} });
  await assert.rejects(pay(restarted.guard(kit.client()), 50_000), refusedFor('budget'));
});

test('a server cannot block a payment with an oversized resource URL', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { budget, client } = setup();
  const required = kit.required(10_000);
  required.resource.url = `https://api.example/${'x'.repeat(5_000)}`;
  await client.createPaymentPayload(required);
  assert.equal(budget.status().inFlight, 10_000n);
  assert.equal(budget.history()[0].note.length, 1024);
});

test('a client is guarded once, and only an x402 client can be', { skip: kit === null && 'the x402 devDependencies are not installed' }, () => {
  const { budget, client } = setup();
  assert.throws(() => budget.guard(client), /already has a budget guard/);
  assert.throws(() => budget.guard({}), /x402Client from @x402\/core/);
});
