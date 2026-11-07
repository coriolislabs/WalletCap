// SPDX-License-Identifier: Apache-2.0
// What the budget throws, and the tag for a payment that never left.

/** A request is malformed, or the budget file cannot be read or trusted. */
export class BudgetError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BudgetError';
  }
}

/**
 * Why a payment was refused: the codes spec/schema.sql gives ('budget' for the rolling cap,
 * 'per_payment', 'max_payments', 'frozen'), or, from the x402 guard and the Agentic Wallet
 * wrapper, 'asset' (an asset the budget can't price) and 'timeout' (terms valid longer than an
 * hour, or that don't say how long).
 */
export type RefusalReason = 'budget' | 'per_payment' | 'max_payments' | 'frozen' | 'asset' | 'timeout';

/** Whose limit refused a payment: the budget's owner's, or the paying process's own. */
export type RefusalSource = 'budget' | 'process';

/**
 * The budget refused a payment. `source` is 'budget' for the owner's limits and 'process' for
 * the paying process's own. `brief` is the message without the ids of open payments or what
 * their owner can do about them: what an agent is told.
 */
export class BudgetRefused extends BudgetError {
  readonly reason: RefusalReason;
  readonly code: `budget_${RefusalReason}`;
  readonly brief: string;
  readonly source: RefusalSource;

  constructor(reason: RefusalReason, message: string, { brief = message, source = 'budget' }: { brief?: string; source?: RefusalSource } = {}) {
    super(message);
    this.name = 'BudgetRefused';
    this.reason = reason;
    this.code = `budget_${reason}`;
    this.brief = brief;
    this.source = source;
  }
}

/** `error` as an agent should be told it: a BudgetRefused's brief form, anything else as it is. */
export const forAgent = (error: unknown): unknown => (error instanceof BudgetRefused && error.brief !== error.message
  ? new BudgetRefused(error.reason, error.brief, { source: error.source })
  : error);

/**
 * The budget could not record what happened to a payment that went through, or may have: it
 * still counts as in flight. This is not a BudgetError, so code that retries on a BudgetError
 * does not pay twice. `reservationId` names the payment, and `cause` is why it could not be
 * recorded. Pass `settled: false` when the payment's outcome isn't a confirmed settlement.
 */
export class PaymentNotRecorded extends Error {
  readonly reservationId: string;

  constructor(reservationId: string, { settled = true, ...options }: { settled?: boolean; cause?: unknown } = {}) {
    super(settled
      ? `the payment went through but could not be recorded as settled; it still counts as in flight (${reservationId})`
      : `what happened to the payment could not be recorded; it still counts as in flight (${reservationId})`, options);
    this.name = 'PaymentNotRecorded';
    this.reservationId = reservationId;
  }
}

/** An error tagged with notSent(). */
export type NotSent<E> = E & { notSent: true };

/**
 * Tag an error to say the payment never left the wallet, so `pay()` gives its amount back
 * instead of counting it: `throw notSent(error)` or `throw notSent('card declined')`. Untagged
 * errors keep counting, because a payment that failed halfway may still have moved money.
 */
export function notSent<E>(error?: E): E extends Error ? NotSent<E> : NotSent<Error> {
  const tagged = (error instanceof Error ? error : new Error(error === undefined ? 'the payment was not sent' : String(error))) as Error & { notSent?: boolean };
  tagged.notSent = true;
  return tagged as E extends Error ? NotSent<E> : NotSent<Error>;
}

export const isNotSent = (error: unknown): boolean => error !== null && typeof error === 'object' && (error as { notSent?: unknown }).notSent === true;
