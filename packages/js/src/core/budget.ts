// SPDX-License-Identifier: Apache-2.0
/// <reference lib="esnext.disposable" preserve="true" />
// The payer's handle: one wallet's budget, counted across every process, replica, key,
// permission and payment rail on one host that pays from it. A payer checks, holds and pays,
// and reads what counts; changing limits, freezing and voiding or settling by id are the
// owner's (owner.ts). The core imports no vendor adapter; the adapters import the core.
//
// Agent payment kits count "spent so far" per process, per key, per permission or per period, so
// a restart, a second replica, one more key or the next period starts the count again. This
// budget is counted per wallet, in a file every process on the host shares, over a rolling
// window. Changing a limit never resets what has been spent, the limits a payer passes only
// tighten things for its own process, and if the count cannot be read, nothing is paid.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type DecisionFields, DecisionLog, decisionLogFile, ledgerTimeOf, registerDecisions, stampLedgerTime } from './_decisions.js';
import { registerLedger } from './_ledgers.js';
import { BudgetRefused, BudgetUnavailable, isNotSent, PaymentNotRecorded, type RefusalCode, type RefusalSource, spendNotSent, UsageError } from './errors.js';
import {
  type BudgetRow,
  type Held,
  Ledger,
  mergedNoteOf,
  type Moved,
  OPEN,
  type Outcome,
  type PaymentRow,
  type PaymentState,
  type ProcessLimits,
  type StatusRow,
  heldElsewhere,
} from './ledger.js';
import {
  checkKeys,
  defaultBudgetPath,
  describeLimits,
  type Dollars,
  expandHome,
  formatUsd,
  formatWindow,
  type LimitOptions,
  type Limits,
  limitFlags,
  type Micros,
  normalizeWallet,
  parseLimits,
  shortWallet,
  toMicros,
} from './money.js';
import { withJSON } from './wire.js';

const LIMIT_KEYS = ['perPayment', 'perHour', 'perDay', 'perWeek', 'cap', 'window', 'maxPayments'];
const OPTION_KEYS = new Set(['wallet', 'path', 'create', 'busyTimeoutMs', 'onWarning', 'onDecision', ...LIMIT_KEYS]);
const HOLD_KEYS = new Set(['id', 'to', 'note', 'details', 'rail', 'settlesBy', 'settlesWithin']);
const TO_LIMIT = 256;
const NOTE_LIMIT = 1024;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export interface BudgetOptions extends LimitOptions {
  /** The wallet or account the money leaves from. EVM addresses are lowercased, bare or CAIP-10. */
  wallet: string;
  /** The budget file. Defaults to $WALLETCAP_PATH, else the per-user state directory. */
  path?: string;
  /**
   * Create the file and the wallet's budget, with these limits, if missing. Defaults to false:
   * its owner creates them (`walletcap set`). Pass true only for a demo or a first-run setup.
   */
  create?: boolean;
  /** How long to wait for another process's write, in milliseconds. Defaults to 30000. Between tries the wait is on the event loop; each try can hold it for up to about 10 ms, SQLite's own wait. */
  busyTimeoutMs?: number;
  /** Called instead of process.emitWarning when a limit this code asks for is looser than the budget's, and so does nothing. */
  onWarning?: (message: string) => void;
  /**
   * Called once for every decision made through this handle: a hold admitted ('held'), a payment
   * refused by the budget or by an adapter in front of it ('refused'), and each move of a hold this
   * handle took ('bound', 'noted', 'settled', 'void'). It is called after the ledger has answered
   * and is never waited for, so nothing it does changes a decision: what it throws, or rejects
   * with, is swallowed, with one warning for the handle. check() and reads report nothing.
   *
   * If the environment variable WALLETCAP_LOG names a file when the budget is opened, each decision
   * is also appended to it, as one line of the JSON that JSON.stringify(decision) gives.
   */
  onDecision?: (decision: Decision) => void;
}

