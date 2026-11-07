// SPDX-License-Identifier: Apache-2.0
// Run from an empty project where the packed walletcap and walletcap-mcp tarballs are installed:
// what a user gets from npm, every subpath included.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRefused, openBudget, openOwner, PaymentNotRecorded, UsageError } from 'walletcap';
import { guardAgenticWallet, usdcAtomic } from 'walletcap/agentic';
import { guardAgentKit } from 'walletcap/agentkit';
import { cdpStore } from 'walletcap/cdp';
import { guard, MAX_PAYMENT_TIMEOUT_SECONDS } from 'walletcap/x402';

const dir = mkdtempSync(join(tmpdir(), 'walletcap-smoke-'));
try {
  const wallet = '0xd797ead28c38575fdf4fc523866287372340ca02';
  const path = join(dir, 'budget.sqlite');
  const budget = await openBudget({ wallet, path, perPayment: '$0.75', perDay: '$1', create: true });
  await budget.pay('$0.60', async () => `0x${'ab'.repeat(32)}`);
  await assert.rejects(budget.pay('$0.50', async () => 'never'), error => error instanceof BudgetRefused && error.code === 'budget');
  const owner = await openOwner({ path });
  assert.equal((await owner.status(wallet)).spent, 600_000n);
  owner.close();
  budget.close();
  for (const fn of [guard, cdpStore, guardAgentKit, guardAgenticWallet, usdcAtomic]) assert.equal(typeof fn, 'function');
  assert.equal(MAX_PAYMENT_TIMEOUT_SECONDS, 3600);
  assert.ok(new UsageError('x') instanceof Error && !(new PaymentNotRecorded('wc-1') instanceof UsageError));
  process.stdout.write('walletcap from its tarball: pays, refuses, and every subpath loads\n');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
