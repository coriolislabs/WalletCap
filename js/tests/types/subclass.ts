// SPDX-License-Identifier: Apache-2.0
// The 0.2.2 README's AgentKit recipe, kept to show why it was replaced: TypeScript refuses a
// subclass that overrides a private member.
import { X402ActionProvider } from '@coinbase/agentkit';
import { openBudget } from 'walletcap';

const budget = openBudget({ wallet: '0xd797ead28c38575fdf4fc523866287372340ca02', perDay: '$1' });

export class BudgetedX402ActionProvider extends X402ActionProvider {
  async createX402Client(walletProvider: unknown) {
    return budget.guard(await super.createX402Client(walletProvider));
  }
}