/**
 * One decision made through a payer's handle: what onDecision is called with, and one line of the
 * WALLETCAP_LOG file. Every field is always there, null where it doesn't apply.
 */
export interface Decision {
  /**
   * 'held': a hold was admitted. 'refused': the budget, or an adapter in front of it, refused a
   * payment. 'bound', 'noted', 'settled', 'void': a hold this handle took moved.
   */
  decision: 'held' | 'refused' | 'bound' | 'noted' | 'settled' | 'void';
  /** When: the ledger's time where the ledger gave one, otherwise this process's. */
  at: Date;
  wallet: string;
  /** Micro-dollars. For a refusal, what was asked, or null if an adapter could not price it. */
  amount: Micros | null;
  /** The payment's id; null for a refusal, which made no payment. */
  id: string | null;
  rail: string;
  /** Who is paid, as the hold or the payee's terms named it. */
  to: string | null;
  /** A refusal's code; null for anything else. */
  code: RefusalCode | null;
  /** Whose limit refused: the owner's ('budget') or this process's own ('process'). */
  source: RefusalSource | null;
  /** A refusal's brief: why, without the ids of other payments. */
  brief: string | null;
  /** What a 'noted' decision noted. */
  outcome: Outcome | null;
  /** The last moment the payment could settle, when it has one. */
  settlesBy: Date | null;
  /** The evidence a 'settled' decision was recorded with, when it has any. */
  tx: string | null;
}

/** Whether an amount would be paid right now. */
export interface Check {
  ok: boolean;
  /** Micro-dollars left in the window. */
  remaining: Micros;
  /** Which limit would refuse, or null when the payment would be paid. */
  code: RefusalCode | null;
  /** Whose limit: the owner's ('budget') or this process's own ('process'); null when ok. */
  source: RefusalSource | null;
  /** The refusal, with the ids of the open payments that take up the room; null when ok. */
  message: string | null;
  /** The message without the ids of open payments or what their owner can do about them. */
  brief: string | null;
}

/** A payment's identity, what it is for, and how long it can still settle. */
export interface HoldOptions {
  /**
   * The payment's identity: the rail's own (eip3009:<from>:<nonce>, tx:<hash>) or your own key.
   * One id is one payment, held once: holding it again throws UsageError. Defaults to a new one.
   */
  id?: string;
  /** Who is paid, for the history. */
  to?: string;
  /** What for, for the history. */
  note?: string;
  /** More JSON fields kept with the payment. */
  details?: Record<string, unknown>;
  /** The rail, for the history. Defaults to 'js'. */
  rail?: string;
  /**
   * The last moment the payment could still settle, after now. A held payment counts until one
   * window after it; without one, it counts until it is settled or voided.
   */
  settlesBy?: Date | number | bigint;
  /** The same, as a time from now by the ledger's clock, in milliseconds. */
  settlesWithin?: number | bigint;
}

/** What has been spent, what is in flight and what is left. Amounts are micro-dollars. */
export interface Status {
  wallet: string;
  path: string;
  cap: Micros;
  /** Milliseconds. */
  windowMs: bigint;
  perPayment: Micros | null;
  maxPayments: bigint | null;
  /** Settled payments that count in the window. */
  spent: Micros;
  /** Held payments that count: not yet settled or voided. */
  inFlight: Micros;
  remaining: Micros;
  payments: bigint;
  frozen: boolean;
  /** One line for a log. */
  summary: string;
}

/** One entry of a wallet's history. */
export interface Payment {
  id: string;
  amount: Micros;
  status: 'settled' | 'in flight' | 'refused' | 'unknown' | 'expired' | 'void';
  /** Whether it counts against the budget right now. */
  counting: boolean;
  at: Date;
  rail: string;
  to: string | null;
  note: string | null;
  tx: string | null;
}

