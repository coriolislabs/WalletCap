// SPDX-License-Identifier: Apache-2.0
// What walletcap throws: four errors with no common base, so code that retries on one of them
// never retries a PaymentNotRecorded and pays twice. The Python package has the same four.

/**
 * The budget can't be read or written: there is no budget file or no budget for the wallet,
 * the file isn't a walletcap budget or a newer walletcap wrote it, its SQLite is older than
 * 3.37.0, another process held its write lock past busyTimeoutMs, or an I/O error. Nothing was
 * paid; whether to try again later is the caller's call.
 */
export class BudgetUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BudgetUnavailable';
  }
}

/**
 * Why a payment was refused. The ledger's limits: 'budget' (the rolling cap), 'per_payment',
 * 'max_payments' and 'frozen'. The adapters': 'asset' (an asset walletcap can't price),
 * 'timeout' (terms valid longer than an hour, or that don't say how long) and 'terms' (payment
 * terms walletcap can't read).
 */
export type RefusalCode = 'budget' | 'per_payment' | 'max_payments' | 'frozen' | 'asset' | 'timeout' | 'terms';

/** Whose limit refused a payment: the budget's owner's, or the paying process's own. */
export type RefusalSource = 'budget' | 'process';

/**
 * The budget refused a payment, and nothing was paid. `brief` is what an agent is told: the
 * message without the ids of open payments or what their owner can do about them.
 */
export class BudgetRefused extends Error {
  readonly code: RefusalCode;
  readonly brief: string;
  readonly source: RefusalSource;

  constructor(code: RefusalCode, message: string, { brief = message, source = 'budget' }: { brief?: string; source?: RefusalSource } = {}) {
    super(message);
    this.name = 'BudgetRefused';
    this.code = code;
    this.brief = brief;
    this.source = source;
  }
}

/**
 * A payment that went through, or may have, couldn't be recorded: it still counts as in flight.
 * Don't pay again. `paymentId` names the payment, and `cause` is why it couldn't be recorded.
 * Pass `settled: false` when the outcome wasn't a confirmed settlement.
 */
export class PaymentNotRecorded extends Error {
  readonly paymentId: string;

  constructor(paymentId: string, { settled = true, ...options }: { settled?: boolean; cause?: unknown } = {}) {
    super(settled
      ? `the payment went through but could not be recorded as settled; it still counts as in flight (${paymentId})`
      : `what happened to the payment could not be recorded; it still counts as in flight (${paymentId})`, options);
    this.name = 'PaymentNotRecorded';
    this.paymentId = paymentId;
  }
}

/**
 * The call itself is wrong: a malformed amount, wallet or option, a settle-by time that isn't
 * after now, a move a payment's state doesn't allow (voiding a settled payment), a payment
 * that doesn't exist, or an id already used for another payment. Nothing was paid.
 */
export class UsageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UsageError';
  }
}

/** Whether `error` is one walletcap threw about its own state or input (not a PaymentNotRecorded). */
export const isWalletcapError = (error: unknown): error is BudgetUnavailable | BudgetRefused | UsageError => error instanceof BudgetUnavailable
  || error instanceof BudgetRefused || error instanceof UsageError;

/** `error` as an agent should be told it: a BudgetRefused's brief form, anything else as it is. */
export const forAgent = (error: unknown): unknown => (error instanceof BudgetRefused && error.brief !== error.message
  ? new BudgetRefused(error.code, error.brief, { source: error.source })
  : error);

/** An error tagged with notSent(). */
export type NotSent<E> = E & { notSent: true };

/**
 * Tag an error to say the payment never left the wallet, so `pay()` voids it instead of
 * counting it: `throw notSent(error)` or `throw notSent('card declined')`. Untagged errors keep
 * counting, because a payment that failed halfway may still have moved money.
 */
export function notSent<E>(error?: E): E extends Error ? NotSent<E> : NotSent<Error> {
  const tagged = (error instanceof Error ? error : new Error(error === undefined ? 'the payment was not sent' : String(error))) as Error & { notSent?: boolean };
  tagged.notSent = true;
  return tagged as E extends Error ? NotSent<E> : NotSent<Error>;
}

export const isNotSent = (error: unknown): boolean => error !== null && typeof error === 'object' && (error as { notSent?: unknown }).notSent === true;
