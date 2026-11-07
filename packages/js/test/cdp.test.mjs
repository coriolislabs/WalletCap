// SPDX-License-Identifier: Apache-2.0
// The CDP SpendStore and the x402 guard share one budget file. They must not
// share a rail, and a 402 asset must not be able to break the store's loader.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, test } from 'node:test';
import { resetClock, setClock } from '../dist/core/_clock.js';
import { openBudget } from 'walletcap';
import { cdpStore } from 'walletcap/cdp';
import { Ledger } from '../dist/core/ledger.js';

const DIR = mkdtempSync(join(tmpdir(), 'walletcap-cdp-'));
const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
// Windows keeps a budget file a test left open; its temp folder is cleared later.
after(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* open on Windows */ } });
afterEach(resetClock);
const DAY = 86_400_000;
const HOUR = 3_600_000;

const WALLET = '0xd797ead28c38575fdf4fc523866287372340ca02';
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'; // all lowercase on purpose
const PAY_TO = '0x0773a0a3ec5f88162ea52470b7973b2cfaaa846a';
const NETWORK = 'eip155:84532';
let files = 0;

const fixture = async () => {
  const path = join(DIR, `cdp-${files++}.sqlite`);
  const budget = await openBudget({ wallet: WALLET, path, perDay: '$1', create: true });
  return { path, budget, store: cdpStore(budget, { asset: USDC }) };
};

test('a lowercase 402 asset on the x402 rail does not break cdpStore.load()', async () => {
  const { budget, store } = await fixture();
  try {
    await budget.hold('$0.05', {
      rail: 'x402',
      details: { network: NETWORK, asset: USDC, scheme: 'exact' },
    });
    const rows = await store.load();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].atomicAmount, 50_000n);
    assert.equal(rows[0].asset, USDC);
    // The guard row is not a CDP entry, so it is counted synthetically.
    assert.equal(rows[0].network, 'ledger:x402');
  } finally {
    store.close();
    budget.close();
  }
});

test('CDP entries use the cdp rail and load back with their own metadata', async () => {
  const { budget, store } = await fixture();
  try {
    await store.append({
      atomicAmount: '50000',
      asset: USDC,
      network: NETWORK,
      payTo: PAY_TO,
      at: Date.now(),
    });
    const rows = await store.load();
    assert.equal(rows.length, 1);
    assert.deepEqual(
      [rows[0].atomicAmount, rows[0].asset, rows[0].network, rows[0].payTo],
      [50_000n, USDC, NETWORK, PAY_TO],
    );
    assert.equal((await budget.status()).inFlight, 50_000n);
  } finally {
    store.close();
    budget.close();
  }
});

test('the store refuses an entry in another asset', async () => {
  const { budget, store } = await fixture();
  try {
    await assert.rejects(
      store.append({
        atomicAmount: '50000',
        asset: '0x00000000000000000000000000000000000000ff',
        network: NETWORK,
        payTo: PAY_TO,
        at: Date.now(),
      }),
      /counts .* not/,
    );
    assert.equal((await budget.status()).inFlight, 0n);
  } finally {
    store.close();
    budget.close();
  }
});

test('a CDP row on the x402 rail, as 0.2.0 wrote them, still loads after the rail split', async () => {
  const { path, budget, store } = await fixture();
  try {
    const ledger = await Ledger.open(path);
    try {
      await ledger.hold(WALLET, 50_000n, {
        rail: 'x402',
        info: JSON.stringify({ atomicAmount: '50000', asset: USDC, network: NETWORK, payTo: '0xlegacy', at: Date.now() }),
      });
    } finally {
      ledger.close();
    }
    const rows = await store.load();
    const legacy = rows.find(row => row.payTo === '0xlegacy');
    assert.ok(legacy, 'the legacy CDP row is visible');
    assert.equal(legacy.atomicAmount, 50_000n);
    assert.equal(legacy.network, NETWORK);
  } finally {
    store.close();
    budget.close();
  }
});

test("an entry CDP backdates still counts from the ledger's own time", async () => {
  const { budget, store } = await fixture();
  try {
    // CDP's entry carries its own `at`. 0.2.x recorded the payment then, so an entry dated
    // 1970 had already aged out, and a second full $1 passed the $1 cap.
    await store.append({ atomicAmount: 1_000_000n, asset: USDC, network: NETWORK, payTo: PAY_TO, at: 0 });
    // CDP's record isn't evidence that the payment settled: it is held, and counts as in flight.
    assert.equal((await budget.status()).inFlight, 1_000_000n);
    const [row] = await store.load();
    assert.ok(row.at >= Date.now() - 60_000, `the entry is dated ${row.at}, not when CDP said`);
    await assert.rejects(store.append({ atomicAmount: 1_000_000n, asset: USDC, network: NETWORK, payTo: PAY_TO, at: 0 }), { code: 'budget' });
    assert.equal((await budget.status()).inFlight, 1_000_000n);
  } finally {
    store.close();
    budget.close();
  }
});