/** A held payment that still counts against the budget. */
export interface HeldPayment {
  id: string;
  amount: Micros;
  /**
   * 'in flight': no outcome yet. 'refused': the payee said it failed, but may still hold the
   * authorization. 'unknown': the payment call failed after the money may have left.
   */
  reason: 'in flight' | Outcome;
  at: Date;
  /** How long ago it was held, in milliseconds. */
  ageMs: bigint;
  /** The last moment it could settle, or null if nothing bounds it. */
  settlesBy: Date | null;
  /** When it stops counting, or null if only evidence ends it. */
  countsUntil: Date | null;
  rail: string;
  to: string | null;
  note: string | null;
  error: string | null;
}

/** One payment as its owner sees it. */
export interface PaymentRecord extends Payment {
  wallet: string;
  state: PaymentState;
  settlesBy: Date | null;
  countsUntil: Date | null;
}

type Info = Record<string, unknown>;

const positive = (micros: Micros): Micros => {
  if (micros === 0n) throw new UsageError('the amount must be more than $0');
  return micros;
};

/** A moment as milliseconds since the epoch: a Date, or a whole number. */
export const momentMs = (value: unknown, label: string): bigint => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return BigInt(value.getTime());
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new UsageError(`${label} must be a Date or milliseconds since the epoch`);
};

const durationMs = (value: unknown, label: string): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new UsageError(`${label} must be a whole number of milliseconds`);
};

const describe = (to: unknown, note: unknown, details: unknown): Info | null => {
  if (to !== undefined && (typeof to !== 'string' || to.length > TO_LIMIT)) throw new UsageError(`to must be a string of at most ${TO_LIMIT} characters`);
  if (note !== undefined && (typeof note !== 'string' || note.length > NOTE_LIMIT))
    throw new UsageError(`note must be a string of at most ${NOTE_LIMIT} characters`);
  if (details !== undefined && (details === null || typeof details !== 'object' || Array.isArray(details)))
    throw new UsageError('details must be a plain object');
  const info: Info = { ...(details as Info | undefined), ...(to === undefined ? {} : { to }), ...(note === undefined ? {} : { note }) };
  for (const key of Object.keys(info)) if (info[key] === undefined || info[key] === null) delete info[key];
  return Object.keys(info).length === 0 ? null : info;
};

const transactionOf = (result: unknown): string | undefined => {
  if (typeof result === 'string' && TX_HASH.test(result)) return result;
  if (result !== null && typeof result === 'object') {
    for (const key of ['hash', 'transactionHash', 'transaction']) {
      const value = (result as Info)[key];
      if (typeof value === 'string' && TX_HASH.test(value)) return value;
    }
  }
  return undefined;
};

const parseInfo = (text: string | null): Info => {
  try {
    const info: unknown = text ? JSON.parse(text) : {};
    return info !== null && typeof info === 'object' ? (info as Info) : {};
  } catch {
    return {};
  }
};

const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

// Who a payment's info says is paid, as the history shows it.
const payeeOf = (info: Info | null): string | null => textOf(info?.to) ?? textOf(info?.payTo) ?? null;

// A move the ledger appended, as the decision log takes it.
const movedFields = (decision: 'bound' | 'noted' | 'settled' | 'void', row: Moved, outcome?: Outcome): DecisionFields => ({
  decision,
  at: row.now,
  amount: row.amount,
  id: row.payment,
  rail: row.rail,
  to: payeeOf(parseInfo(row.info)),
  ...(outcome === undefined ? {} : { outcome }),
  settlesBy: row.until,
  tx: decision === 'settled' ? row.settled_by : null,
});

const errorText = (error: unknown): string => String((error as Error)?.message ?? error).slice(0, 200);

// --- Views of the ledger's rows, shared with the owner's handle -------------------------------

const label = (row: PaymentRow, info: Info): Payment['status'] => {
  if (row.state === 'settled') return info.outcome === 'unknown' ? 'unknown' : 'settled';
  if (row.state === 'void') return 'void';
  if (row.counting !== 1n) return 'expired';
  return row.outcome ?? 'in flight';
};

