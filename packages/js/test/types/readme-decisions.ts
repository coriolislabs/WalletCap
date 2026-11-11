// SPDX-License-Identifier: Apache-2.0
// A README.md snippet, word for word between the markers, with what it assumes declared above
// them. test/types.test.mjs compiles it and checks it still matches the README.
import { openBudget } from 'walletcap';

declare const account: { address: string };
declare const logger: { info(entry: unknown): void };
// --- README ---
const budget = await openBudget({
  wallet: account.address,
  onDecision: decision => logger.info(decision), // held, refused, bound, noted, settled, void
});
// --- end ---

export { budget };
