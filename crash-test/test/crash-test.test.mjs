// SPDX-License-Identifier: Apache-2.0
// The crash test end to end: Coinbase's published SDK breaks where the README says it does, and
// walletcap holds every event at $0 over the cap.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { agentkitRow, crashTest, report } from '../cli.mjs';

const USD = 1_000_000n;
const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));

test('the CLI runs through a symlink, as npm runs a bin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'walletcap-crash-bin-'));
  try {
    const link = join(dir, 'walletcap-crash-test');
    symlinkSync(CLI, link);
    const run = spawnSync(process.execPath, [link, '--version'], { encoding: 'utf8' });
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), version);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

  // Spend Permissions, on Coinbase's deployed code: each permission and each period is a new $150.
  const sp = Object.fromEntries(run.spendPermissions.rows.map(r => [r.id, r]));
  assert.equal(sp['second-permission'].vendor.pulled, 300n * USD);
  assert.equal(sp['second-permission'].walletcap.pulled, 150n * USD);
  assert.equal(sp['period-boundary'].vendor.pulled, 300n * USD);
  assert.equal(sp['period-boundary'].walletcap.pulled, 150n * USD);
  assert.ok(run.spendPermissions.rows.every(r => r.walletcap.refusals.every(reason => reason === 'OverBudget')));

  assert.match(report(run), /with walletcap\./);
  assert.ok(run.seconds < 60, `the crash test took ${run.seconds}s`);
});

const agentkitInstalled = (() => {
  try {
    import.meta.resolve('@coinbase/agentkit');
    return true;
  } catch {
    return false;
  }
})();

test("AgentKit signs the merchant's first-listed $1.00 on mainnet and reports the 1¢ it was given; walletcap refuses", { skip: !agentkitInstalled && '@coinbase/agentkit is not installed alongside' }, async () => {
  const row = await agentkitRow();
  assert.deepEqual(row.agentkit.received.map(p => [p.network, p.amount, p.toStranger]), [['eip155:8453', '1000000', true]]);
  assert.deepEqual([row.agentkit.reported.network, row.agentkit.reported.amount], ['eip155:84532', '10000']);
  assert.deepEqual(row.walletcap.received, []);
  assert.equal(row.walletcap.refused, true);
});

test('Spend Permissions does hold one permission within one period: the fourth $50 is refused', async () => {
  const { at, vendorRun } = await import('../spend-permissions.mjs');
  const run = await vendorRun({ permissions: [1n], steps: Array(4).fill({ permission: 0, at: at(3_600n) }) });
  assert.equal(run.pulled, 150n * USD);
  assert.deepEqual(run.refusals, ['ExceededSpendPermission']);
});