const settlesByOf = (row: PaymentRow): Date | null => (row.until === null ? null : new Date(Number(row.until)));

// When a payment stops counting, or null while only evidence can end it.
const countsUntilOf = (row: PaymentRow): Date | null =>
  row.counts_from === null || row.counts_from === OPEN ? null : new Date(Number(row.counts_from + row.window_ms));

const noteOf = (info: Info): string | undefined => textOf(info.note) ?? textOf(info.network);

/** Internal: a history row as a Payment. */
export function paymentOf(row: PaymentRow): Payment {
  const info = parseInfo(row.info);
  return withJSON({
    id: row.payment,
    amount: row.amount,
    status: label(row, info),
    counting: row.counting === 1n,
    at: new Date(Number(row.held_at)),
    rail: row.rail,
    to: textOf(info.to) ?? textOf(info.payTo) ?? null,
    note: noteOf(info) ?? null,
    tx: row.settled_by ?? textOf(info.tx) ?? null,
  });
}

/** Internal: a payment row as its owner sees it. */
export function recordOf(row: PaymentRow): PaymentRecord {
  return withJSON({ ...paymentOf(row), wallet: row.wallet, state: row.state, settlesBy: settlesByOf(row), countsUntil: countsUntilOf(row) });
}

/** Internal: a counting row of a held payment. */
export function heldPaymentOf(row: PaymentRow): HeldPayment {
  const info = parseInfo(row.info);
  return withJSON({
    id: row.payment,
    amount: row.amount,
    reason: row.outcome ?? 'in flight',
    at: new Date(Number(row.held_at)),
    ageMs: row.now - row.held_at,
    settlesBy: settlesByOf(row),
    countsUntil: countsUntilOf(row),
    rail: row.rail,
    to: textOf(info.to) ?? textOf(info.payTo) ?? null,
    note: noteOf(info) ?? null,
    error: row.noted ?? textOf(info.error) ?? null,
  });
}

/** Internal: a status row as a Status. */
export function statusOf(row: StatusRow, path: string): Status {
  const status = {
    wallet: row.wallet,
    path,
    cap: row.cap,
    windowMs: row.window_ms,
    perPayment: row.per_payment,
    maxPayments: row.max_payments,
    spent: row.spent,
    inFlight: row.in_flight,
    remaining: row.remaining,
    payments: row.payments,
    frozen: row.frozen_at !== null,
  };
  return withJSON({ ...status, summary: summarize(status) });
}

function summarize({
  wallet,
  cap,
  windowMs,
  perPayment,
  maxPayments,
  spent,
  inFlight,
  remaining,
  frozen,
}: Omit<Status, 'summary' | 'path' | 'payments'>): string {
  const parts = [`${shortWallet(wallet)}: ${formatUsd(spent)} spent of ${formatUsd(cap)} per ${formatWindow(windowMs)}, ${formatUsd(remaining)} left`];
  if (inFlight > 0n) parts.push(`${formatUsd(inFlight)} in flight`);
  if (perPayment !== null) parts.push(`at most ${formatUsd(perPayment)} a payment`);
  if (maxPayments !== null) parts.push(`at most ${maxPayments} payments per ${formatWindow(windowMs)}`);
  if (frozen) parts.push('FROZEN');
  return parts.join(' · ');
}

/** Internal: ` --path "<file>"` unless it is the default file, for commands a message names. */
export function pathFlag(path: string): string {
  return path === resolve(defaultBudgetPath()) ? '' : ` --path ${shellQuote(path)}`;
}

