// SPDX-License-Identifier: Apache-2.0
// One agent process paying over x402 with a guarded client from @x402/core.
// Payloads are created and signed offline, then settled (or refused) the way a
// server's answer would report it. Nothing is sent and no chain is involved.
import { existsSync, writeFileSync } from 'node:fs';
import { openBudget } from '../../index.mjs';
import { NETWORK, USDC, PAY_TO, x402 } from './x402-kit.mjs';

const config = JSON.parse(process.argv[2]);
const kit = await x402();
const budget = openBudget({ wallet: kit.account.address, path: config.path, ...config.limits, onWarning: () => {} });
const client = budget.guard(kit.client());
if (config.ready) writeFileSync(config.ready, String(process.pid));
if (config.go) {
  const until = Date.now() + 60_000;
  while (!existsSync(config.go)) {
    if (Date.now() > until) throw new Error('start signal timed out');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
const results = [];
for (const atomic of config.payments) {
  try {
    const payload = await client.createPaymentPayload(kit.required(atomic));
    await client.handlePaymentResponse({ paymentPayload: payload, requirements: payload.accepted, settleResponse: { success: true, transaction: `0x${'cd'.repeat(32)}`, network: NETWORK } });
    results.push('paid');
  } catch (error) {
    if (error.name !== 'BudgetRefused') throw error;
    results.push(error.reason);
  }
}
process.stdout.write(JSON.stringify({ results, spent: String(budget.status().spent), asset: USDC, payTo: PAY_TO }));
budget.close();
