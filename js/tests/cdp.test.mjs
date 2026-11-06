// SPDX-License-Identifier: Apache-2.0
// The CDP SpendStore and the x402 guard share one budget file. They must not
// share a rail, and a 402 asset must not be able to break the store's loader.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openBudget } from '../index.mjs';
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