// A path as a POSIX shell reads one word, as Python's shlex.quote writes it: double quotes would
// let $(…) in a path run when its owner pastes the command.
const shellQuote = (text: string): string => {
  if (process.platform === 'win32') return /[\s"]/.test(text) || text === '' ? `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : text;
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'"'"'`)}'`;
};

// --- The paying process's own limits ---------------------------------------------------------

/**
 * The limits this process passed that are tighter than the budget's, as the ledger takes them,
 * and whether any of them was looser, and so does nothing. A limit in another window than the
 * budget's binds as its own.
 */
function processLimits(row: BudgetRow, asked: Limits): { limits: ProcessLimits; looser: boolean } {
  const limits: ProcessLimits = {};
  let looser = false;
  if (asked.perPayment !== undefined) {
    if (asked.perPayment === null) looser ||= row.per_payment !== null;
    else if (row.per_payment === null || asked.perPayment < row.per_payment) limits.perPayment = asked.perPayment;
    else if (asked.perPayment > row.per_payment) looser = true;
  }
  if (asked.cap !== undefined && asked.windowMs !== undefined) {
    if (asked.windowMs !== row.window_ms || asked.cap < row.cap) {
      limits.cap = asked.cap;
      limits.windowMs = asked.windowMs;
    } else if (asked.cap > row.cap) {
      looser = true;
    }
  }
  if (asked.maxPayments !== undefined) {
    const window = asked.windowMs ?? row.window_ms;
    if (asked.maxPayments === null) {
      looser ||= row.max_payments !== null;
    } else if (window !== row.window_ms || row.max_payments === null || asked.maxPayments < row.max_payments) {
      limits.maxPayments = asked.maxPayments;
      limits.windowMs = window;
    } else if (asked.maxPayments > row.max_payments) {
      looser = true;
    }
  }
  return { limits, looser };
}

// --- The handles -----------------------------------------------------------------------------

/**
 * One payment, held in the budget: settle it when it settles, void it if it never left the
 * wallet, and tell it how long it can still settle once you know. Every move is idempotent, and
 * only moves forward: held, then void or settled; void, then settled.
 *
 * Only the hold that took a payment can move it: it carries the token the ledger checks. Another
 * process, or the budget's owner by the payment's id, can't use it.
 */
let makeHold: (ledger: Ledger, held: Held, amount: Micros, decisions: DecisionLog) => Hold;

export class Hold {
  readonly #ledger: Ledger;
  readonly #id: string;
  readonly #amount: Micros;
  readonly #holder: string | null;
  readonly #decisions: DecisionLog;
  #state: PaymentState;

  // Budget.hold() makes these, through makeHold: the constructor is private, so the public
  // declarations never name the ledger.
  static {
    makeHold = (ledger, held, amount, decisions) => new Hold(ledger, held, amount, decisions);
  }

  private constructor(ledger: Ledger, held: Held, amount: Micros, decisions: DecisionLog) {
    this.#ledger = ledger;
    this.#id = held.payment;
    this.#amount = amount;
    this.#state = held.state;
    this.#holder = held.holder;
    this.#decisions = decisions;
  }

  // What the ledger answered to a move: this handle's state, and, if this call is the one that
  // moved the payment, a decision. A move already made is no decision.
  #moved(decision: 'bound' | 'noted' | 'settled' | 'void', row: Moved, outcome?: Outcome): void {
    this.#state = row.state;
    if (row.moved) this.#decisions.record(movedFields(decision, row, outcome));
  }

  // The token this hold's moves need; a hold for a payment another process took has none.
  #token(verb: string): string {
    if (this.#holder === null) throw new UsageError(heldElsewhere(this.#id, verb));
    return this.#holder;
  }

  /** The payment's identity in the ledger: a good idempotency key for the rail you pay through. */
  get id(): string {
    return this.#id;
  }

  /** In micro-dollars. */
  get amount(): Micros {
    return this.#amount;
  }

  /** The state this handle last saw: 'held', 'settled' or 'void'. */
  get state(): PaymentState {
    return this.#state;
  }

  /**
   * The payment settled. It counts through one window from now, or from its settle-by time if
   * that is later: a settlement never shortens a hold. `tx` is the evidence, a transaction hash.
   */
  async settle({ tx }: { tx?: string | undefined } = {}): Promise<void> {
    // Settling a payment this hold already settled is a no-op.
    this.#moved('settled', await this.#ledger.settle(this.#id, { evidence: tx ?? null, holder: this.#token('settle') }));
  }

  /** The payment never left the wallet, and never will: it stops counting. A settled payment can't be voided. */
  async void({ evidence }: { evidence?: string | undefined } = {}): Promise<void> {
    this.#moved('void', await this.#ledger.void(this.#id, { evidence: evidence ?? 'not sent', holder: this.#token('void') }));
  }

  /** The last moment the payment could still settle, after now. A hold learns it once. */
  async settlesBy(when: Date | number | bigint): Promise<void> {
    this.#moved('bound', await this.#ledger.bound(this.#id, { until: momentMs(when, 'settlesBy'), withinMs: null, holder: this.#token('bound') }));
  }

  /** The same, as a time from now by the ledger's clock, in milliseconds. */
  async settlesWithin(ms: number | bigint): Promise<void> {
    this.#moved('bound', await this.#ledger.bound(this.#id, { until: null, withinMs: durationMs(ms, 'settlesWithin'), holder: this.#token('bound') }));
  }

  /** What is known about a held payment's outcome; it counts the same. */
  async note(outcome: Outcome, detail?: string): Promise<void> {
    this.#moved(
      'noted',
      await this.#ledger.note(this.#id, outcome, { evidence: detail === undefined ? null : detail.slice(0, 1024), holder: this.#token('note') }),
      outcome,
    );
  }
}

