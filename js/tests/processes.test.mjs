// SPDX-License-Identifier: Apache-2.0
// Separate processes stand in for a restart and for replicas: the budget lives in
// the file, so neither starts the count again.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openBudget } from '../index.mjs';
import { race, run } from './support/race.mjs';
import { x402 } from './support/x402-kit.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'walletcap-processes-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

const WALLET = '0xd797ead28c38575fdf4fc523866287372340ca02';
const LIMITS = { perPayment: '$50', perDay: '$150' };
const count = (results, outcome) => results.flatMap(result => result.results).filter(entry => entry === outcome).length;

test('a restarted agent finds the count where it left it, even with looser limits in its code', async () => {
  const path = join(DIR, 'restart.sqlite');
  const first = await run('payer.mjs', { wallet: WALLET, path, limits: LIMITS, payments: ['$50', '$50', '$50'] });
  assert.deepEqual(first.results, ['paid', 'paid', 'paid']);
  const restarted = await run('payer.mjs', { wallet: WALLET, path, limits: { perPayment: '$100', perDay: '$5000' }, payments: ['$50', '$2'] });
  assert.deepEqual(restarted.results, ['budget', 'budget']);
  assert.equal(restarted.warnings.length, 1);
  assert.equal(restarted.spent, '150000000');
});

test('replicas racing for the last of the budget cannot both win', async () => {
  const path = join(DIR, 'race.sqlite');
  openBudget({ wallet: WALLET, path, ...LIMITS }).close();
  // Four replicas, three $50 payments each, against $150: exactly three may win.
  const results = await race('payer.mjs', DIR, Array.from({ length: 4 }, () => ({ wallet: WALLET, path, limits: LIMITS, payments: ['$50', '$50', '$50'] })));
  assert.equal(count(results, 'paid'), 3);
  assert.equal(count(results, 'budget'), 9);
  assert.equal(openBudget({ wallet: WALLET, path }).status().spent, 150_000_000n);
});

test('x402 replicas racing with guarded clients cannot pass the shared cap', async t => {
  const kit = await x402();
  if (kit === null) return t.skip('the x402 devDependencies are not installed');
  const path = join(DIR, 'x402-race.sqlite');
  openBudget({ wallet: kit.account.address, path, ...LIMITS }).close();
  const results = await race('x402-payer.mjs', DIR, Array.from({ length: 3 }, () => ({ path, limits: LIMITS, payments: [50_000_000, 50_000_000, 50_000_000] })));
  assert.equal(count(results, 'paid'), 3);
  assert.equal(openBudget({ wallet: kit.account.address, path }).status().spent, 150_000_000n);
  return undefined;
});
