// SPDX-License-Identifier: Apache-2.0
// The CDP SpendStore and the x402 guard share one budget file. They must not
// share a rail, and a 402 asset must not be able to break the store's loader.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openBudget, SharedBudgetStore } from '../index.mjs';
import { Ledger } from '../ledger.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'walletcap-cdp-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

const WALLET = '0xd797ead28c38575fdf4fc523866287372340ca02';
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'; // all lowercase on purpose
const PAY_TO = '0x0773a0a3ec5f88162ea52470b7973b2cfaaa846a';
const NETWORK = 'eip155:84532';
let files = 0;

const fixture = () => {
  const path = join(DIR, `cdp-${files++}.sqlite`);
  const budget = openBudget({ wallet: WALLET, path, perDay: '$1', create: true });
  return { path, budget, store: budget.cdpStore({ asset: USDC }) };
};

test('a lowercase 402 asset on the x402 rail does not break cdpStore.load()', async () => {
  const { budget, store } = fixture();
  try {
    budget.reserve('$0.05', {
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
  const { budget, store } = fixture();
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
    assert.equal(budget.status().spent, 50_000n);
  } finally {
    store.close();
    budget.close();
  }
});

test('the store refuses an entry in another asset', async () => {
  const { budget, store } = fixture();
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
    assert.equal(budget.status().spent, 0n);
  } finally {
    store.close();
    budget.close();
  }
});

test('a 0.2.0 CDP row on the x402 rail still loads after the rail split', async () => {
  const { path, budget, store } = fixture();
  try {
    const ledger = new Ledger(path);
    try {
      ledger.record(WALLET, 50_000n, {
        rail: 'x402',
        reference: JSON.stringify({
          atomicAmount: '50000',
          asset: USDC,
          network: NETWORK,
          payTo: '0xlegacy',
          at: Date.now(),
        }),
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
  const { budget, store } = fixture();
  try {
    // CDP's entry carries its own `at`. 0.2.x recorded the payment then, so an entry dated
    // 1970 had already aged out, and a second full $1 passed the $1 cap.
    await store.append({ atomicAmount: 1_000_000n, asset: USDC, network: NETWORK, payTo: PAY_TO, at: 0 });
    assert.equal(budget.status().spent, 1_000_000n);
    const [row] = await store.load();
    assert.ok(Math.abs(row.at - Date.now()) < 60_000, `the entry is dated ${row.at}`);
    await assert.rejects(store.append({ atomicAmount: 1_000_000n, asset: USDC, network: NETWORK, payTo: PAY_TO, at: 0 }), { reason: 'budget' });
    assert.equal(budget.status().spent, 1_000_000n);
  } finally {
    store.close();
    budget.close();
  }
});

test('a checksummed or CAIP-10 instrument spends from the one lowercase budget', async () => {
  const path = join(DIR, `cdp-${files++}.sqlite`);
  const budget = openBudget({ wallet: WALLET, path, perDay: '$1', create: true });
  await budget.pay('$1', async () => 'paid');
  // 0.2.x kept SharedBudgetStore's instrument as given: a checksummed address opened a second budget.
  const checksummed = '0xd797ead28C38575FDf4fC523866287372340Ca02';
  for (const instrument of [checksummed, `eip155:8453:${checksummed}`]) {
    const store = new SharedBudgetStore({ path, instrument, asset: USDC });
    try {
      assert.equal(store.instrument, WALLET);
      assert.throws(() => store.declare({ unit: 'usd', cap: 2_000_000n, windowMs: 86_400_000n }), /already declared with other limits/);
      await assert.rejects(store.append({ atomicAmount: 1n, asset: USDC, network: NETWORK, payTo: PAY_TO, at: Date.now() }), { reason: 'budget' });
    } finally {
      store.close();
    }
  }
  // A mistyped checksum is refused rather than opening a budget of its own.
  assert.throws(() => new SharedBudgetStore({ path, instrument: '0xD797ead28C38575FDf4fC523866287372340Ca02', asset: USDC }), /EIP-55/);
  const ledger = new Ledger(path);
  try {
    assert.deepEqual(ledger.budgets().map(row => row.instrument), [WALLET]);
  } finally {
    ledger.close();
    budget.close();
  }
});
