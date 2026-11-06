// SPDX-License-Identifier: Apache-2.0
// The published @coinbase/cdp-sdk must be able to use walletcap as its
// durable SpendStore. This is the integration the private repo used to hold.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { applySpendControls } from '@coinbase/cdp-sdk/x402';
import { openBudget } from '../index.mjs';
import { NETWORK, USDC, x402 } from './support/x402-kit.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'walletcap-cdp-sdk-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

const kit = await x402();
const skip = kit === null && 'the x402/CDP devDependencies are not installed';

test('the published CDP SDK records a payment through walletcap cdpStore', { skip }, async () => {
  const path = join(DIR, 'sdk.sqlite');
  const budget = openBudget({ wallet: kit.account.address, path, perDay: '$1', create: true });
  const store = budget.cdpStore({ asset: USDC });
  try {
    const client = kit.client();
    applySpendControls(client, {
      maxAmountPerPayment: { atomic: 50_000n, asset: USDC },
      maxCumulativeSpend: { atomic: 150_000n, asset: USDC },
      maxCumulativeSpendWindow: '24h',
      allowedNetworks: [NETWORK],
      allowedAssets: [USDC],
      store,
    });
    const payload = await client.createPaymentPayload(kit.required(50_000));
    assert.ok(payload);
    assert.equal(budget.status().spent, 50_000n);
    const rows = await store.load();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].atomicAmount, 50_000n);
    assert.equal(rows[0].asset, USDC.toLowerCase());
  } finally {
    store.close();
    budget.close();
  }
});

const controls = store => ({
  maxAmountPerPayment: { atomic: 50_000n, asset: USDC },
  maxCumulativeSpend: { atomic: 150_000n, asset: USDC },
  maxCumulativeSpendWindow: '24h',
  allowedNetworks: [NETWORK],
  allowedAssets: [USDC],
  store,
});

test('the guard refuses a client that already has CDP spend controls', { skip }, () => {
  const path = join(DIR, 'conflict.sqlite');
  const budget = openBudget({ wallet: kit.account.address, path, perDay: '$1', create: true });
  const store = budget.cdpStore({ asset: USDC });
  try {
    const client = kit.client();
    applySpendControls(client, controls(store));
    assert.throws(() => budget.guard(client), /CDP spend controls/);
  } finally {
    store.close();
    budget.close();
  }
});

test('CDP controls added after the guard are refused before signing', { skip }, async () => {
  const path = join(DIR, 'conflict-late.sqlite');
  const budget = openBudget({ wallet: kit.account.address, path, perDay: '$1', create: true });
  const store = budget.cdpStore({ asset: USDC });
  try {
    const client = kit.client();
    budget.guard(client);
    applySpendControls(client, controls(store));
    await assert.rejects(
      client.createPaymentPayload(kit.required(50_000)),
      /CDP spend controls|Use one/,
    );
    assert.equal(budget.status().spent, 0n);
    assert.equal(budget.status().inFlight, 0n);
  } finally {
    store.close();
    budget.close();
  }
});
