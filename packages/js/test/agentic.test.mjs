// SPDX-License-Identifier: Apache-2.0
// The budget in front of Coinbase's Agentic Wallet. The wallet's request channel and its MCP
// server are stand-ins here; the payee is a local HTTP server that answers 402 like an x402 one.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, test } from 'node:test';
import { resetClock, setClock } from '../dist/core/_clock.js';
import { BudgetRefused, BudgetUnavailable, openBudget, PaymentNotRecorded, UsageError } from 'walletcap';
import { guardAgenticWallet, usdcAtomic } from 'walletcap/agentic';

const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const FAKE_AWAL = fileURLToPath(new URL('./support/fake-awal', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'walletcap-awal-'));
const WALLET = '0xd797ead28C38575FDf4fC523866287372340Ca02';
const PAY_TO = '0x0773A0A3ec5F88162EA52470B7973b2cfAaA846A';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TX = `0x${'cd'.repeat(32)}`;
const DAY = 86_400_000;
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64');
const requirement = (amount = '50000', ttl = 300, asset = USDC) => ({
  scheme: 'exact', network: 'eip155:84532', asset, amount, payTo: PAY_TO, maxTimeoutSeconds: ttl, extra: { name: 'USDC', version: '2' },
});

const EXTENSIONS = { bazaar: { discoverable: true } };

// A payee: GET /pay?amount=&ttl=&asset= answers 402 with those terms; /free answers 200.
let server;
let base;
before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/free') { res.end('{}'); return; }
    const offered = requirement(url.searchParams.get('amount') ?? '50000', Number(url.searchParams.get('ttl') ?? 300), url.searchParams.get('asset') ?? USDC);
    res.writeHead(402, { 'PAYMENT-REQUIRED': b64({ x402Version: 2, resource: { url: req.url }, accepts: [offered], extensions: EXTENSIONS }) });
    res.end('{}');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.closeAllConnections();
  server?.close();
  // Windows keeps a budget file a test left open; its temp folder is cleared later.
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* open on Windows */ }
});
afterEach(resetClock);

let files = 0;
const newBudget = async (clock = { now: Date.now() }, path = join(DIR, `b${files++}.sqlite`)) => {
  setClock(() => clock.now);
  const budget = await openBudget({ wallet: WALLET, path, perPayment: '$0.05', perDay: '$0.15', create: true });
  return { budget, clock, path };
};

// The wallet's request channel: records each request, answers per `answer`.
const wallet = (answer = () => ({ status: 200, headers: { 'PAYMENT-RESPONSE': b64({ success: true, transaction: TX }) } })) => {
  const calls = [];
  return { calls, request: async (channel, data) => { calls.push({ channel, data }); return answer(channel, data); } };
};
const x402 = (query = '') => ({ baseURL: base, path: `/pay${query}`, method: 'GET' });
const refused = code => error => error instanceof BudgetRefused && error.code === code;

test("sends count in the wallet's budget, and the one past the cap never reaches the wallet", async () => {
  const { budget } = await newBudget();
  const w = wallet(() => ({ transactionHash: TX }));
  const guard = guardAgenticWallet(budget, { request: w.request });
  for (let i = 0; i < 3; i += 1) await guard.request('send-transaction', { recipient: PAY_TO, amountAtomic: '50000', asset: 'USDC', chain: 'base-sepolia' });
  await assert.rejects(guard.request('send-transaction', { recipient: PAY_TO, amountAtomic: '50000', chain: 'base-sepolia' }), refused('budget'));
  await assert.rejects(guard.request('send-transaction', { recipient: PAY_TO, amountAtomic: '1000000', chain: 'base-sepolia' }), refused('per_payment'));
  await assert.rejects(guard.request('send-transaction', { recipient: PAY_TO, amountAtomic: '1', asset: 'ETH', chain: 'base' }), refused('asset'));
  assert.equal(w.calls.length, 3);
  assert.equal((await budget.status()).spent, 150_000n);
  assert.equal((await budget.history())[0].tx, TX);
});

