// SPDX-License-Identifier: Apache-2.0
// The crash test end to end: Coinbase's published SDK breaks where the README says it does, and
// walletcap holds every event at $0 over the cap, as its guard and as CDP's store.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { agentkitRow, crashTest, held, report } from '../cli.mjs';

const USD = 1_000_000n;
const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));

// One full run, shared by the tests that read it.
let fullRun;
const crashTestOnce = () => (fullRun ??= crashTest());

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

test("CDP's controls let money past the cap on every event; walletcap's guard holds each one at $0", async () => {
  const run = await crashTestOnce();
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

  assert.match(report(run), /\$0 with walletcap's guard and AccountCapSpender; \$0 with CDP's controls on walletcap's cdpStore\./);
  assert.ok(run.seconds < 60, `the crash test took ${run.seconds}s`);
});

test("CDP's controls on walletcap's cdpStore, set as walletcap's README shows, hold every event at $0", async () => {
  const run = await crashTestOnce();
  const by = Object.fromEntries(run.scenarios.map(s => [s.id, s]));
  // CDP refuses on its own check, or walletcap's store refuses when CDP records past the cap.
  const refusals = new Set(['cumulative_cap', 'budget_budget']);

  // The restarted process reads the first one's $150 from the budget file, and CDP refuses it.
  assert.equal(by.restart.cdpStore.usdc, 150n * USD);
  assert.equal(by.restart.cdpStore.refused, 5);
  assert.deepEqual(by.restart.cdpStore.reasons, ['cumulative_cap']);

  // Ten replicas record into one budget file: three $50 payments, and 27 refused.
  assert.equal(by.replicas.cdpStore.usdc, 150n * USD);
  assert.equal(by.replicas.cdpStore.refused, 27);
  assert.ok(by.replicas.cdpStore.reasons.every(reason => refusals.has(reason)), by.replicas.cdpStore.reasons.join(', '));

  // With the store 1 ms away, more replicas pass CDP's check together; the store's re-check holds.
  assert.equal(by['shared-store'].cdpStore.usdc, 150n * USD);
  assert.equal(by['shared-store'].cdpStore.refused, 27);
  assert.ok(by['shared-store'].cdpStore.reasons.every(reason => refusals.has(reason)), by['shared-store'].cdpStore.reasons.join(', '));

  // allowedAssets, which walletcap's README sets, refuses EURC before signing.
  assert.equal(by['asset-switch'].cdpStore.eurc, 0n);
  assert.equal(by['asset-switch'].cdpStore.refused, 1);
  assert.deepEqual(by['asset-switch'].cdpStore.reasons, ['asset_not_allowed']);

  for (const s of run.scenarios) {
    assert.equal(s.cdpStore.over, 0n, `${s.id}: CDP on walletcap's cdpStore let money past the cap`);
    assert.equal(s.cdpStore.eurc, 0n, `${s.id}: CDP on walletcap's cdpStore signed EURC`);
  }
  assert.match(report(run), /walletcap guard {2,}walletcap cdpStore/);
});

test("the run fails if walletcap's guard or CDP on walletcap's cdpStore lets anything past the cap", async () => {
  const run = await crashTestOnce();
  assert.equal(held(run), true);
  const leak = (arm, result) => ({ ...run, scenarios: run.scenarios.map(s => (s.id === 'replicas' ? { ...s, [arm]: { ...s[arm], ...result } } : s)) });
  assert.equal(held(leak('cdpStore', { usdc: 200n * USD, over: 50n * USD })), false);
  assert.equal(held(leak('cdpStore', { eurc: 1_000n * USD })), false);
  assert.equal(held(leak('walletcap', { usdc: 200n * USD, over: 50n * USD })), false);
  // CDP's own controls are what's measured: their overage is the finding, not a failure.
  assert.equal(held(leak('cdp', { usdc: 1_500n * USD, over: 1_350n * USD })), true);
  // With AgentKit, walletcap may sign the 1¢ the agent approved, never the first-listed $1.00.
  const agentkit = received => ({ ...run, agentkit: { walletcap: { received } } });
  assert.equal(held(agentkit([])), true);
  assert.equal(held(agentkit([{ network: 'eip155:84532', amount: '10000', toStranger: false }])), true);
  assert.equal(held(agentkit([{ network: 'eip155:8453', amount: '1000000', toStranger: true }])), false);
  assert.equal(held(agentkit([{ network: 'eip155:84532', amount: '30000', toStranger: false }])), false);
});

const agentkitInstalled = (() => {
  try {
    import.meta.resolve('@coinbase/agentkit');
    return true;
  } catch {
    return false;
  }
})();

test("AgentKit signs the merchant's first-listed $1.00 on mainnet and reports the 1¢ it was given; walletcap signs the 1¢", { skip: !agentkitInstalled && '@coinbase/agentkit is not installed alongside' }, async () => {
  const row = await agentkitRow();
  assert.deepEqual(row.agentkit.received.map(p => [p.network, p.amount, p.toStranger]), [['eip155:8453', '1000000', true]]);
  assert.deepEqual([row.agentkit.reported.network, row.agentkit.reported.amount], ['eip155:84532', '10000']);
  // walletcap passes over the $1.00, valid 4 days, and pays the 1¢ offer the agent approved.
  assert.deepEqual(row.walletcap.received.map(p => [p.network, p.amount, p.toStranger]), [['eip155:84532', '10000', false]]);
  assert.equal(row.walletcap.refused, false);
});

test('Spend Permissions does hold one permission within one period: the fourth $50 is refused', async () => {
  const { at, vendorRun } = await import('../spend-permissions.mjs');
  const run = await vendorRun({ permissions: [1n], steps: Array(4).fill({ permission: 0, at: at(3_600n) }) });
  assert.equal(run.pulled, 150n * USD);
  assert.deepEqual(run.refusals, ['ExceededSpendPermission']);
});
