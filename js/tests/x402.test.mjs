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
import { BudgetError, BudgetRefused, MAX_PAYMENT_TIMEOUT_SECONDS, openBudget, PaymentNotRecorded } from '../index.mjs';
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

const DAI = '0x00000000000000000000000000000000000000da';

test('an asset override adds a USD stablecoin, and cannot reprice a built-in one', { skip: kit === null && 'the x402 devDependencies are not installed' }, () => {
  const { budget } = setup();
  // 0.2.x took any decimals up to 36, for any asset: USDC at 18 decimals counted $1 as 0.000001 of a cent.
  assert.throws(() => budget.guard(kit.client(), { assets: [{ network: NETWORK, asset: USDC, decimals: 18 }] }), /already priced with 6 decimals/);
  assert.throws(() => budget.guard(kit.client(), { assets: [{ network: 'base-sepolia', asset: USDC.toLowerCase(), decimals: 0 }] }), /already priced with 6 decimals/);
  for (const decimals of [19, 36, -1, 1.5, '6', undefined]) {
    assert.throws(() => budget.guard(kit.client(), { assets: [{ network: NETWORK, asset: DAI, decimals }] }), /decimals from 0 to 18/, String(decimals));
  }
  budget.guard(kit.client(), { assets: [{ network: NETWORK, asset: USDC, decimals: 6 }, { network: NETWORK, asset: DAI, decimals: 18 }] });
});

test('a settlement the guard cannot record throws PaymentNotRecorded, and the payment keeps counting', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { budget, client, path } = setup();
  const payload = await client.createPaymentPayload(kit.required(50_000));
  budget.close();
  await assert.rejects(
    client.handlePaymentResponse({ paymentPayload: payload, requirements: payload.accepted, settleResponse: settled }),
    error => error instanceof PaymentNotRecorded && !(error instanceof BudgetError),
  );
  assert.equal(openBudget({ wallet: kit.account.address, path }).status().inFlight, 50_000n);
});

test("a refusal or a lost answer the guard can't record throws PaymentNotRecorded too", { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const refusedAnswer = { settleResponse: { success: false, errorReason: 'insufficient_funds', transaction: '', network: NETWORK } };
  for (const answer of [refusedAnswer, {}]) {
    const { budget, client, path } = setup();
    const payload = await client.createPaymentPayload(kit.required(50_000));
    budget.close(); // the budget can't be written: closed here, a busy timeout in practice
    // 0.3.0 let the ledger's BudgetError through, which code that retries on one would retry.
    await assert.rejects(
      client.handlePaymentResponse({ paymentPayload: payload, requirements: payload.accepted, ...answer }),
      error => error instanceof PaymentNotRecorded && !(error instanceof BudgetError) && /what happened to the payment could not be recorded/.test(error.message),
    );
    assert.equal(openBudget({ wallet: kit.account.address, path }).status().inFlight, 50_000n);
  }
});

test("the agent is told why the guard refused, not which holds its owner could release", { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { budget, client } = setup({ perDay: '$0.05' });
  budget.reserve('$0.05').annotate({ outcome: 'unknown' });
  const owner = budget.check('$0.01');
  assert.match(owner.message, /1 open payment \(wc-\w+; walletcap holds lists them, and if one never left the wallet its owner can release it\)$/);
  // 0.3.0's guard (and so AgentKit's) passed the owner's message to the agent.
  const brief = error => refusedFor('budget')(error) && error.message === owner.brief && !/wc-|release/.test(error.message);
  await assert.rejects(client.createPaymentPayload(kit.required(10_000)), brief);
  // The same when another process takes the room between the check and the reservation.
  const raced = setup({ perDay: '$0.05' });
  raced.client.onBeforePaymentCreation(async () => { raced.budget.reserve('$0.05').annotate({ outcome: 'unknown' }); });
  await assert.rejects(raced.client.createPaymentPayload(kit.required(10_000)), error => refusedFor('budget')(error) && !/wc-|release/.test(error.message));
  assert.equal(raced.budget.status().inFlight, 50_000n);
});