test('the wallet is capped at exactly the price walletcap checked', async () => {
  const { budget } = await newBudget();
  const w = wallet();
  const guard = guardAgenticWallet(budget, { request: w.request });
  await guard.request('make-x402-request', x402('?ttl=300'));
  const [{ channel, data }] = w.calls;
  assert.equal(channel, 'make-x402-request');
  assert.deepEqual(data.paymentRequirements, [requirement('50000', 300)]);
  assert.equal(data.maxAmountPerRequest, 50_000);
  assert.equal((await budget.status()).spent, 50_000n);
  assert.deepEqual([(await budget.history())[0].status, (await budget.history())[0].tx, (await budget.history())[0].rail], ['settled', TX, 'awal-x402']);
});

test('a payee that holds its authorizations collects at most the cap, restarts included', async () => {
  const clock = { now: Date.now() };
  const { path } = await newBudget(clock);
  const hold = () => ({ status: 200, headers: { 'PAYMENT-RESPONSE': b64({ success: true, transaction: '' }) } });
  // Three wallet sessions, each a fresh process: the budget file is all they share.
  let signed = 0;
  for (let session = 0; session < 3; session += 1) {
    const { budget } = await newBudget(clock, path);
    const guard = guardAgenticWallet(budget, { request: wallet(hold).request });
    for (let i = 0; i < 4; i += 1) {
      try { await guard.request('make-x402-request', x402('?ttl=3600')); signed += 1; } catch (error) { assert.ok(refused('budget')(error), error); }
    }
    budget.close();
  }
  assert.equal(signed, 3);
  const { budget } = await newBudget(clock, path);
  assert.equal((await budget.status()).inFlight, 150_000n);
  // Unconfirmed, they count until one window past the time the authorizations expire.
  clock.now += 3_600_000 + 60_000 + DAY;
  assert.equal((await budget.status()).inFlight, 150_000n);
  clock.now += 1;
  assert.equal((await budget.status()).inFlight, 0n);
  assert.deepEqual((await budget.history()).map(row => row.status), ['expired', 'expired', 'expired']);
});

test("an error from the wallet never gives the amount back, whatever its text says", async () => {
  const { budget } = await newBudget();
  // 0.3.0 gave the amount back when the error read like the wallet's own refusal before signing,
  // and a payee could echo that wording. Now any failure keeps counting, noted unknown, until its
  // owner voids it once the chain shows it never left.
  const errors = [
    'x402 request failed: Required payment $0.05 exceeds remaining session limit of $0.00 (spent $0.00, pending $0.15 of $0.15).',
    'X402 submission failed: Payment was authorized but rejected by server',
    'X402 submission failed: Required payment $0.05 exceeds remaining session limit',
  ];
  for (const [index, message] of errors.entries()) {
    const failing = guardAgenticWallet(budget, { request: wallet(() => { throw new Error(message); }).request });
    await assert.rejects(failing.request('make-x402-request', x402()), error => error.message === message);
    assert.equal((await budget.status()).inFlight, 50_000n * BigInt(index + 1));
  }
  assert.deepEqual((await budget.holds()).map(hold => hold.reason), ['unknown', 'unknown', 'unknown']);
});

test('a send whose outcome is unknown keeps counting until its owner releases it', async () => {
  const clock = { now: Date.now() };
  const { budget } = await newBudget(clock);
  const timedOut = guardAgenticWallet(budget, { request: wallet(() => { throw new Error('IPC request timed out'); }).request });
  await assert.rejects(timedOut.request('send-transaction', { recipient: PAY_TO, amountAtomic: '50000', chain: 'base-sepolia' }), /timed out/);
  const reported = guardAgenticWallet(budget, { request: wallet(() => ({ error: 'transaction underpriced' })).request });
  await reported.request('send-transaction', { recipient: PAY_TO, amountAtomic: '50000', chain: 'base-sepolia' });
  // Either transaction can still be mined, however long ago it was sent.
  clock.now += 30 * DAY;
  assert.deepEqual([(await budget.status()).spent, (await budget.status()).inFlight], [0n, 100_000n]);
  assert.deepEqual((await budget.history()).map(row => row.status), ['unknown', 'unknown']);
});

