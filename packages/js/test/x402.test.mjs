// SPDX-License-Identifier: Apache-2.0
// The guard on x402's real client (@x402/core 2.28.0 with the exact EVM scheme).
// Payloads are signed offline; a server's answer is handed to the client's own
// handlePaymentResponse, as @x402/fetch does. Nothing is sent.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { resetClock, setClock } from '../dist/core/_clock.js';
import { BudgetRefused, BudgetUnavailable, openBudget, PaymentNotRecorded, UsageError } from 'walletcap';
import { guard, MAX_PAYMENT_TIMEOUT_SECONDS } from 'walletcap/x402';
import { NETWORK, PAY_TO, USDC, x402 } from './support/x402-kit.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'walletcap-x402-'));
// Windows keeps a budget file a test left open; its temp folder is cleared later.
after(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* open on Windows */
  }
});
afterEach(resetClock);
const kit = await x402();
const DAY = 86_400_000;
const TX = `0x${'cd'.repeat(32)}`;
let files = 0;

const setup = async (limits = { perPayment: '$0.05', perDay: '$0.15' }) => {
  const clock = { now: Date.now() };
  setClock(() => clock.now);
  const path = join(DIR, `x402-${files++}.sqlite`);
  const budget = await openBudget({ wallet: kit.account.address, path, create: true, ...limits });
  return { budget, clock, path, client: guard(kit.client(), budget) };
};
const settled = { success: true, transaction: TX, network: NETWORK };
const pay = async (client, atomic, answer = { settleResponse: settled }) => {
  const payload = await client.createPaymentPayload(kit.required(atomic));
  await client.handlePaymentResponse({ paymentPayload: payload, requirements: payload.accepted, ...answer });
  return payload;
};
const refusedFor = code => error => error instanceof BudgetRefused && error.code === code;

test('settled x402 payments count, and the next one past the cap is refused before it is signed', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { budget, client } = await setup();
  for (let i = 0; i < 3; i += 1) await pay(client, 50_000);
  await assert.rejects(pay(client, 50_000), refusedFor('budget'));
  await assert.rejects(pay(client, 1_000_000), refusedFor('per_payment'));
  const status = await budget.status();
  assert.equal(status.spent, 150_000n);
  assert.equal(status.inFlight, 0n);
  const [newest] = await budget.history();
  assert.deepEqual([newest.status, newest.tx, newest.to, newest.rail], ['settled', TX, PAY_TO, 'x402']);
});

test('a payee that says the payment failed still holds the authorization, so it counts until that expires', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { budget, client, clock } = await setup();
  const payload = await pay(client, 50_000, { paymentRequired: kit.required(50_000) });
  assert.equal((await budget.status()).inFlight, 50_000n);
  assert.equal((await budget.history())[0].status, 'refused');
  const validBefore = Number(payload.payload.authorization.validBefore) * 1000;
  clock.now = validBefore + DAY;
  assert.equal((await budget.status()).inFlight, 50_000n);
  clock.now += 1;
  assert.equal((await budget.status()).inFlight, 0n);
});

test('a lost answer keeps the payment counting, and a cloned payload is still recognized', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { budget, client } = await setup();
  await pay(client, 50_000, { error: new Error('socket hang up') });
  assert.equal((await budget.history())[0].status, 'unknown');
  const payload = await client.createPaymentPayload(kit.required(50_000));
  const echoed = JSON.parse(JSON.stringify(payload));
  await client.handlePaymentResponse({ paymentPayload: echoed, requirements: echoed.accepted, settleResponse: settled });
  const status = await budget.status();
  assert.equal(status.inFlight, 50_000n);
  assert.equal(status.spent, 50_000n);
});

test('a later control that aborts or fails leaves nothing reserved', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const aborted = await setup();
  // Coinbase's CDP controls pin their before-hook last, after this guard's check.
  aborted.client.onBeforePaymentCreation(async () => ({ abort: true, reason: 'another control' }));
  await assert.rejects(pay(aborted.client, 50_000), /another control/);
  assert.equal((await aborted.budget.status()).payments, 0n);

  const failed = await setup();
  failed.client.onAfterPaymentCreation(async () => {
    throw new Error('a later hook failed');
  });
  await assert.rejects(pay(failed.client, 50_000), /a later hook failed/);
  assert.equal((await failed.budget.status()).payments, 0n);
});

