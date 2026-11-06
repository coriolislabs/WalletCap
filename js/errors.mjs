// SPDX-License-Identifier: Apache-2.0
// What the budget throws, and the tag for a payment that never left.

/** A request is malformed, or the budget file cannot be read or trusted. */
export class BudgetError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'BudgetError';
  }
}

/**
 * The budget refused a payment. `reason` is one of 'budget', 'per_payment',
 * 'uses' and 'revoked' (the budget is frozen), the codes the Python ledger uses
 * too, or, from the x402 guard, 'asset' (an asset the budget cannot price) or
 * 'timeout' (the payee asks for an authorization valid longer than an hour).
 */
export class BudgetRefused extends BudgetError {
  constructor(reason, message) {
    super(message);
    this.name = 'BudgetRefused';
    this.reason = reason;
    this.code = `budget_${reason}`;
  }
}

/**
 * The payment went through, but the budget could not record it as settled. It
 * still counts as in flight. This is not a BudgetError, so code that retries on
 * a BudgetError does not pay twice. `reservationId` names the payment, and
 * `cause` is why it could not be recorded.
 */
export class PaymentNotRecorded extends Error {
  constructor(reservationId, options) {
    super(`the payment went through but could not be recorded as settled; it still counts as in flight (${reservationId})`, options);
    this.name = 'PaymentNotRecorded';
    this.reservationId = reservationId;
  }
}

/**
 * Tag an error to say the payment never left the wallet, so `pay()` gives its
 * amount back instead of counting it: `throw notSent(error)` or
 * `throw notSent('card declined')`. Untagged errors keep counting, because a
 * payment that failed halfway may still have moved money.
 */
export function notSent(error) {
  const tagged = error instanceof Error
    ? error
    : new Error(error === undefined ? 'the payment was not sent' : String(error));
  tagged.notSent = true;
  return tagged;
}

export const isNotSent = error => error !== null && typeof error === 'object' && error.notSent === true;
