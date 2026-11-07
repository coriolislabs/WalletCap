// SPDX-License-Identifier: Apache-2.0
// A README.md snippet, word for word between the markers, with what it assumes declared above
// them. test/types.test.mjs compiles it and checks it still matches the README.
declare function sendIpcRequest(channel: string, data: Record<string, unknown>): Promise<unknown>;
declare const payee: string;
// --- README ---
import { openBudget } from 'walletcap';
import { guardAgenticWallet } from 'walletcap/agentic';

const budget = await openBudget({ wallet: '0xYourAgentWallet' });
const wallet = guardAgenticWallet(budget, { request: sendIpcRequest });
await wallet.request('send-transaction', { recipient: payee, amountAtomic: '50000', asset: 'USDC', chain: 'base' });
// --- end ---

export {};