test("a free endpoint gives its hold back unless the payee confirms a payment, so it can't use up maxPayments", async () => {
  setClock(Date.now);
  const budget = await openBudget({ wallet: WALLET, path: join(DIR, `b${files++}.sqlite`), perDay: '$150', maxPayments: 3, create: true });
  const free = { baseURL: base, path: '/free', method: 'GET' };
  // The payee answers with a PAYMENT-RESPONSE it controls, or the wallet's request fails. 0.3.0
  // kept each one-unit hold counting until released: three of them refused every payment after.
  const refusing = guardAgenticWallet(budget, { request: wallet(() => ({ status: 200, headers: { 'PAYMENT-RESPONSE': b64({ success: false }) } })).request });
  const failing = guardAgenticWallet(budget, { request: wallet(() => { throw new Error('fetch failed'); }).request });
  for (let i = 0; i < 3; i += 1) {
    await refusing.request('make-x402-request', free);
    await assert.rejects(failing.request('make-x402-request', free), /fetch failed/);
  }
  assert.deepEqual([(await budget.status()).inFlight, (await budget.status()).payments], [0n, 0n]);
  // A confirmed payment on a free endpoint counts, and a paid request still goes through.
  const confirming = guardAgenticWallet(budget, { request: wallet().request });
  await confirming.request('make-x402-request', free);
  await confirming.request('make-x402-request', x402());
  assert.deepEqual([(await budget.status()).spent, (await budget.status()).payments], [50_001n, 2n]);
  budget.close();
});

test('an unconfirmed x402 payment on terms handed to the wallet counts until they expire, plus a window', async () => {
  const clock = { now: Date.now() };
  const { budget } = await newBudget(clock);
  const w = wallet(() => ({ status: 200, headers: {} })); // no PAYMENT-RESPONSE: the outcome is unknown
  const guard = guardAgenticWallet(budget, { request: w.request });
  const terms = [requirement('50000', 300)];
  await guard.request('make-x402-request', { ...x402(), paymentRequirements: terms });
  assert.deepEqual(w.calls[0].data.paymentRequirements, terms);
  // The wallet signed before it answered; the authorization expires 300 s after that (and a
  // minute is left for clock skew).
  clock.now += 300_000 + 60_000 + DAY;
  assert.equal((await budget.status()).inFlight, 50_000n);
  clock.now += 1;
  assert.equal((await budget.status()).inFlight, 0n);
  assert.equal((await budget.history())[0].status, 'expired');

  // A wallet that never answered may sign yet: walletcap can't tell when the payment can no
  // longer settle.
  const silent = guardAgenticWallet(budget, { request: wallet(() => { throw new Error('IPC request timed out'); }).request });
  await assert.rejects(silent.request('make-x402-request', { ...x402(), paymentRequirements: terms }), /timed out/);
  clock.now += 30 * DAY;
  assert.equal((await budget.status()).inFlight, 50_000n);
  assert.deepEqual((await budget.history()).map(row => row.status), ['unknown', 'expired']);
});

test("the payee's word that a payment on handed-in terms settled doesn't end its hold early", async () => {
  const clock = { now: Date.now() };
  const { budget } = await newBudget(clock);
  // A made-up hash: the payee says settled and keeps the authorization, valid an hour.
  const guard = guardAgenticWallet(budget, { request: wallet().request });
  await guard.request('make-x402-request', { ...x402(), paymentRequirements: [requirement('50000', 3600)] });
  assert.equal((await budget.history())[0].status, 'settled');
  clock.now += DAY + 1;
  assert.equal((await budget.status()).spent, 50_000n);
  clock.now += 3_600_000 + 60_000 - 1; // an hour and a minute after the wallet answered, plus one window
  assert.equal((await budget.status()).spent, 50_000n);
  clock.now += 1;
  assert.equal((await budget.status()).spent, 0n);
});

