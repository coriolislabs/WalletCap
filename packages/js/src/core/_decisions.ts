// SPDX-License-Identifier: Apache-2.0
// Internal (not exported by the package): each budget handle's decision log, and the way an
// adapter reports a refusal it makes before any hold. Kept apart from budget.ts so the public
// declarations name none of it.
//
// A decision is what a handle did about a payment: held it, refused it, or moved a hold it took.
// Each one is handed to the handle's onDecision callback and appended, as one JSON line, to the
// file WALLETCAP_LOG named when the budget was opened. The log is outside the ledger and comes
// after it: by the time anything here runs the ledger has answered, so a callback that throws or a
// file that can't be written changes no payment. It is swallowed, with one warning.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Decision } from './budget.js';
import { BudgetRefused } from './errors.js';
import type { Outcome } from './ledger.js';
import { asMicros, expandHome, MAX_AMOUNT } from './money.js';
import { withJSON } from './wire.js';

// An adapter's refusal may repeat what a payee sent, at any length: a log line keeps this much of
// its brief, and of the payee's name, which is as much as a hold keeps.
const BRIEF_LIMIT = 1024;
const TO_LIMIT = 256;

/** What a decision is built from: the fields that apply to it. The rest are null. */
export interface DecisionFields {
  decision: Decision['decision'];
  /** The ledger's time, in milliseconds; null to take the process's. */
  at: bigint | null;
  amount: bigint | null;
  id?: string;
  rail: string;
  to?: string | null;
  refusal?: BudgetRefused;
  outcome?: Outcome;
  settlesBy?: bigint | null;
  tx?: string | null;
}

/** What is known about a payment that was refused. */
export interface Refused {
  rail: string;
  /** What was asked, in micro-dollars; null when an adapter could not price it. */
  amount?: bigint | null;
  /** Who would have been paid. */
  to?: string | null;
}

// The ledger's time, in milliseconds, of an answer of its own: a refusal, or a check that said no.
const answered = new WeakMap<object, bigint>();

/** Internal: `answer`, a refusal or a check that said no, dated with the ledger's time for it. */
export function stampLedgerTime<T extends object>(answer: T, at: bigint | undefined): T {
  if (at !== undefined) answered.set(answer, at);
  return answer;
}

/** Internal: the ledger's time for `answer`, if the ledger gave one. */
export const ledgerTimeOf = (answer: object): bigint | undefined => answered.get(answer);

// The refusals a decision log has been told about, and the copies adapters throw in their place.
const reported = new WeakSet<object>();

/** The file WALLETCAP_LOG names, with ~/ expanded as it is for WALLETCAP_PATH, or null. */
export function decisionLogFile(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const set = env.WALLETCAP_LOG;
  return set ? resolve(expandHome(set)) : null;
}

/**
 * One decision as its log line, without the line feed: its JSON, in ASCII. JSON escapes the
 * control characters, and every character past '~' is escaped here, as Python's json.dumps
 * writes it. So nothing a payee sent ends a line early for a reader that splits on more than line
 * feeds (U+2028, NEL) or reaches a terminal as a control code, and both languages write the same
 * bytes.
 */
export const logLine = (decision: Decision): string =>
  JSON.stringify(decision).replace(/[\u007f-\uffff]/g, unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);

// A name a warning may repeat: an error's class or its system code, never its message, which can
// carry what a payee sent.
const named = (value: unknown): string | null => (typeof value === 'string' && /^[A-Za-z0-9_$.]{1,64}$/.test(value) ? value : null);
const kindOf = (error: unknown): string => {
  try {
    const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
    return named(code) ?? named(name) ?? 'an error';
  } catch {
    // Whatever was thrown, reading it must not throw again.
    return 'an error';
  }
};

