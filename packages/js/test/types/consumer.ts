// SPDX-License-Identifier: Apache-2.0
// A consumer of the packed package, compiled by test/types.test.mjs with skipLibCheck off, only
// es2022's library and no @types/node: walletcap's declarations must need nothing else. The
// expected errors below check the declarations refuse what the runtime refuses.
import { BudgetRefused, defaultBudgetPath, Hold, type Micros, openBudget, openOwner, type Status, UsageError } from 'walletcap';
import { guardAgenticWallet } from 'walletcap/agentic';
import { guardAgentKit } from 'walletcap/agentkit';
import { cdpStore } from 'walletcap/cdp';
import { guard, MAX_PAYMENT_TIMEOUT_SECONDS, type X402HookedClient } from 'walletcap/x402';

export async function use(client: X402HookedClient, provider: object): Promise<Micros> {
  await using budget = await openBudget({ wallet: '0xd797ead28c38575fdf4fc523866287372340ca02', perDay: '$150' });
  const hold = await budget.hold('$1', { id: 'order-1', settlesWithin: MAX_PAYMENT_TIMEOUT_SECONDS * 1000 });
  await hold.settle({ tx: `0x${'ab'.repeat(32)}` });
  const status: Status = await budget.status();
  guard(client, budget);
  await cdpStore(budget, { asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }).load();
  guardAgentKit(provider, budget);
  const wallet = guardAgenticWallet(budget, { request: async () => ({}) });
  await wallet.request('send-transaction', { recipient: '0x', amountAtomic: '1' });
  const owner = await openOwner({ path: budget.path });
  owner.close();
  const error: unknown = null;
  if (error instanceof BudgetRefused) return status.spent;
  if (error instanceof UsageError) return status.inFlight;
  // @ts-expect-error Budget.hold() makes a Hold; it has no public constructor.
  new Hold();
  // @ts-expect-error the wallet's request channel is required.
  guardAgenticWallet(budget, {});
  // @ts-expect-error defaultBudgetPath() takes no arguments.
  defaultBudgetPath({}, 'linux', '/home');
  return status.remaining;
}