test("the wallet is handed the terms walletcap discovered, so the payee's word can't end the hold early", async () => {
  const clock = { now: Date.now() };
  const { budget } = await newBudget(clock);
  const w = wallet(); // the payee answers "settled" with a made-up hash and keeps the authorization
  const guard = guardAgenticWallet(budget, { request: w.request });
  // 0.3.0 left the wallet to ask the payee again, so walletcap couldn't tell what it signed, and the
  // payee's "settled" ended the count after one window.
  await guard.request('make-x402-request', x402('?ttl=3600'));
  assert.deepEqual(w.calls[0].data.paymentRequirements, [requirement('50000', 3600)]);
  assert.deepEqual(w.calls[0].data.extensions, EXTENSIONS);
  assert.equal((await budget.history())[0].status, 'settled');
  clock.now += DAY + 1;
  assert.equal((await budget.status()).spent, 50_000n);
  clock.now += 3_600_000 + 60_000 - 1; // an hour and a minute after the wallet answered, plus one window
  assert.equal((await budget.status()).spent, 50_000n);
  clock.now += 1;
  assert.equal((await budget.status()).spent, 0n);
  // The caller's own extensions win, as they do in the wallet.
  await guard.request('make-x402-request', { ...x402('?ttl=300'), extensions: { mine: {} } });
  assert.deepEqual(w.calls[1].data.extensions, { mine: {} });
});