test('an asset the budget cannot price is refused, and a priced one is chosen when offered', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { budget, client } = await setup();
  const unknown = '0x0000000000000000000000000000000000000bad';
  await assert.rejects(
    client.createPaymentPayload(kit.required(1, { asset: unknown })),
    error => refusedFor('asset')(error) && error.message.includes('decimals: 6'),
  );
  const offer = kit.required(10_000);
  offer.accepts.unshift({ ...offer.accepts[0], asset: unknown });
  const payload = await client.createPaymentPayload(offer);
  assert.equal(payload.accepted.asset, USDC);
  assert.equal((await budget.status()).inFlight, 10_000n);
});

test('a stablecoin added with its decimals is counted in dollars, rounded up', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const dai = '0x00000000000000000000000000000000000000da';
  const budget = await openBudget({ wallet: kit.account.address, path: join(DIR, 'decimals.sqlite'), perDay: '$1', create: true });
  const client = guard(kit.client(), budget, { assets: [{ network: NETWORK, asset: dai, decimals: 18 }] });
  await client.createPaymentPayload(kit.required('100000000000000001', { asset: dai })); // $0.100000000000000001
  assert.equal((await budget.status()).inFlight, 100_001n);
});

test('a restarted process with a new client finds the same count', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { path, client, budget } = await setup();
  for (let i = 0; i < 3; i += 1) await pay(client, 50_000);
  budget.close();
  const restarted = await openBudget({ wallet: kit.account.address, path, perPayment: '$2.50', perDay: '$5', onWarning: () => {} });
  await assert.rejects(pay(guard(kit.client(), restarted), 50_000), refusedFor('budget'));
});

test('a server cannot block a payment with an oversized resource URL', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { budget, client } = await setup();
  const required = kit.required(10_000);
  required.resource.url = `https://api.example/${'x'.repeat(5_000)}`;
  await client.createPaymentPayload(required);
  assert.equal((await budget.status()).inFlight, 10_000n);
  assert.equal((await budget.history())[0].note.length, 1024);
});

test('a client is guarded once, and only an x402 client can be', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { budget, client } = await setup();
  assert.throws(() => guard(client, budget), /already has a budget guard/);
  assert.throws(() => guard({}, budget), /x402Client from @x402\/core/);
});

const DAI = '0x00000000000000000000000000000000000000da';

test('an asset override adds a USD stablecoin, and cannot reprice a built-in one', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { budget } = await setup();
  // 0.2.x took any decimals up to 36, for any asset: USDC at 18 decimals counted $1 as 0.000001 of a cent.
  assert.throws(() => guard(kit.client(), budget, { assets: [{ network: NETWORK, asset: USDC, decimals: 18 }] }), /already priced with 6 decimals/);
  assert.throws(
    () => guard(kit.client(), budget, { assets: [{ network: 'base-sepolia', asset: USDC.toLowerCase(), decimals: 0 }] }),
    /already priced with 6 decimals/,
  );
  for (const decimals of [19, 36, -1, 1.5, '6', undefined]) {
    assert.throws(() => guard(kit.client(), budget, { assets: [{ network: NETWORK, asset: DAI, decimals }] }), /decimals from 0 to 18/, String(decimals));
  }
  guard(kit.client(), budget, {
    assets: [
      { network: NETWORK, asset: USDC, decimals: 6 },
      { network: NETWORK, asset: DAI, decimals: 18 },
    ],
  });
});

test('a settlement the guard cannot record throws PaymentNotRecorded, and the payment keeps counting', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { budget, client, path } = await setup();
  const payload = await client.createPaymentPayload(kit.required(50_000));
  budget.close();
  await assert.rejects(
    client.handlePaymentResponse({ paymentPayload: payload, requirements: payload.accepted, settleResponse: settled }),
    error => error instanceof PaymentNotRecorded && !(error instanceof BudgetUnavailable || error instanceof BudgetRefused || error instanceof UsageError),
  );
  assert.equal((await (await openBudget({ wallet: kit.account.address, path })).status()).inFlight, 50_000n);
});