/**
 * Open the wallet's budget, to pay from it. Its owner creates it first with `walletcap set`;
 * pass `create: true` only to create it on first use (a demo or a first-run setup). Limits are
 * dollars: strings ("$150", "12.50 USDC"), numbers (12.5) or bigint micro-dollars. Limits given
 * here only tighten the budget's, for this process.
 *
 *   // The owner creates it once: npx walletcap set --wallet 0x… --per-payment 50 --per-day 150
 *   const budget = await openBudget({ wallet: '0x…' });
 *   await budget.pay('$12.50', () => sendUsdc(to, amount));
 */
export function openBudget(options: BudgetOptions): Promise<Budget> {
  return Budget.open(options);
}

/** The payer's handle. Open it with openBudget(). */
export class Budget {
  readonly #ledger: Ledger;
  readonly #wallet: string;
  readonly #path: string;
  readonly #limits: ProcessLimits;
  readonly #decisions: DecisionLog;

  private constructor(ledger: Ledger, wallet: string, path: string, limits: ProcessLimits, decisions: DecisionLog) {
    this.#ledger = ledger;
    this.#wallet = wallet;
    this.#path = path;
    this.#limits = limits;
    this.#decisions = decisions;
  }

  /** The same as openBudget(). */
  static async open(options: BudgetOptions): Promise<Budget> {
    checkKeys(options, OPTION_KEYS, 'openBudget');
    const wallet = normalizeWallet(options.wallet);
    const path = resolve(expandHome(options.path ?? defaultBudgetPath()));
    // Fail closed: a missing budget file refuses every payment until its owner creates it.
    const create = options.create ?? false;
    const asked = parseLimits(options);
    if (options.onDecision !== undefined && typeof options.onDecision !== 'function') throw new UsageError('onDecision must be a function');
    if (!create && !existsSync(path)) {
      throw new BudgetUnavailable(
        `no budget file at ${path}; its owner creates one with: npx walletcap set --wallet ${wallet}${pathFlag(path)} --per-day <dollars>`,
      );
    }
    const ledger = await Ledger.open(path, { busyTimeoutMs: options.busyTimeoutMs ?? 30_000, create });
    try {
      let row = await ledger.budget(wallet);
      if (row === null) {
        if (!create)
          throw new BudgetUnavailable(
            `${shortWallet(wallet)} has no budget in ${path}; its owner creates one with: npx walletcap set --wallet ${wallet}${pathFlag(path)} --per-day <dollars>`,
          );
        if (asked.cap === undefined || asked.windowMs === undefined) {
          throw new UsageError(`${shortWallet(wallet)} has no budget yet: give it a rolling limit, like perDay: '$150'`);
        }
        row = await ledger.createBudget(wallet, {
          cap: asked.cap,
          windowMs: asked.windowMs,
          perPayment: asked.perPayment ?? null,
          maxPayments: asked.maxPayments ?? null,
        });
      }
      if (row.unit !== 'usd' && row.unit !== 'usdc') throw new UsageError(`${shortWallet(wallet)}'s budget counts in ${row.unit}, not usd`);
      const { limits, looser } = processLimits(row, asked);
      if (looser) warnLooser(options.onWarning, row, asked, path);
      // The log file is the one WALLETCAP_LOG names now, as the budget file is the one the path names now.
      const decisions = new DecisionLog(wallet, options.onDecision, decisionLogFile());
      const budget = new Budget(ledger, wallet, path, limits, decisions);
      registerLedger(budget, ledger);
      registerDecisions(budget, decisions);
      return budget;
    } catch (error) {
      ledger.close();
      throw error;
    }
  }