test("a payee's word that a payment settled can't free the budget while the authorization is redeemable", { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { budget, client, clock } = setup({ perDay: '$0.15' });
  // The payee answers "settled" with a made-up hash and keeps the authorization, asking for the
  // longest validity walletcap signs: it could redeem it for an hour yet.
  const payload = await client.createPaymentPayload(kit.required(150_000, { maxTimeoutSeconds: MAX_PAYMENT_TIMEOUT_SECONDS }));
  const fake = { success: true, transaction: `0x${'ee'.repeat(32)}`, network: NETWORK };
  await client.handlePaymentResponse({ paymentPayload: payload, requirements: payload.accepted, settleResponse: fake });
  const validBefore = Number(payload.payload.authorization.validBefore) * 1000;
  clock.now += DAY + 1;
  await assert.rejects(client.createPaymentPayload(kit.required(1)), refusedFor('budget'));
  clock.now = validBefore + DAY;
  assert.equal(budget.status().spent, 150_000n);
  clock.now += 1;
  assert.equal(budget.check('$0.15').ok, true);
});

test("a Permit2 payment, or one whose expiry walletcap can't read, counts until it can no longer settle", { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { budget, client, clock } = setup({ perDay: '$0.15' });
  const fake = { success: true, transaction: `0x${'ee'.repeat(32)}`, network: NETWORK };
  // 0.3.0 read only EIP-3009's validBefore: a payee that asked for Permit2 and answered "settled"
  // with a made-up hash freed the budget after one window, with the deadline still an hour away.
  const permit2 = { maxTimeoutSeconds: MAX_PAYMENT_TIMEOUT_SECONDS, extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } };
  const payload = await client.createPaymentPayload(kit.required(100_000, permit2));
  await client.handlePaymentResponse({ paymentPayload: payload, requirements: payload.accepted, settleResponse: fake });
  const deadline = Number(payload.payload.permit2Authorization.deadline) * 1000;
  clock.now = deadline + DAY;
  assert.equal(budget.status().spent, 100_000n);
  clock.now += 1;
  assert.equal(budget.status().spent, 0n);
  // A scheme whose payload carries no expiry walletcap reads counts from the time it was signed,
  // for as long as its terms allow.
  const { x402Client } = await import('@x402/core/client');
  const opaque = { scheme: 'opaque', createPaymentPayload: async version => ({ x402Version: version, payload: { signed: 'elsewhere' } }) };
  const other = budget.guard(new x402Client().register(NETWORK, opaque));
  other.setSpendControls(false);
  const signedAt = clock.now;
  const unread = await other.createPaymentPayload(kit.required(50_000, { scheme: 'opaque', maxTimeoutSeconds: 600 }));
  await other.handlePaymentResponse({ paymentPayload: unread, requirements: unread.accepted, settleResponse: fake });
  clock.now = signedAt + 600_000 + DAY;
  assert.equal(budget.status().spent, 50_000n);
  clock.now += 1;
  assert.equal(budget.status().spent, 0n);
});

test('terms valid longer than an hour are passed over for shorter ones on offer', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { budget, client } = setup();
  // 0.3.0 refused the payment when the first terms asked for two hours, though the payee also
  // offered five minutes.
  const required = kit.required(10_000, { maxTimeoutSeconds: 7200 });
  required.accepts.push({ ...required.accepts[0], maxTimeoutSeconds: 300 });
  const payload = await client.createPaymentPayload(required);
  assert.equal(payload.accepted.maxTimeoutSeconds, 300);
  assert.equal(budget.status().inFlight, 10_000n);
  // Terms in an asset the budget can't price don't stand in for them.
  const unpriced = kit.required(10_000, { maxTimeoutSeconds: 7200 });
  unpriced.accepts.push({ ...unpriced.accepts[0], asset: '0x1111111111111111111111111111111111111111', maxTimeoutSeconds: 300 });
  await assert.rejects(client.createPaymentPayload(unpriced), refusedFor('timeout'));
});

test('an authorization valid longer than an hour is refused before it is signed', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { budget, client } = setup();
  // 0.2.x signed whatever validity the payee asked for: here, 30 days to redeem it.
  await assert.rejects(client.createPaymentPayload(kit.required(10_000, { maxTimeoutSeconds: 30 * 86_400 })), refusedFor('timeout'));
  await assert.rejects(client.createPaymentPayload(kit.required(10_000, { maxTimeoutSeconds: MAX_PAYMENT_TIMEOUT_SECONDS + 1 })), refusedFor('timeout'));
  assert.equal(budget.status().payments, 0n);
  await client.createPaymentPayload(kit.required(10_000, { maxTimeoutSeconds: MAX_PAYMENT_TIMEOUT_SECONDS }));
  assert.equal(budget.status().inFlight, 10_000n);
});