test("a refusal or a lost answer the guard can't record throws PaymentNotRecorded too", {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const refusedAnswer = { settleResponse: { success: false, errorReason: 'insufficient_funds', transaction: '', network: NETWORK } };
  for (const answer of [refusedAnswer, {}]) {
    const { budget, client, path } = await setup();
    const payload = await client.createPaymentPayload(kit.required(50_000));
    budget.close(); // the budget can't be written: closed here, a busy timeout in practice
    // 0.3.0 let the ledger's BudgetError through, which code that retries on one would retry.
    await assert.rejects(
      client.handlePaymentResponse({ paymentPayload: payload, requirements: payload.accepted, ...answer }),
      error =>
        error instanceof PaymentNotRecorded &&
        !(error instanceof BudgetUnavailable || error instanceof BudgetRefused || error instanceof UsageError) &&
        /what happened to the payment could not be recorded/.test(error.message),
    );
    assert.equal((await (await openBudget({ wallet: kit.account.address, path })).status()).inFlight, 50_000n);
  }
});

test("the guard keeps a refusal's source: a process's own limit says it is the process's", {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { path } = await setup({ perDay: '$0.15' });
  const tighter = await openBudget({ wallet: kit.account.address, path, perPayment: '$0.01' });
  const client = guard(kit.client(), tighter);
  await assert.rejects(pay(client, 50_000), error => refusedFor('per_payment')(error) && error.source === 'process');
  // The owner's limits come first: past the cap, the refusal is the budget's.
  await assert.rejects(pay(client, 200_000), error => refusedFor('budget')(error) && error.source === 'budget');
  tighter.close();
});

test('the agent is told why the guard refused, not which holds its owner could release', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { budget, client } = await setup({ perDay: '$0.05' });
  await (await budget.hold('$0.05')).note('unknown');
  const owner = await budget.check('$0.01');
  assert.match(owner.message, /1 open payment \(wc-\w+; walletcap holds lists them, and if one never left the wallet its owner can void it\)$/);
  // 0.3.0's guard (and so AgentKit's) passed the owner's message to the agent.
  const brief = error => refusedFor('budget')(error) && error.message === owner.brief && !/wc-|release/.test(error.message);
  await assert.rejects(client.createPaymentPayload(kit.required(10_000)), brief);
  // The same when another process takes the room between the check and the reservation.
  const raced = await setup({ perDay: '$0.05' });
  raced.client.onBeforePaymentCreation(async () => {
    await (await raced.budget.hold('$0.05')).note('unknown');
  });
  await assert.rejects(raced.client.createPaymentPayload(kit.required(10_000)), error => refusedFor('budget')(error) && !/wc-|release/.test(error.message));
  assert.equal((await raced.budget.status()).inFlight, 50_000n);
});

test("a payee's word that a payment settled can't free the budget while the authorization is redeemable", {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { budget, client, clock } = await setup({ perDay: '$0.15' });
  // The payee answers "settled" with a made-up hash and keeps the authorization, asking for the
  // longest validity walletcap signs: it could redeem it for an hour yet.
  const payload = await client.createPaymentPayload(kit.required(150_000, { maxTimeoutSeconds: MAX_PAYMENT_TIMEOUT_SECONDS }));
  const fake = { success: true, transaction: `0x${'ee'.repeat(32)}`, network: NETWORK };
  await client.handlePaymentResponse({ paymentPayload: payload, requirements: payload.accepted, settleResponse: fake });
  const validBefore = Number(payload.payload.authorization.validBefore) * 1000;
  clock.now += DAY + 1;
  await assert.rejects(client.createPaymentPayload(kit.required(1)), refusedFor('budget'));
  clock.now = validBefore + DAY;
  assert.equal((await budget.status()).spent, 150_000n);
  clock.now += 1;
  assert.equal((await budget.check('$0.15')).ok, true);
});

