// SPDX-License-Identifier: Apache-2.0
// A ten-second demo with a fake payee: no wallet, chain, key or network.
// Production code opens the budget with create: false; the owner creates it
// once with `npx walletcap set`.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetRefused, openBudget } from '../../packages/js/dist/index.js';

const PATH = join(dirname(fileURLToPath(import.meta.url)), 'demo.sqlite');
const WALLET = '0xd797ead28c38575fdf4fc523866287372340ca02';
const TX = `0x${'ab'.repeat(32)}`;

rmSync(PATH, { force: true });

const budget = await openBudget({
  wallet: WALLET,
  path: PATH,
  perPayment: '$0.05',
  perDay: '$0.15',
  create: true, // demo only
});

const attempt = async (target, label, amount) => {
  try {
    await target.pay(amount, async () => TX);
    console.log(`paid     ${label.padEnd(28)} ${amount}`);
  } catch (error) {
    if (!(error instanceof BudgetRefused)) throw error;
    console.log(`REFUSED  ${label.padEnd(28)} ${amount}  (${error.reason})`);
  }
};

console.log(`Budget: ${(await budget.status()).summary}\n`);
for (const amount of ['$0.05', '$0.05', '$0.05']) await attempt(budget, 'three small payments', amount);
await attempt(budget, 'past the per-payment cap', '$1.00');
await attempt(budget, 'past the rolling cap', '$0.05');

const beforeRestart = (await budget.status()).spent;
budget.close();

const warnings = [];
const restarted = await openBudget({
  wallet: WALLET,
  path: PATH,
  perPayment: '$2.50',
  perDay: '$5',
  onWarning: message => warnings.push(message),
});
console.log(`\nRestart asks for looser limits; stored limits stay: ${warnings[0] ?? 'no warning'}`);
console.log(`Count before restart: ${beforeRestart}; after restart: ${(await restarted.status()).spent}\n`);
await attempt(restarted, 'the same $0.05 after restart', '$0.05');

const final = await openBudget({ wallet: WALLET, path: PATH });
const status = await final.status();
const history = await final.history();
console.log(`\nFinal: ${status.summary}`);
console.log(`Result: ${status.spent} of ${status.cap} spent, ${status.remaining} left.`);
console.log(`History: ${history.length} payments; the first is ${history[0].status}.`);
final.close();
restarted.close();
