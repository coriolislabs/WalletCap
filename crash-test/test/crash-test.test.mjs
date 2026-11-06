// SPDX-License-Identifier: Apache-2.0
// The crash test end to end: Coinbase's published SDK breaks where the README says it does, and
// walletcap holds every event at $0 over the cap.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crashTest, report } from '../cli.mjs';

const USD = 1_000_000n;

test("CDP's controls let money past the cap on every event; walletcap holds each one at $0", async () => {
  const run = await crashTest();
  const by = Object.fromEntries(run.scenarios.map(s => [s.id, s]));

  // A restart hands the in-memory store a fresh count: the cap is paid twice.
  assert.equal(by.restart.cdp.usdc, 300n * USD);
  assert.equal(by.restart.walletcap.usdc, 150n * USD);

  // Ten replicas each keep their own count.
  assert.equal(by.replicas.cdp.usdc, 1_500n * USD);
  assert.equal(by.replicas.walletcap.usdc, 150n * USD);

  // On one shared store the overlap varies from run to run; walletcap's never does.
  assert.ok(by['shared-store'].cdp.usdc >= 150n * USD);
  assert.equal(by['shared-store'].walletcap.usdc, 150n * USD);

  // The README's controls count USDC only, so a payee asking for EURC is paid in full.
  assert.equal(by['asset-switch'].cdp.eurc, 1_000n * USD);
  assert.equal(by['asset-switch'].walletcap.eurc, 0n);
  assert.equal(by['asset-switch'].walletcap.refused, 1);

  for (const s of run.scenarios) assert.equal(s.walletcap.over, 0n, `${s.id}: walletcap let money past the cap`);
  assert.match(report(run), /with walletcap\./);
  assert.ok(run.seconds < 60, `the crash test took ${run.seconds}s`);
});
