// SPDX-License-Identifier: Apache-2.0
// Internal (not exported by the package): each budget's ledger, for the adapters, which read what
// the public API doesn't give. Kept apart from budget.ts so the public declarations never name
// the Ledger class.
import { UsageError } from './errors.js';
import type { Ledger } from './ledger.js';

const ledgers = new WeakMap<object, Ledger>();

export function registerLedger(budget: object, ledger: Ledger): void {
  ledgers.set(budget, ledger);
}

/** The ledger a budget counts in. */
export function ledgerOf(budget: object): Ledger {
  const ledger = ledgers.get(budget);
  if (ledger === undefined) throw new UsageError('that is not a budget walletcap opened');
  return ledger;
}
