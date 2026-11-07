// SPDX-License-Identifier: Apache-2.0
// walletcap: one spend budget per wallet, counted across every process, replica, key,
// permission and payment rail on one host that pays from it.
//
// This entry point is the core. The vendor adapters are subpath exports that import it:
// walletcap/x402, walletcap/cdp, walletcap/agentkit and walletcap/agentic.
export { Budget, openBudget, Reservation } from './core/budget.js';
export type { BudgetOptions, Check, Hold, Payment, PaymentDetails, Status } from './core/budget.js';
export { BudgetError, BudgetRefused, notSent, PaymentNotRecorded } from './core/errors.js';
export type { RefusalReason, RefusalSource } from './core/errors.js';
export { SCHEMA_VERSION } from './core/ledger.js';
export { defaultBudgetPath, formatUsd, MAX_AMOUNT, toMicros } from './core/money.js';
export type { Dollars, LimitOptions, Micros, Window } from './core/money.js';
