// SPDX-License-Identifier: Apache-2.0
// One JavaScript payer in the race (race.mjs): holds, then settles, voids, notes or bounds, over
// and over, until it is killed. Refusals and lock waits are expected; anything else is a failure.
import { BudgetRefused, BudgetUnavailable, openBudget } from '../../packages/js/dist/index.js';

const [path, wallet] = process.argv.slice(2);
const budget = await openBudget({ wallet, path });
const random = (low, high) => low + Math.floor(Math.random() * (high - low + 1));
const expected = error => error instanceof BudgetRefused || error instanceof BudgetUnavailable;

for (;;) {
  const amount = BigInt(random(1, 5)) * 1_000_000n;
  const open = Math.random() < 0.1;
  let hold;
  try {
    hold = await budget.hold(amount, open ? {} : { settlesWithinMs: random(200, 1700) });
  } catch (error) {
    if (!expected(error)) throw error;
    await new Promise(done => setTimeout(done, 5));
    continue;
  }
  try {
    if (open) await hold.settlesWithin(random(200, 1700));
    const roll = Math.random();
    if (roll < 0.5) await hold.settle({ tx: `0x${random(0, 0xffffff).toString(16).padStart(64, '0')}` });
    else if (roll < 0.7) await hold.void({ reason: 'race: not sent' });
    else if (roll < 0.85) await hold.note('unknown', 'race');
  } catch (error) {
    if (!(error instanceof BudgetUnavailable)) throw error;
  }
}