test('a checksummed or CAIP-10 wallet spends from the one lowercase budget', async () => {
  const path = join(DIR, `cdp-${files++}.sqlite`);
  const budget = await openBudget({ wallet: WALLET, path, perDay: '$1', create: true });
  await budget.pay('$1', async () => 'paid');
  // 0.2.x kept SharedBudgetStore's instrument as given: a checksummed address opened a second budget.
  const checksummed = '0xd797ead28C38575FDf4fC523866287372340Ca02';
  for (const wallet of [checksummed, `eip155:8453:${checksummed}`]) {
    const other = await openBudget({ wallet, path });
    try {
      assert.equal(other.wallet, WALLET);
      await assert.rejects(cdpStore(other, { asset: USDC }).append({ atomicAmount: 1n, asset: USDC, network: NETWORK, payTo: PAY_TO, at: Date.now() }), { code: 'budget' });
    } finally {
      other.close();
    }
  }
  // A mistyped checksum is refused rather than opening a budget of its own.
  await assert.rejects(openBudget({ wallet: '0xD797ead28C38575FDf4fC523866287372340Ca02', path }), /EIP-55/);
  const ledger = await Ledger.open(path);
  try {
    assert.deepEqual((await ledger.budgets()).map(row => row.wallet), [WALLET]);
  } finally {
    ledger.close();
    budget.close();
  }
});

test("a refusal CDP passes on to the agent names no holds and no release instructions", async () => {
  const { budget, store } = await fixture();
  await (await budget.hold('$1')).note('unknown');
  try {
    // 0.3.0 passed the owner's message, with the hold's id, through CDP to the agent.
    await assert.rejects(store.append({ atomicAmount: 1n, asset: USDC, network: NETWORK, payTo: PAY_TO, at: Date.now() }),
      error => error.code === 'budget' && /\$1\.00 of it is 1 open payment$/.test(error.message));
    assert.match((await budget.check('$0.01')).message, /\(wc-\w+; walletcap holds lists them/);
  } finally {
    store.close();
    budget.close();
  }
});

test('a CDP payment counts until an hour after it is recorded, plus one window: its authorization can be redeemed that long', async () => {
  const clock = { now: Date.now() };
  setClock(() => clock.now);
  const { budget, store } = await fixture();
  const entry = atomicAmount => ({ atomicAmount, asset: USDC, network: NETWORK, payTo: PAY_TO, at: clock.now });
  try {
    const recorded = clock.now;
    await store.append(entry(1_000_000n));
    // CDP lets a payee ask for an authorization valid an hour; 0.3.0 counted the payment one
    // window from when CDP recorded it, so a second $1 passed the $1 cap while the first was redeemable.
    clock.now = recorded + DAY + 1;
    await assert.rejects(store.append(entry(1n)), { code: 'budget' });
    const [counted] = await store.load();
    assert.ok(counted.at >= clock.now - DAY, "CDP's own window keeps it too");
    clock.now = recorded + HOUR + 60_000 + DAY;
    assert.equal((await budget.status()).inFlight, 1_000_000n);
    clock.now += 1;
    assert.equal((await budget.status()).inFlight, 0n);
    await store.append(entry(1_000_000n));
  } finally {
    store.close();
    budget.close();
  }
});

test("a refusal and the owner's holds list say what a CDP payment is: signed, redeemable for an hour and a minute", async () => {
  const clock = { now: 1_800_000_000_000 };
  setClock(() => clock.now);
  const { path, budget, store } = await fixture();
  const entry = { atomicAmount: 1_000_000n, asset: USDC, network: NETWORK, payTo: PAY_TO, at: clock.now };
  await store.append(entry);
  await store.removeEntry(entry); // CDP rolled it back: refused, and still redeemable
  // 0.4's first draft told the owner "if one never left the wallet its owner can void it", which
  // invites voiding a payment CDP signed and a payee can still redeem.
  const { message, brief } = await budget.check('$0.01');
  const [held] = await budget.holds();
  assert.ok(message.endsWith(`walletcap holds lists them, and if one never left the wallet its owner can void it. ${held.id} is a payment CDP signed: `
    + 'its authorization can be redeemed until 2027-01-15T09:01:00Z, so void it only if the chain shows it was never redeemed)'), message);
  assert.doesNotMatch(brief, /CDP signed/);
  const listed = spawnSync(process.execPath, [CLI, 'holds', '--wallet', WALLET, '--path', path], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /refused .* cdp .*CDP signed it: its authorization can be redeemed until 2027-01-15T09:01:00Z, so void it only if the chain shows it was never redeemed/);
  const history = spawnSync(process.execPath, [CLI, 'history', '--wallet', WALLET, '--path', path], { encoding: 'utf8' });
  assert.match(history.stdout, /refused .*CDP signed it: void it only if the chain shows it was never redeemed/);
  budget.close();
});
