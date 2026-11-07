// SPDX-License-Identifier: Apache-2.0
// The budget on Coinbase AgentKit's x402 actions. AgentKit is not a devDependency (it pulls in
// some 35 packages), so a stand-in builds its x402 client exactly as AgentKit 0.10.4's
// X402ActionProvider.createX402Client does, with x402's real client and EVM scheme.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BudgetRefused, openBudget, UsageError } from 'walletcap';
import { guardAgentKit } from 'walletcap/agentkit';
import { NETWORK, PAY_TO, USDC, x402 } from './support/x402-kit.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'walletcap-agentkit-'));
// Windows keeps a budget file a test left open; its temp folder is cleared later.
after(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* open on Windows */ } });
const kit = await x402();
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const STRANGER = '0x1111111111111111111111111111111111111111';
const settled = { success: true, transaction: `0x${'cd'.repeat(32)}`, network: NETWORK };

// AgentKit 0.10.4: each x402 action calls this.createX402Client(walletProvider) for a fresh client,
// which registers the exact EVM scheme for every eip155 network.
const standIn = async () => {
  const { x402Client } = await import('@x402/core/client');
  const { registerExactEvmScheme } = await import('@x402/evm/exact/client');
  return new class X402ActionProvider {
    async createX402Client(walletProvider) {
      const client = registerExactEvmScheme(new x402Client(), { signer: walletProvider.account });
      client.setSpendControls(false); // x402's own default cap stays out of the measurement
      return client;
    }

    async pay(walletProvider, required) {
      const client = await this.createX402Client(walletProvider);
      const payload = await client.createPaymentPayload(required);
      await client.handlePaymentResponse({ paymentPayload: payload, requirements: payload.accepted, settleResponse: settled });
      return payload.accepted;
    }
  }();
};

const skip = kit === null && 'the x402 devDependencies are not installed';

test("every client an AgentKit provider builds is guarded, and the merchant's first-listed $1 is refused before signing", { skip }, async () => {
  const budget = await openBudget({ wallet: kit.account.address, path: join(DIR, 'agentkit.sqlite'), perPayment: '$0.02', perDay: '$0.05', create: true });
  const provider = guardAgentKit(await standIn(), budget);
  const wallet = { account: kit.account };
  // The agent approved a 1¢ test quote; the merchant listed $1.00 of real USDC on Base mainnet first.
  const baitAndSwitch = kit.required(10_000);
  baitAndSwitch.accepts.unshift({ ...baitAndSwitch.accepts[0], network: 'eip155:8453', asset: BASE_USDC, amount: '1000000', payTo: STRANGER });
  await assert.rejects(provider.pay(wallet, baitAndSwitch), error => error instanceof BudgetRefused && error.code === 'per_payment');
  // Each action builds a new client, and every one of them spends from the same budget.
  for (let i = 0; i < 5; i += 1) await provider.pay(wallet, kit.required(10_000));
  await assert.rejects(provider.pay(wallet, kit.required(10_000)), error => error instanceof BudgetRefused && error.code === 'budget');
  assert.equal((await budget.status()).spent, 50_000n);
  assert.deepEqual((await budget.history()).map(p => p.to), Array(5).fill(PAY_TO));
  budget.close();
});

test('only an AgentKit x402 provider can be guarded, and only once', { skip }, async () => {
  const budget = await openBudget({ wallet: kit.account.address, path: join(DIR, 'once.sqlite'), perDay: '$1', create: true });
  assert.throws(() => guardAgentKit({}, budget), UsageError);
  const badAssets = await standIn();
  assert.throws(() => guardAgentKit(badAssets, budget, { assets: [{ network: NETWORK }] }), UsageError);
  const provider = guardAgentKit(await standIn(), budget, { assets: [{ network: NETWORK, asset: USDC, decimals: 6 }] });
  assert.throws(() => guardAgentKit(provider, budget), /already has a budget guard/);
  budget.close();
});