// One line, appended in one write to a file opened for append: the lines of several handles and
// processes interleave whole. The file is its owner's alone, and so is a folder made for it.
const append = (file: string, line: string): void => {
  try {
    appendFileSync(file, line, { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, line, { mode: 0o600 });
  }
};

/** One budget handle's decision log: its callback, its file, and the warnings it has given. */
export class DecisionLog {
  readonly #wallet: string;
  readonly #onDecision: ((decision: Decision) => unknown) | undefined;
  readonly #file: string | null;
  readonly #warned = { callback: false, file: false };

  constructor(wallet: string, onDecision: ((decision: Decision) => unknown) | undefined, file: string | null) {
    this.#wallet = wallet;
    this.#onDecision = onDecision;
    this.#file = file;
  }

  /** Log one decision. Never throws: the ledger has answered, and nothing here may change that. */
  record(fields: DecisionFields): void {
    if (this.#onDecision === undefined && this.#file === null) return;
    const { refusal } = fields;
    const decision = withJSON<Decision>({
      decision: fields.decision,
      at: new Date(fields.at === null ? Date.now() : Number(fields.at)),
      wallet: this.#wallet,
      amount: fields.amount === null ? null : asMicros(fields.amount),
      id: fields.id ?? null,
      rail: fields.rail,
      to: fields.to ?? null,
      code: refusal?.code ?? null,
      source: refusal?.source ?? null,
      // The brief, never the message: the message names other payments, for their owner.
      brief: typeof refusal?.brief === 'string' ? refusal.brief.slice(0, BRIEF_LIMIT) : null,
      outcome: fields.outcome ?? null,
      settlesBy: fields.settlesBy === undefined || fields.settlesBy === null ? null : new Date(Number(fields.settlesBy)),
      tx: fields.tx ?? null,
    });
    if (this.#file !== null) {
      try {
        // A payee's text reaches the file only as JSON strings.
        append(this.#file, `${logLine(decision)}\n`);
      } catch (error) {
        this.#warn(
          'file',
          `walletcap: the decision log ${this.#file} can't be written (${kindOf(error)}). ` +
            'Payments are decided as the budget says, without a log line; this warning is not repeated for this budget handle.',
        );
      }
    }
    if (this.#onDecision === undefined) return;
    const failed = (error: unknown): void =>
      this.#warn(
        'callback',
        `walletcap: the onDecision callback failed (${kindOf(error)}). ` +
          'Payments are decided as the budget says, and the callback is still called; this warning is not repeated for this budget handle.',
      );
    try {
      const result = this.#onDecision(decision);
      // An async callback isn't waited for, and its rejection is swallowed like a throw.
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
        Promise.resolve(result).then(undefined, failed);
      }
    } catch (error) {
      failed(error);
    }
  }

  /** Log a refusal, by the ledger or by an adapter in front of it, and remember it was logged. */
  refused(error: BudgetRefused, { rail, amount = null, to = null }: Refused): void {
    reported.add(error);
    this.record({ decision: 'refused', at: ledgerTimeOf(error) ?? null, amount, rail, to, refusal: error });
  }

  // Once per handle for the callback and once for the file, never once per payment.
  #warn(about: 'callback' | 'file', message: string): void {
    if (this.#warned[about]) return;
    this.#warned[about] = true;
    try {
      process.emitWarning(message, { type: 'BudgetWarning', code: 'WALLETCAP_DECISION_LOG' });
    } catch {
      /* a warning that can't be given changes no payment either */
    }
  }
}

const logs = new WeakMap<object, DecisionLog>();

export function registerDecisions(budget: object, log: DecisionLog): void {
  logs.set(budget, log);
}

/**
 * Tell `budget`'s decision log about a refusal an adapter is about to throw to its caller. One
 * refusal is logged once: an error that hold() or an earlier call has reported is passed over, and
 * so is anything that isn't a BudgetRefused.
 */
export function reportRefusal(budget: object, error: unknown, { rail, amount = null, to }: { rail: string; amount?: bigint | null; to?: unknown }): void {
  if (!(error instanceof BudgetRefused) || reported.has(error)) return;
  reported.add(error);
  logs.get(budget)?.refused(error, {
    rail,
    // An amount no budget could hold was never priced.
    amount: amount !== null && amount >= 0n && amount <= MAX_AMOUNT ? amount : null,
    // The payee's own word for itself, if it is text.
    to: typeof to === 'string' ? to.slice(0, TO_LIMIT) : null,
  });
}

/**
 * `error`, which a call to hold() threw or which stands in for one that did (forAgent's copy),
 * marked as reported: hold() has logged its own refusal, and the copy has no identity in common
 * with it, so the call site says so.
 */
export function alreadyReported<E>(error: E): E {
  if (error instanceof BudgetRefused) reported.add(error);
  return error;
}
