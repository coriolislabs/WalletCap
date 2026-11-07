// SPDX-License-Identifier: Apache-2.0
// A README.md snippet, word for word between the markers, with what it assumes declared above
// them. test/types.test.mjs compiles it and checks it still matches the README.
import type { Budget } from 'walletcap';

declare const budget: Budget;
declare const orderId: number;
declare function sendUsdc(to: string, amount: string): Promise<string>;
declare const payee: string;
declare function neverBroadcast(error: unknown): boolean;
// --- README ---
const hold = await budget.hold('$5', { id: `order-${orderId}`, settlesWithin: 300_000 });
try {
  const tx = await sendUsdc(payee, '5');
  await hold.settle({ tx });
} catch (error) {
  if (neverBroadcast(error)) await hold.void({ evidence: String(error) });
  else await hold.note('unknown', String(error)); // it keeps counting
}
// --- end ---

export {};