test("a Permit2 payment, or one whose expiry walletcap can't read, counts until it can no longer settle", {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { budget, client, clock } = await setup({ perDay: '$0.15' });
  const fake = { success: true, transaction: `0x${'ee'.repeat(32)}`, network: NETWORK };
  // 0.3.0 read only EIP-3009's validBefore: a payee that asked for Permit2 and answered "settled"
  // with a made-up hash freed the budget after one window, with the deadline still an hour away.
  const permit2 = { maxTimeoutSeconds: MAX_PAYMENT_TIMEOUT_SECONDS, extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } };
  const payload = await client.createPaymentPayload(kit.required(100_000, permit2));
  await client.handlePaymentResponse({ paymentPayload: payload, requirements: payload.accepted, settleResponse: fake });
  const deadline = Number(payload.payload.permit2Authorization.deadline) * 1000;
  clock.now = deadline + DAY;
  assert.equal((await budget.status()).spent, 100_000n);
  clock.now += 1;
  assert.equal((await budget.status()).spent, 0n);
  // A scheme whose payload carries no expiry walletcap reads counts from the time it was signed,
  // for as long as its terms allow.
  const { x402Client } = await import('@x402/core/client');
  const opaque = { scheme: 'opaque', createPaymentPayload: async version => ({ x402Version: version, payload: { signed: 'elsewhere' } }) };
  // The guard counts a scheme it doesn't know only when its owner lists it.
  const unlisted = guard(new x402Client().register(NETWORK, opaque), budget);
  unlisted.setSpendControls(false);
  await assert.rejects(unlisted.createPaymentPayload(kit.required(50_000, { scheme: 'opaque', maxTimeoutSeconds: 600 })), refusedFor('terms'));
  const other = guard(new x402Client().register(NETWORK, opaque), budget, { schemes: ['opaque'] });
  other.setSpendControls(false);
  const signedAt = clock.now;
  const unread = await other.createPaymentPayload(kit.required(50_000, { scheme: 'opaque', maxTimeoutSeconds: 600 }));
  await other.handlePaymentResponse({ paymentPayload: unread, requirements: unread.accepted, settleResponse: fake });
  clock.now = signedAt + 600_000 + DAY;
  assert.equal((await budget.status()).spent, 50_000n);
  clock.now += 1;
  assert.equal((await budget.status()).spent, 0n);
});

test('terms valid longer than an hour are passed over for shorter ones on offer', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { budget, client } = await setup();
  // 0.3.0 refused the payment when the first terms asked for two hours, though the payee also
  // offered five minutes.
  const required = kit.required(10_000, { maxTimeoutSeconds: 7200 });
  required.accepts.push({ ...required.accepts[0], maxTimeoutSeconds: 300 });
  const payload = await client.createPaymentPayload(required);
  assert.equal(payload.accepted.maxTimeoutSeconds, 300);
  assert.equal((await budget.status()).inFlight, 10_000n);
  // Terms in an asset the budget can't price don't stand in for them.
  const unpriced = kit.required(10_000, { maxTimeoutSeconds: 7200 });
  unpriced.accepts.push({ ...unpriced.accepts[0], asset: '0x1111111111111111111111111111111111111111', maxTimeoutSeconds: 300 });
  await assert.rejects(client.createPaymentPayload(unpriced), refusedFor('timeout'));
});

test('an authorization valid longer than an hour is refused before it is signed', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { budget, client } = await setup();
  // 0.2.x signed whatever validity the payee asked for: here, 30 days to redeem it.
  await assert.rejects(client.createPaymentPayload(kit.required(10_000, { maxTimeoutSeconds: 30 * 86_400 })), refusedFor('timeout'));
  await assert.rejects(client.createPaymentPayload(kit.required(10_000, { maxTimeoutSeconds: MAX_PAYMENT_TIMEOUT_SECONDS + 1 })), refusedFor('timeout'));
  assert.equal((await budget.status()).payments, 0n);
  await client.createPaymentPayload(kit.required(10_000, { maxTimeoutSeconds: MAX_PAYMENT_TIMEOUT_SECONDS }));
  assert.equal((await budget.status()).inFlight, 10_000n);
});

// --- What the wallet signs, not only what the terms say ---------------------------------------

