// SPDX-License-Identifier: Apache-2.0
// walletcap: one spend budget per wallet, counted across every process, replica, key,
// permission and payment rail on one host that pays from it.
//
// This entry point is the core: the payer's handle (openBudget), the owner's (openOwner) and the
// four errors. The vendor adapters are subpath exports that import it: walletcap/x402,
// walletcap/cdp, walletcap/agentkit and walletcap/agentic.
export { Budget, Hold, openBudget } from './core/budget.js';
export type { BudgetOptions, Check, HeldPayment, HoldOptions, Payment, PaymentRecord, Status } from './core/budget.js';
export { BudgetRefused, BudgetUnavailable, notSent, PaymentNotRecorded, UsageError } from './core/errors.js';
export type { NotSent, RefusalCode, RefusalSource } from './core/errors.js';
export { MIN_SQLITE_VERSION, SCHEMA_VERSION } from './core/ledger.js';
export type { Outcome, PaymentState } from './core/ledger.js';
export { defaultBudgetPath, formatUsd, MAX_AMOUNT, toMicros } from './core/money.js';
export type { Dollars, LimitOptions, Micros, Window } from './core/money.js';
export { openOwner, Owner } from './core/owner.js';
export type { BudgetLimits, OwnerOptions, VoidedPayment } from './core/owner.js';