  /** The name the budget is kept under: an EVM address, lowercased. */
  get wallet(): string {
    return this.#wallet;
  }

  /** The budget file. */
  get path(): string {
    return this.#path;
  }

  /** Whether `amount` would be paid right now, without holding it. */
  async check(amount: Dollars): Promise<Check> {
    const { refusal, remaining } = await this.#ledger.check(this.#wallet, positive(toMicros(amount)), { limits: this.#limits });
    if (refusal === null) return withJSON({ ok: true, remaining, code: null, source: null, message: null, brief: null });
    // A question, not a decision: nothing is logged. The answer keeps the ledger's time for it, for
    // an adapter that refuses on it.
    return stampLedgerTime(
      withJSON({ ok: false, remaining, code: refusal.code, source: refusal.source, message: refusal.message, brief: refusal.brief }),
      ledgerTimeOf(refusal),
    );
  }

  /**
   * Hold `amount` before paying, or throw BudgetRefused. Settle the hold when the payment
   * settles; void it only if the payment never left. An id is one payment, held once: an id
   * already in the ledger is refused with a UsageError whose paymentState says where it stands,
   * and a process that restarts looks its payment up with payment(id).
   */
  async hold(amount: Dollars, options: HoldOptions = {}): Promise<Hold> {
    checkKeys(options, HOLD_KEYS, 'hold');
    const { to, note, details, rail = 'js', settlesBy, settlesWithin, id } = options;
    const micros = positive(toMicros(amount));
    const info = describe(to, note, details);
    let held: Held;
    try {
      held = await this.#ledger.hold(this.#wallet, micros, {
        payment: id ?? null,
        rail,
        info: info === null ? null : JSON.stringify(info),
        until: settlesBy === undefined || settlesBy === null ? null : momentMs(settlesBy, 'settlesBy'),
        withinMs: settlesWithin === undefined || settlesWithin === null ? null : durationMs(settlesWithin, 'settlesWithin'),
        limits: this.#limits,
      });
    } catch (error) {
      // Only a refusal is a decision: a call that was wrong, or a file that can't be read, decided nothing.
      if (error instanceof BudgetRefused) this.#decisions.refused(error, { rail, amount: micros, to: payeeOf(info) });
      throw error;
    }
    this.#decisions.record({ decision: 'held', at: held.at, amount: micros, id: held.payment, rail, to: payeeOf(info), settlesBy: held.until });
    return makeHold(this.#ledger, held, micros, this.#decisions);
  }

  /**
   * One of this wallet's payments, by its id, or null: how a process that restarts finds out what
   * happened to a payment it held, instead of holding the id again.
   */
  async payment(id: string): Promise<PaymentRecord | null> {
    const row = await this.#ledger.payment(id);
    return row === null || row.wallet !== this.#wallet ? null : recordOf(row);
  }

  /**
   * Hold `amount`, run `fn` to make the payment, then settle it. An error never settles a
   * payment: if `fn` throws, the payment may still have left, so it stays held, noted unknown,
   * and counts until one window past its settle-by time or, without one, until its owner voids
   * it. An error tagged with notSent() voids it. If the payment went through but can't be
   * recorded, this throws PaymentNotRecorded: don't pay again. `fn` gets the hold, whose id
   * makes a good idempotency key. Returns what `fn` returns.
   */
  async pay<T>(amount: Dollars, fn: (hold: Hold) => T | Promise<T>, options: HoldOptions = {}): Promise<T> {
    if (typeof fn !== 'function') throw new UsageError('pay(amount, fn) calls fn to make the payment, and fn is missing');
    const hold = await this.hold(amount, options);
    let result: T;
    try {
      result = await fn(hold);
    } catch (error) {
      if (hold.state === 'held') {
        // The tag is one payment's, this one's: a pay() around this one finds it spent, and
        // notes its own payment unknown.
        const never = isNotSent(error);
        spendNotSent(error);
        try {
          if (never) await hold.void({ evidence: `not sent: ${errorText(error)}` });
          else await hold.note('unknown', errorText(error));
        } catch {
          // Recording failed; the payment stays held, and keeps counting.
        }
      }
      throw error;
    }
    // A function that voided its hold, then paid after all and returns the transaction, is
    // settled, so the payment counts. A void hold with nothing to show stays void.
    const tx = transactionOf(result);
    if (hold.state === 'held' || (hold.state === 'void' && tx !== undefined)) {
      try {
        await hold.settle({ tx });
      } catch (error) {
        throw new PaymentNotRecorded(hold.id, { cause: error });
      }
    }
    return result;
  }

  /** What has been spent, what is in flight and what is left, in micro-dollars, plus a one-line summary. */
  async status(): Promise<Status> {
    return statusOf(await this.#ledger.status(this.#wallet), this.#path);
  }

  /** The newest payments first. */
  async history({ limit = 20 }: { limit?: number | string } = {}): Promise<Payment[]> {
    return (await this.#ledger.history(this.#wallet, { limit })).map(paymentOf);
  }

  /**
   * The held payments that still count, oldest first, and why each is open: 'in flight' (no
   * outcome yet), 'refused' (the payee said it failed but may still hold the authorization) or
   * 'unknown' (the payment call failed after the money may have left). Its owner voids one that
   * never left the wallet.
   */
  async holds(): Promise<HeldPayment[]> {
    return (await this.#ledger.counting(this.#wallet, { heldOnly: true })).map(heldPaymentOf);
  }

  close(): void {
    this.#ledger.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }
}

function warnLooser(onWarning: ((message: string) => void) | undefined, row: BudgetRow, asked: Limits, path: string): void {
  const stored = { cap: row.cap, windowMs: row.window_ms, perPayment: row.per_payment, maxPayments: row.max_payments };
  const merged = mergedNoteOf(row.merged_from);
  const message =
    `walletcap: ${shortWallet(row.wallet)} keeps its stored limits (${describeLimits(stored)}); ` +
    `your code asks for ${describeLimits(asked, { window: row.window_ms, nulls: true })}. A process can tighten the limits for itself, never loosen them. ` +
    `To raise them, its owner runs: npx walletcap set --wallet ${row.wallet}${pathFlag(path)} ${limitFlags(asked)}`.trimEnd() +
    (merged === null ? '' : `. ${merged}`);
  if (typeof onWarning === 'function') onWarning(message);
  else process.emitWarning(message, { type: 'BudgetWarning', code: 'WALLETCAP_LIMIT_KEPT' });
}
