// SPDX-License-Identifier: Apache-2.0
// One agent process: open the wallet's budget and try each payment in turn,
// optionally waiting for a start signal so several processes race.
import { existsSync, writeFileSync } from 'node:fs';
import { openBudget } from 'walletcap';

const config = JSON.parse(process.argv[2]);
const warnings = [];
const budget = await openBudget({ wallet: config.wallet, path: config.path, ...config.limits, onWarning: message => warnings.push(message) });
if (config.ready) writeFileSync(config.ready, String(process.pid));
if (config.go) {
  const until = Date.now() + 60_000;
  while (!existsSync(config.go)) {
    if (Date.now() > until) throw new Error('start signal timed out');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
const results = [];
for (const amount of config.payments) {
  try {
    await budget.pay(amount, async () => 'paid');
    results.push('paid');
  } catch (error) {
    if (error.name !== 'BudgetRefused') throw error;
    results.push(error.reason);
  }
}
process.stdout.write(JSON.stringify({ results, warnings, spent: String((await budget.status()).spent) }));
budget.close();
