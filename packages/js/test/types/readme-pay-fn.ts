// SPDX-License-Identifier: Apache-2.0
// A README.md snippet, word for word between the markers, with what it assumes declared above
// them. test/types.test.mjs compiles it and checks it still matches the README.
import type { Budget } from 'walletcap';

declare const budget: Budget;
declare const wallet: { sendTransaction(request: unknown): Promise<string> };
declare const request: unknown;
declare const payee: string;
// --- README ---
const tx = await budget.pay('$5', async hold => {
  return wallet.sendTransaction(request); // hold.id makes a good idempotency key
}, { to: payee, note: 'weather API' });
// --- end ---

export {};