test('x402 v1 terms that carry both amount fields are priced at the larger: the one a v1 client signs', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  // registerExactEvmScheme, x402's own helper, registers the v1 scheme on every network it knows.
  // A v1 client signs maxAmountRequired; 0.4.1 priced `amount` when a payee sent both, so a $1,000
  // authorization was held as one cent.
  const { x402Client } = await import('@x402/core/client');
  const { ExactEvmSchemeV1 } = await import('@x402/evm/exact/v1/client');
  const { budget } = await setup();
  const signer = {
    address: kit.account.address,
    signed: [],
    async signTypedData(typed) {
      this.signed.push(typed.message.value);
      return kit.account.signTypedData(typed);
    },
  };
  const client = guard(new x402Client().registerV1('base-sepolia', new ExactEvmSchemeV1(signer)), budget);
  client.setSpendControls(false);
  const v1 = fields => ({
    x402Version: 1,
    error: 'payment required',
    accepts: [
      {
        scheme: 'exact',
        network: 'base-sepolia',
        asset: USDC,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        resource: 'https://api.example/paid',
        description: 'owned test resource',
        mimeType: 'text/plain',
        extra: { name: 'USDC', version: '2' },
        ...fields,
      },
    ],
  });
  await assert.rejects(client.createPaymentPayload(v1({ amount: '10000', maxAmountRequired: '1000000000' })), refusedFor('per_payment'));
  await assert.rejects(client.createPaymentPayload(v1({ amount: '1000000000', maxAmountRequired: '10000' })), refusedFor('per_payment'));
  assert.deepEqual(signer.signed, [], 'nothing was signed');
  assert.equal((await budget.status()).inFlight, 0n);

  // What a v1 client signs is what is held.
  const payload = await client.createPaymentPayload(v1({ amount: '1', maxAmountRequired: '50000' }));
  assert.equal(payload.payload.authorization.value, '50000');
  assert.deepEqual(signer.signed.map(String), ['50000']);
  assert.equal((await budget.status()).inFlight, 50_000n);
});

test('an x402 amount is a whole number in decimal digits, or the payment is refused before signing', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { budget, client } = await setup();
  // BigInt() reads '0x10' as 16 and ' 5 ' as 5; parseInt(…, 10) reads them as 0 and 5. A guard and
  // a signer must never read one amount two ways, so only the one form every parser agrees on passes.
  for (const amount of ['0x10', ' 50000', '50000 ', '5e4', '50000.0', '+5', '-5', '', '0b11', '\u0665', 1.5, -1, true, ['5']]) {
    await assert.rejects(client.createPaymentPayload(kit.required(1, { amount })), refusedFor('terms'), JSON.stringify(amount));
  }
  await assert.rejects(client.createPaymentPayload(kit.required(1, { amount: undefined })), refusedFor('terms'));
  assert.equal((await budget.status()).payments, 0n);
  await client.createPaymentPayload(kit.required(1, { amount: 50_000 }));
  assert.equal((await budget.status()).inFlight, 50_000n, 'a whole number is read too');
});

test('a batch-settlement channel is refused by default, and its deposit is what counts once its owner lists the scheme', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { x402Client } = await import('@x402/core/client');
  const { BatchSettlementEvmScheme } = await import('@x402/evm/batch-settlement/client');
  const terms = extra => kit.required(10_000, { scheme: 'batch-settlement', extra: { name: 'USDC', version: '2', receiverAuthorizer: PAY_TO, ...extra } });
  const client = async (budget, options) => {
    const made = guard(new x402Client().register(NETWORK, new BatchSettlementEvmScheme(kit.account)), budget, options);
    made.setSpendControls(false);
    return made;
  };

  // The request is one cent. The wallet would sign a deposit of five times that into the payee's
  // channel, or of the minimum the payee announces: 0.4.1 held one cent for a $1,000 deposit.
  const first = await setup();
  const unlisted = await client(first.budget);
  await assert.rejects(unlisted.createPaymentPayload(terms({ minDeposit: '1000000000' })), refusedFor('terms'));
  await assert.rejects(unlisted.createPaymentPayload(terms()), /doesn't count the x402 scheme batch-settlement/);
  assert.equal((await first.budget.status()).payments, 0n);

  // Listed, the deposit the wallet signed is what is held: five cents here, the per-payment limit.
  const second = await setup();
  const listed = await client(second.budget, { schemes: ['batch-settlement'] });
  const opened = await listed.createPaymentPayload(terms());
  assert.equal(opened.payload.deposit.amount, '50000');
  assert.equal((await second.budget.status()).inFlight, 50_000n, 'the deposit, not the one-cent request');

  // A deposit over the limit is refused once it is signed, and the payload is discarded.
  const third = await setup();
  const greedy = await client(third.budget, { schemes: ['batch-settlement'] });
  await assert.rejects(greedy.createPaymentPayload(terms({ minDeposit: '1000000000' })), refusedFor('per_payment'));
  assert.equal((await third.budget.status()).payments, 0n);
});

