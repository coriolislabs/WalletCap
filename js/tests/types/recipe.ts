// SPDX-License-Identifier: Apache-2.0
// The README's AgentKit recipe: it must compile against AgentKit's own types.
import { X402ActionProvider } from '@coinbase/agentkit';
import { openBudget } from 'walletcap';

const budget = openBudget({ wallet: '0xd797ead28c38575fdf4fc523866287372340ca02', perPayment: '$0.02', perDay: '$1' });

export const x402: X402ActionProvider = budget.guardAgentKit(new X402ActionProvider());
