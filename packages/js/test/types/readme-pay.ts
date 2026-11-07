// SPDX-License-Identifier: Apache-2.0
// A README.md snippet, word for word between the markers, with what it assumes declared above
// them. test/types.test.mjs compiles it and checks it still matches the README.
declare const account: { address: string };
declare function sendUsdc(to: string, amount: string): Promise<string>;
declare const payee: string;
// --- README ---
import { openBudget } from 'walletcap';

const budget = await openBudget({ wallet: account.address });

await budget.pay('$12.50', () => sendUsdc(payee, '12.50')); // refused past $150 in any 24h, restarts included
// --- end ---

export {};