test('a payment is held at what its payload signs for, when that is more than its terms', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { x402Client } = await import('@x402/core/client');
  const { budget } = await setup({ perPayment: '$1', perDay: '$2' });
  // A scheme that signs for more than the terms' amount, as a v1 client did with two amount fields.
  const signs = value => ({
    scheme: 'exact',
    createPaymentPayload: async version => ({
      x402Version: version,
      payload: {
        authorization: {
          from: kit.account.address,
          to: PAY_TO,
          value,
          validBefore: String(Math.floor(Date.now() / 1000) + 300),
          nonce: `0x${'ab'.repeat(32)}`,
        },
      },
    }),
  });
  const client = guard(new x402Client().register(NETWORK, signs('750000')), budget);
  client.setSpendControls(false);
  await client.createPaymentPayload(kit.required(10_000));
  assert.equal((await budget.status()).inFlight, 750_000n);

  const permit2 = {
    scheme: 'exact',
    createPaymentPayload: async version => ({
      x402Version: version,
      payload: {
        permit2Authorization: {
          from: kit.account.address,
          permitted: { token: USDC, amount: '5000000' },
          nonce: '7',
          deadline: String(Math.floor(Date.now() / 1000) + 300),
        },
      },
    }),
  };
  const over = guard(new x402Client().register(NETWORK, permit2), budget);
  over.setSpendControls(false);
  await assert.rejects(over.createPaymentPayload(kit.required(10_000)), refusedFor('per_payment'));
  assert.equal((await budget.status()).inFlight, 750_000n, 'the $5 payload was refused, not held as one cent');
});

test('a client that hands each hook its own context is still counted: no payment passes for want of a check', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { budget } = await setup();
  // The guard takes any client with x402's four hooks. One that builds a new context for the hook
  // that runs after signing left 0.4.1 with no record of the check, and it held nothing.
  const hooks = { before: [], after: [], failure: [], response: [] };
  const client = {
    onBeforePaymentCreation: hook => hooks.before.push(hook),
    onAfterPaymentCreation: hook => hooks.after.push(hook),
    onPaymentCreationFailure: hook => hooks.failure.push(hook),
    onPaymentResponse: hook => hooks.response.push(hook),
    async create(requirements) {
      for (const hook of hooks.before) await hook({ selectedRequirements: requirements });
      const paymentPayload = { x402Version: 2, payload: { signed: files++ }, accepted: requirements };
      for (const hook of hooks.after) await hook({ selectedRequirements: requirements, paymentPayload });
      return paymentPayload;
    },
  };
  guard(client, budget);
  const requirements = { scheme: 'exact', network: NETWORK, asset: USDC, amount: '50000', payTo: PAY_TO, maxTimeoutSeconds: 300 };
  for (let i = 0; i < 3; i += 1) await client.create(requirements);
  assert.equal((await budget.status()).inFlight, 150_000n);
  await assert.rejects(client.create(requirements), refusedFor('budget'));
  // Its after hook alone, with no check before it, prices the payment itself.
  const lone = { selectedRequirements: { ...requirements, amount: '1000000' }, paymentPayload: { x402Version: 2, payload: {} } };
  await assert.rejects(hooks.after[0](lone), refusedFor('per_payment'));
});

test('guard() refuses a list of schemes that is not a list of names', { skip: kit === null && 'the x402 devDependencies are not installed' }, async () => {
  const { budget } = await setup();
  for (const schemes of ['exact', [''], [7], null]) assert.throws(() => guard(kit.client(), budget, { schemes }), UsageError);
});