test("a term walletcap can't read doesn't switch off the hold's expiry, and terms it can't bound aren't paid", async () => {
  const clock = { now: Date.now() };
  const { budget } = await newBudget(clock);
  const w = wallet(); // the payee answers "settled" with a made-up hash and keeps the authorization
  const guard = guardAgenticWallet(budget, { request: w.request });
  const solana = { ...requirement('50000', 60), network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', payTo: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };
  // 0.3.0 gave the hold no expiry when any term handed over wasn't exact on EVM: one Solana term
  // and the payee's "settled" ended the count after one window, with the EVM authorization still
  // redeemable for an hour.
  await guard.request('make-x402-request', { ...x402(), paymentRequirements: [requirement('50000', 3600), solana], preferredNetwork: 'base-sepolia' });
  assert.equal((await budget.history())[0].status, 'settled');
  clock.now += 3_600_000 + 60_000 + DAY;
  assert.equal((await budget.status()).spent, 50_000n);
  clock.now += 1;
  assert.equal((await budget.status()).spent, 0n);
  // A Solana transaction lasts as long as its blockhash, about a minute, however short the terms.
  await guard.request('make-x402-request', { ...x402(), paymentRequirements: [{ ...solana, maxTimeoutSeconds: 5 }], preferredNetwork: 'solana-devnet' });
  clock.now += 120_000 + 60_000 + DAY;
  assert.equal((await budget.status()).spent, 50_000n);
  clock.now += 1;
  assert.equal((await budget.status()).spent, 0n);
  // Terms over an hour, or that don't say, are never paid: with nothing else, the wallet isn't asked.
  for (const seconds of [3601, 0, 1.5, '300', null, undefined]) {
    const terms = [{ ...requirement('50000', 300), maxTimeoutSeconds: seconds }];
    await assert.rejects(guard.request('make-x402-request', { ...x402(), paymentRequirements: terms }), refused('timeout'), String(seconds));
  }
  await assert.rejects(guard.request('make-x402-request', x402('?ttl=604800')), refused('timeout'));
  assert.equal(w.calls.length, 2);
  assert.equal((await budget.history()).length, 2);
});

test('the wallet is handed only the terms walletcap can price and bound; the rest are left out, not refused', async () => {
  const clock = { now: Date.now() };
  const { budget } = await newBudget(clock);
  const w = wallet(); // the payee answers "settled" with a made-up hash and keeps the authorization
  const WETH = '0x4200000000000000000000000000000000000006';
  const offered = [requirement('50000', 7200), { ...requirement('50000', 300), asset: WETH }, requirement('40000', 600)];
  const guard = guardAgenticWallet(budget, { request: w.request, discover: async () => ({ accepts: offered, extensions: EXTENSIONS }) });
  // 0.3.0 refused the payment for the two-hour terms, and would have handed the wallet the WETH
  // terms, which walletcap can't price.
  await guard.request('make-x402-request', x402());
  assert.deepEqual(w.calls[0].data.paymentRequirements, [requirement('40000', 600)]);
  assert.deepEqual([w.calls[0].data.maxAmountPerRequest, w.calls[0].data.extensions], [40_000, EXTENSIONS]);
  clock.now += 600_000 + 60_000 + DAY; // the longest terms handed over, a minute, a window
  assert.equal((await budget.status()).spent, 40_000n);
  clock.now += 1;
  assert.equal((await budget.status()).spent, 0n);
  // Terms the caller hands over are left out the same way.
  await guard.request('make-x402-request', { ...x402(), paymentRequirements: [requirement('50000', 3601), requirement('30000', 300)] });
  assert.deepEqual(w.calls[1].data.paymentRequirements, [requirement('30000', 300)]);
  // With nothing priced and bounded left, the payment is refused and the wallet isn't asked.
  await assert.rejects(guard.request('make-x402-request', { ...x402(), paymentRequirements: [{ ...requirement('50000', 300), asset: WETH }] }), refused('asset'));
  await assert.rejects(guard.request('make-x402-request', { ...x402(), paymentRequirements: [requirement('50000', 7200)] }), refused('timeout'));
  assert.equal(w.calls.length, 2);
});

test('the hold lasts as long as the longest terms the wallet was handed, not only the ones walletcap would pick', async () => {
  const clock = { now: Date.now() };
  const { budget } = await newBudget(clock);
  const guard = guardAgenticWallet(budget, { request: wallet(() => ({ status: 200, headers: {} })).request });
  const polygon = { ...requirement('50000', 3600), network: 'eip155:137', asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' };
  // The wallet gets both terms; walletcap prices the one on the preferred network. 0.3.0 timed the
  // hold by that one alone (60 s), though the wallet could have signed the other for an hour.
  await guard.request('make-x402-request', { ...x402(), paymentRequirements: [requirement('50000', 60), polygon], preferredNetwork: 'base-sepolia' });
  clock.now += 3_600_000 + 60_000 + DAY;
  assert.equal((await budget.status()).inFlight, 50_000n);
  clock.now += 1;
  assert.equal((await budget.status()).inFlight, 0n);
});

test("a budget that can't be written after the wallet answered raises PaymentNotRecorded, not one of the errors code retries on", async () => {
  // The wallet answers, then the budget can't be written: closed here, a busy timeout in practice.
  // 0.3.0 let the ledger's BudgetError through, which code that retries on one would retry.
  const cases = [
    ['make-x402-request', { ...x402(), paymentRequirements: [requirement('50000', 300)] }, () => ({ status: 200, headers: {} }), 50_000n],
    ['make-x402-request', x402(), () => { throw new Error('IPC request timed out'); }, 50_000n],
    ['make-x402-request', { baseURL: base, path: '/free', method: 'GET' }, () => { throw new Error('fetch failed'); }, 1n],
    ['send-transaction', { recipient: PAY_TO, amountAtomic: '50000', chain: 'base-sepolia' }, () => ({ error: 'transaction underpriced' }), 50_000n],
  ];
  for (const [channel, data, answer, held] of cases) {
    const { budget, path } = await newBudget();
    const guard = guardAgenticWallet(budget, { request: wallet(() => { budget.close(); return answer(); }).request });
    await assert.rejects(
      guard.request(channel, data),
      error => error instanceof PaymentNotRecorded && !(error instanceof BudgetUnavailable || error instanceof BudgetRefused || error instanceof UsageError) && /could not be recorded; it still counts as in flight/.test(error.message),
      `${channel} ${data.path ?? ''}`,
    );
    assert.equal((await (await newBudget(undefined, path)).budget.status()).inFlight, held);
  }
});

test('a discover() of its own may return the 402 answer or just its list of terms', async () => {
  const { budget } = await newBudget();
  const w = wallet();
  const terms = [requirement('50000', 300)];
  // 0.3.0 took only the 402 answer, so a list, the shape before it, threw a TypeError.
  for (const answer of [terms, { accepts: terms }]) {
    await guardAgenticWallet(budget, { request: w.request, discover: async () => answer }).request('make-x402-request', x402());
  }
  assert.deepEqual(w.calls.map(call => call.data.paymentRequirements), [terms, terms]);
  for (const answer of [[], {}, { accepts: [] }]) {
    await assert.rejects(guardAgenticWallet(budget, { request: w.request, discover: async () => answer }).request('make-x402-request', x402()),
      error => error instanceof BudgetRefused && error.code === 'terms' && /without payment requirements walletcap can read/.test(error.message));
  }
  assert.equal(w.calls.length, 2);
});

test('a send passes the wallet only the fields it takes, as walletcap read them', async () => {
  const { budget } = await newBudget();
  const w = wallet(() => ({ transactionHash: TX }));
  const guard = guardAgenticWallet(budget, { request: w.request });
  // 0.3.0 passed the caller's whole object on, so fields walletcap never read reached the wallet.
  await guard.request('send-transaction', { recipient: PAY_TO, amountAtomic: '50000', chain: 'base-sepolia', asset: 'usdc', amount: '1000000', data: '0xdeadbeef' });
  assert.deepEqual(w.calls[0].data, { recipient: PAY_TO, amountAtomic: '50000', asset: 'USDC', chain: 'base-sepolia' });
  await assert.rejects(guard.request('send-transaction', { amountAtomic: '50000', chain: 'base-sepolia' }), /needs a recipient/);
  assert.deepEqual([w.calls.length, (await budget.status()).payments], [1, 1n]);
});

test('a send that went through but cannot be recorded throws PaymentNotRecorded', async () => {
  const { budget, path } = await newBudget();
  const guard = guardAgenticWallet(budget, { request: wallet(() => { budget.close(); return { transactionHash: TX }; }).request });
  await assert.rejects(
    guard.request('send-transaction', { recipient: PAY_TO, amountAtomic: '50000', chain: 'base-sepolia' }),
    error => error instanceof PaymentNotRecorded && !(error instanceof BudgetUnavailable || error instanceof BudgetRefused || error instanceof UsageError),
  );
  assert.equal((await (await newBudget(undefined, path)).budget.status()).inFlight, 50_000n);
  assert.throws(() => guardAgenticWallet(budget, { request: wallet().request, assets: [{ network: 'eip155:84532', asset: USDC, decimals: 18 }] }), /already priced/);
});

test('assets walletcap cannot price are refused before the wallet is asked', async () => {
  const { budget } = await newBudget();
  const w = wallet();
  const guard = guardAgenticWallet(budget, { request: w.request });
  await assert.rejects(guard.request('make-x402-request', x402('?asset=0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf')), refused('asset'));
  await assert.rejects(guard.request('make-x402-request', x402('?amount=1000000')), refused('per_payment'));
  assert.equal(w.calls.length, 0);
});

test('two processes on one budget share one cap', async () => {
  const { path } = await newBudget();
  const a = guardAgenticWallet((await newBudget(undefined, path)).budget, { request: wallet().request });
  const b = guardAgenticWallet((await newBudget(undefined, path)).budget, { request: wallet().request });
  let paid = 0;
  for (const guard of [a, b, a, b, a, b, a, b]) {
    try { await guard.request('make-x402-request', x402()); paid += 1; } catch (error) { assert.ok(refused('budget')(error)); }
  }
  assert.equal(paid, 3);
});

test("a free endpoint goes through with the wallet's smallest payment cap, and nothing is counted", async () => {
  const { budget } = await newBudget();
  const w = wallet(() => ({ status: 200, headers: {} }));
  await guardAgenticWallet(budget, { request: w.request }).request('make-x402-request', { baseURL: base, path: '/free', method: 'GET' });
  assert.equal(w.calls[0].data.maxAmountPerRequest, 1);
  assert.deepEqual([(await budget.status()).spent, (await budget.status()).inFlight], [0n, 0n]);
});

test("awal's amount rule, read exactly: dollars, or a whole number of atomic units above 100", async () => {
  const read = [
    ['$0.05', '50000'], ['0.05', '50000'], ['1', '1000000'], ['100', '100000000'], ['100.5', '100500000'],
    ['50000', '50000'], ['101.0', '101'], ['$101', '101'], [' 0.29 ', '290000'], ['0.000001', '1'], ['$ 7', '7000000'],
  ];
  for (const [amount, atomic] of read) assert.equal(usdcAtomic(amount), atomic, amount);
  // 0.2.x used parseFloat: "100.5abc" was $100.50, "1e3" 1000 units, and "0.29" 289999.
  const refused = ['100.5abc', '1e3', '1,000', '0x10', '-5', '+5', '0', '0.0000001', '', '$', 'Infinity', '\u0661\u0662', '12\u0085', '\u00a05'];
  for (const amount of refused) assert.throws(() => usdcAtomic(amount), { name: 'UsageError' }, JSON.stringify(amount));
});

test('a send amount the wallet could read another way is refused, and the amount counted is the one sent', async () => {
  const { budget } = await newBudget();
  const w = wallet(() => ({ transactionHash: TX }));
  const guard = guardAgenticWallet(budget, { request: w.request });
  for (const amountAtomic of ['0x10', ' 50000', '5e4', '50000.0', 1.5, -1, '-1', '', null]) {
    await assert.rejects(guard.request('send-transaction', { recipient: PAY_TO, amountAtomic, chain: 'base-sepolia' }), { name: 'UsageError' }, String(amountAtomic));
  }
  await guard.request('send-transaction', { recipient: PAY_TO, amountAtomic: 50000, chain: 'base-sepolia' });
  assert.deepEqual(w.calls.map(call => call.data.amountAtomic), ['50000']);
  assert.equal((await budget.status()).spent, 50_000n);
});

// Async: the CLI asks this process's payee for its terms, so the test must keep serving meanwhile.
const awal = (path, log, mode, ...args) => new Promise(done => execFile(process.execPath, [CLI, 'awal', ...args], {
  env: { ...process.env, WALLETCAP_PATH: path, WALLETCAP_AWAL: FAKE_AWAL, FAKE_AWAL_LOG: log, FAKE_AWAL_MODE: mode },
  encoding: 'utf8',
}, (error, stdout, stderr) => done({ status: error ? error.code : 0, stdout, stderr })));

test('npx walletcap awal: payments are counted, everything else is awal', async () => {
  const path = join(DIR, 'cli.sqlite');
  const log = join(DIR, 'cli.log');
  writeFileSync(log, '');
  const set = spawnSync(process.execPath, [CLI, 'set', '--wallet', WALLET, '--per-day', '0.15', '--per-payment', '0.05'], { env: { ...process.env, WALLETCAP_PATH: path }, encoding: 'utf8' });
  assert.equal(set.status, 0, set.stderr);
  const results = [];
  for (let i = 0; i < 4; i += 1) results.push(await awal(path, log, 'settle', 'x402', 'pay', `${base}/pay?ttl=300`, '--json'));
  assert.deepEqual(results.map(r => r.status), [0, 0, 0, 1]);
  assert.equal(JSON.parse(results[3].stdout).error.code, 'BUDGET_REFUSED');
  const send = await awal(path, log, 'settle', 'send', '0.05', PAY_TO, '--chain', 'base-sepolia', '--json');
  assert.equal(send.status, 1);
  assert.match(JSON.parse(send.stdout).error.message, /walletcap refused/);
  const passthrough = await awal(path, log, 'settle', 'status', '--json');
  assert.equal(passthrough.stdout.trim(), 'awal status --json');
  const asked = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(asked.map(line => line.channel), ['get-wallet-address', 'make-x402-request', 'get-wallet-address', 'make-x402-request', 'get-wallet-address', 'make-x402-request', 'get-wallet-address', 'get-wallet-address']);
  // The wallet pays the terms walletcap discovered and priced: it is handed them.
  for (const line of asked.filter(line => line.channel === 'make-x402-request')) assert.deepEqual(line.paymentRequirements, [requirement('50000', 300)]);
});

test("the agent is told why a payment was refused, not which holds its owner could release", async () => {
  const path = join(DIR, 'awal-holds.sqlite');
  const log = join(DIR, 'awal-holds.log');
  writeFileSync(log, '');
  const budget = await openBudget({ wallet: WALLET, path, perDay: '$0.15', create: true });
  for (let i = 0; i < 3; i += 1) await (await budget.hold('$0.05')).note('unknown');
  // The owner's own check names the holds and how to release them.
  assert.match((await budget.check('$0.05')).message, /3 open payments \(wc-\w+, wc-\w+, wc-\w+; walletcap holds lists them, and if one never left the wallet its owner can void it\)$/);
  budget.close();
  // 0.3.0 passed all of it to the agent through the awal CLI. walletcap-mcp says the same (packages/mcp).
  const paid = await awal(path, log, 'settle', 'x402', 'pay', `${base}/pay?ttl=300`, '--json');
  assert.equal(paid.status, 1);
  assert.equal(JSON.parse(paid.stdout).error.message, 'walletcap refused this payment: $0.05 would bring 0xd797…ca02 to $0.20 in the last 24h, '
    + 'over its $0.15 limit ($0.00 left); $0.15 of it is 3 open payments');
});
