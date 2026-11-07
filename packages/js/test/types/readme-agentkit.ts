// SPDX-License-Identifier: Apache-2.0
// A README.md snippet, word for word between the markers, with what it assumes declared above
// them. test/types.test.mjs compiles it and checks it still matches the README.
// --- README ---
import { X402ActionProvider } from '@coinbase/agentkit';
import { openBudget } from 'walletcap';
import { guardAgentKit } from 'walletcap/agentkit';

const budget = await openBudget({ wallet: '0xYourAgentWallet' });
const x402 = guardAgentKit(new X402ActionProvider(), budget);
// AgentKit.from({ walletProvider, actionProviders: [x402] })
// --- end ---

export {};