test("a payload a scheme's own failure hook recovers is held too, or never leaves the client", {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { x402Client } = await import('@x402/core/client');
  // @x402/core returns a payload from a failure hook straight to the transport, past the hook
  // that holds. @x402/svm's batch-settlement client signs a second accept that way; this scheme
  // does the same in a few lines. 0.4.1 held nothing for it.
  const recovering = {
    scheme: 'exact',
    createPaymentPayload: async () => {
      throw new Error('the first accept needs an operator this client does not trust');
    },
    schemeHooks: {
      onPaymentCreationFailure: async context => ({
        recovered: true,
        payload: { x402Version: 2, payload: { signed: ++files }, accepted: context.paymentRequired.accepts[1], resource: context.paymentRequired.resource },
      }),
    },
  };
  const { budget } = await setup();
  const client = guard(new x402Client().register(NETWORK, recovering), budget);
  client.setSpendControls(false);
  const offer = (second, first = {}) => {
    const required = kit.required(50_000, first);
    required.accepts.push({ ...required.accepts[0], ...second });
    return required;
  };
  for (let i = 0; i < 3; i += 1) await client.createPaymentPayload(offer({ amount: '50000' }));
  assert.equal((await budget.status()).inFlight, 150_000n, 'each recovered payload was held');
  await assert.rejects(client.createPaymentPayload(offer({ amount: '50000' })), refusedFor('budget'));

  // The recovered accept is priced on its own terms, not the first one's: its amount, its
  // scheme, its asset and its validity.
  const { budget: second } = await setup();
  const other = guard(new x402Client().register(NETWORK, recovering), second);
  other.setSpendControls(false);
  await assert.rejects(other.createPaymentPayload(offer({ amount: '1000000' }, { amount: '1' })), refusedFor('per_payment'));
  await assert.rejects(other.createPaymentPayload(offer({ scheme: 'batch-settlement' })), refusedFor('terms'));
  await assert.rejects(other.createPaymentPayload(offer({ asset: '0x0000000000000000000000000000000000000001' })), refusedFor('asset'));
  await assert.rejects(other.createPaymentPayload(offer({ maxTimeoutSeconds: 86_400 })), refusedFor('timeout'));
  assert.equal((await second.status()).payments, 0n);
});

test('a listed batch-settlement is still refused where its deposit cannot be read', {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { x402Client } = await import('@x402/core/client');
  const { budget } = await setup();
  const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  let signed = 0;
  const channel = {
    scheme: 'batch-settlement',
    createPaymentPayload: async version => ({ x402Version: version, payload: { transaction: `deposit-${++signed}` } }),
  };
  const client = guard(new x402Client().register(SOLANA, channel), budget, { schemes: ['batch-settlement'] });
  client.setSpendControls(false);
  // On Solana the deposit is inside a transaction walletcap doesn't decode: $15 was signed there
  // for $0.15 counted. Listed or not, the scheme is refused on a chain where it can't be read.
  await assert.rejects(
    client.createPaymentPayload(kit.required(50_000, { scheme: 'batch-settlement', network: SOLANA, asset: usdc })),
    /can't count a batch-settlement payment on solana:/,
  );
  assert.equal(signed, 0);
});

test("the payee's word for a transaction is kept only if it could be one", {
  skip: kit === null && 'the x402 devDependencies are not installed',
}, async () => {
  const { budget, client } = await setup();
  // A "transaction" of terminal controls and a forged row, or one too long to keep, made 0.4.1's
  // settle throw PaymentNotRecorded at the caller. It settles, with no evidence.
  const forged = '\u001b[2K\r2026-11-10T00:00:00Z      $0.00  void       safe to void';
  for (const transaction of [forged, 'x'.repeat(5000), 12345, { a: 1 }]) {
    await pay(client, 10_000, { settleResponse: { success: true, transaction, network: NETWORK } });
  }
  await pay(client, 10_000);
  const history = await budget.history();
  assert.deepEqual(
    history.map(payment => [payment.status, payment.tx]),
    [['settled', TX], ...Array(4).fill(['settled', null])],
  );
});
