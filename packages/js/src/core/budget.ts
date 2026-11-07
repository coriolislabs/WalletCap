// SPDX-License-Identifier: Apache-2.0
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
import { BudgetUnavailable, isNotSent, PaymentNotRecorded, type RefusalCode, UsageError } from './errors.js';
import {
  type BudgetRow, Ledger, mergedNoteOf, OPEN, type Outcome, type PaymentRow, type PaymentState, type ProcessLimits, type StatusRow,
} from './ledger.js';
import {
  checkKeys, defaultBudgetPath, describeLimits, type Dollars, expandHome, formatUsd, formatWindow, type LimitOptions, type Limits, limitFlags,
  type Micros, normalizeWallet, parseLimits, shortWallet, toMicros,
} from './money.js';

// Each budget's ledger, for the adapters: they read what the public API doesn't give.
const ledgers = new WeakMap<Budget, Ledger>();

/** Internal, for the adapters (not exported by the package): the ledger a budget counts in. */
export function ledgerOf(budget: Budget): Ledger {
  const ledger = ledgers.get(budget);
  if (ledger === undefined) throw new UsageError('that is not a budget walletcap opened');
  return ledger;
}

const LIMIT_KEYS = ['perPayment', 'perHour', 'perDay', 'perWeek', 'cap', 'window', 'maxPayments'];
const OPTION_KEYS = new Set(['wallet', 'path', 'create', 'busyTimeoutMs', 'onWarning', ...LIMIT_KEYS]);
const HOLD_KEYS = new Set(['id', 'to', 'note', 'details', 'rail', 'settlesBy', 'settlesWithinMs']);
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
  /** How long to wait for another process's write, in milliseconds. Defaults to 30000. The wait never blocks the event loop. */
  busyTimeoutMs?: number;
  /** Called instead of process.emitWarning when a limit this code asks for is looser than the budget's, and so does nothing. */
  onWarning?: (message: string) => void;
}

/** Whether an amount would be paid right now. */
export interface Check {
  ok: boolean;
  code?: RefusalCode;
  message?: string;
  /** The message without the ids of open payments or what their owner can do about them. */
  brief?: string;
  /** Micro-dollars left in the window. */
  remaining: Micros;
}

/** A payment's identity, what it is for, and how long it can still settle. */
export interface HoldOptions {
  /**
   * The payment's identity: the rail's own (eip3009:<from>:<nonce>, tx:<hash>) or your own key.
   * One id is one payment: holding it again returns that payment. Defaults to a new one.
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
  settlesWithinMs?: number | bigint;
}

/** What has been spent, what is in flight and what is left. Amounts are micro-dollars. */
export interface Status {
  wallet: string;
  path: string;
  cap: Micros;
  /** Milliseconds. */
  window: bigint;
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
  to?: string;
  note?: string;
  tx?: string;
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
  to?: string;
  note?: string;
  error?: string;
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
  if (note !== undefined && (typeof note !== 'string' || note.length > NOTE_LIMIT)) throw new UsageError(`note must be a string of at most ${NOTE_LIMIT} characters`);
  if (details !== undefined && (details === null || typeof details !== 'object' || Array.isArray(details))) throw new UsageError('details must be a plain object');
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
    return info !== null && typeof info === 'object' ? info as Info : {};
  } catch {
    return {};
  }
};

const textOf = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

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
const countsUntilOf = (row: PaymentRow): Date | null => (row.counts_from === null || row.counts_from === OPEN
  ? null
  : new Date(Number(row.counts_from + row.window_ms)));

const noteOf = (info: Info): string | undefined => textOf(info.note) ?? (info.network ? String(info.network) : undefined);

/** Internal: a history row as a Payment. */
export function paymentOf(row: PaymentRow): Payment {
  const info = parseInfo(row.info);
  const payment: Payment = {
    id: row.payment, amount: row.amount, status: label(row, info), counting: row.counting === 1n, at: new Date(Number(row.held_at)), rail: row.rail,
  };
  const to = textOf(info.to) ?? textOf(info.payTo);
  const note = noteOf(info);
  const tx = row.settled_by ?? textOf(info.tx);
  if (to !== undefined) payment.to = to;
  if (note !== undefined) payment.note = note;
  if (tx !== undefined) payment.tx = tx;
  return payment;
}

/** Internal: a payment row as its owner sees it. */
export function recordOf(row: PaymentRow): PaymentRecord {
  return { ...paymentOf(row), wallet: row.wallet, state: row.state, settlesBy: settlesByOf(row), countsUntil: countsUntilOf(row) };
}

/** Internal: a counting row of a held payment. */
export function heldPaymentOf(row: PaymentRow): HeldPayment {
  const info = parseInfo(row.info);
  const held: HeldPayment = {
    id: row.payment,
    amount: row.amount,
    reason: row.outcome ?? 'in flight',
    at: new Date(Number(row.held_at)),
    ageMs: row.now - row.held_at,
    settlesBy: settlesByOf(row),
    countsUntil: countsUntilOf(row),
    rail: row.rail,
  };
  const to = textOf(info.to) ?? textOf(info.payTo);
  const note = noteOf(info);
  const error = row.noted ?? textOf(info.error);
  if (to !== undefined) held.to = to;
  if (note !== undefined) held.note = note;
  if (error !== undefined) held.error = error;
  return held;
}

/** Internal: a status row as a Status. */
export function statusOf(row: StatusRow, path: string): Status {
  const status = {
    wallet: row.wallet,
    path,
    cap: row.cap,
    window: row.window_ms,
    perPayment: row.per_payment,
    maxPayments: row.max_payments,
    spent: row.spent,
    inFlight: row.in_flight,
    remaining: row.remaining,
    payments: row.payments,
    frozen: row.frozen_at !== null,
  };
  return { ...status, summary: summarize(status) };
}

function summarize({ wallet, cap, window, perPayment, maxPayments, spent, inFlight, remaining, frozen }: Omit<Status, 'summary' | 'path' | 'payments'>): string {
  const parts = [`${shortWallet(wallet)}: ${formatUsd(spent)} spent of ${formatUsd(cap)} per ${formatWindow(window)}, ${formatUsd(remaining)} left`];
  if (inFlight > 0n) parts.push(`${formatUsd(inFlight)} in flight`);
  if (perPayment !== null) parts.push(`at most ${formatUsd(perPayment)} a payment`);
  if (maxPayments !== null) parts.push(`at most ${maxPayments} payments per ${formatWindow(window)}`);
  if (frozen) parts.push('FROZEN');
  return parts.join(' · ');
}

/** Internal: ` --path "<file>"` unless it is the default file, for commands a message names. */
export function pathFlag(path: string): string {
  return path === resolve(defaultBudgetPath()) ? '' : ` --path ${JSON.stringify(path)}`;
}

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
 */
export class Hold {
  readonly #ledger: Ledger;
  readonly #id: string;
  readonly #amount: Micros;
  readonly #created: boolean;
  #state: PaymentState;

  /** Internal: Budget.hold() makes these. */
  constructor(ledger: Ledger, id: string, amount: Micros, state: PaymentState, created: boolean) {
    this.#ledger = ledger;
    this.#id = id;
    this.#amount = amount;
    this.#state = state;
    this.#created = created;
  }

  /** The payment's identity in the ledger: a good idempotency key for the rail you pay through. */
  get id(): string { return this.#id; }

  /** In micro-dollars. */
  get amount(): Micros { return this.#amount; }

  /** The state this handle last saw: 'held', 'settled' or 'void'. */
  get state(): PaymentState { return this.#state; }

  /** False when the id was already in the ledger, for this wallet and amount: this is that payment. */
  get created(): boolean { return this.#created; }

  /**
   * The payment settled. It counts through one window from now, or from its settle-by time if
   * that is later: a settlement never shortens a hold. `tx` is the evidence, a transaction hash.
   */
  async settle({ tx }: { tx?: string | undefined } = {}): Promise<void> {
    this.#state = (await this.#ledger.settle(this.#id, { evidence: tx ?? null })).state;
  }

  /** The payment never left the wallet, and never will: it stops counting. A settled payment can't be voided. */
  async void({ reason }: { reason?: string | undefined } = {}): Promise<void> {
    this.#state = (await this.#ledger.void(this.#id, { evidence: reason ?? 'not sent' })).state;
  }

  /** The last moment the payment could still settle, after now. A hold learns it once. */
  async settlesBy(when: Date | number | bigint): Promise<void> {
    this.#state = (await this.#ledger.bound(this.#id, { until: momentMs(when, 'settlesBy'), withinMs: null })).state;
  }

  /** The same, as a time from now by the ledger's clock, in milliseconds. */
  async settlesWithin(ms: number | bigint): Promise<void> {
    this.#state = (await this.#ledger.bound(this.#id, { until: null, withinMs: durationMs(ms, 'settlesWithin') })).state;
  }

  /** What is known about a held payment's outcome; it counts the same. */
  async note(outcome: Outcome, detail?: string): Promise<void> {
    this.#state = (await this.#ledger.note(this.#id, outcome, { evidence: detail === undefined ? null : detail.slice(0, 1024) })).state;
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

  private constructor(ledger: Ledger, wallet: string, path: string, limits: ProcessLimits) {
    this.#ledger = ledger;
    this.#wallet = wallet;
    this.#path = path;
    this.#limits = limits;
  }

  /** The same as openBudget(). */
  static async open(options: BudgetOptions): Promise<Budget> {
    checkKeys(options, OPTION_KEYS, 'openBudget');
    const wallet = normalizeWallet(options.wallet);
    const path = resolve(expandHome(options.path ?? defaultBudgetPath()));
    // Fail closed: a missing budget file refuses every payment until its owner creates it.
    const create = options.create ?? false;
    const asked = parseLimits(options);
    if (!create && !existsSync(path)) {
      throw new BudgetUnavailable(`no budget file at ${path}; its owner creates one with: npx walletcap set --wallet ${wallet}${pathFlag(path)} --per-day <dollars>`);
    }
    const ledger = await Ledger.open(path, { busyTimeoutMs: options.busyTimeoutMs ?? 30_000, create });
    try {
      let row = await ledger.budget(wallet);
      if (row === null) {
        if (!create) throw new BudgetUnavailable(`${shortWallet(wallet)} has no budget in ${path}; its owner creates one with: npx walletcap set --wallet ${wallet}${pathFlag(path)} --per-day <dollars>`);
        if (asked.cap === undefined || asked.windowMs === undefined) {
          throw new UsageError(`${shortWallet(wallet)} has no budget yet: give it a rolling limit, like perDay: '$150'`);
        }
        row = await ledger.createBudget(wallet, {
          cap: asked.cap, windowMs: asked.windowMs, perPayment: asked.perPayment ?? null, maxPayments: asked.maxPayments ?? null,
        });
      }
      if (row.unit !== 'usd' && row.unit !== 'usdc') throw new UsageError(`${shortWallet(wallet)}'s budget counts in ${row.unit}, not usd`);
      const { limits, looser } = processLimits(row, asked);
      if (looser) warnLooser(options.onWarning, row, asked, path);
      const budget = new Budget(ledger, wallet, path, limits);
      ledgers.set(budget, ledger);
      return budget;
    } catch (error) {
      ledger.close();
      throw error;
    }
  }

  /** The name the budget is kept under: an EVM address, lowercased. */
  get wallet(): string { return this.#wallet; }

  /** The budget file. */
  get path(): string { return this.#path; }

  /** Whether `amount` would be paid right now, without holding it. */
  async check(amount: Dollars): Promise<Check> {
    const { refusal, remaining } = await this.#ledger.check(this.#wallet, positive(toMicros(amount)), { limits: this.#limits });
    return refusal === null
      ? { ok: true, remaining }
      : { ok: false, code: refusal.code, message: refusal.message, brief: refusal.brief, remaining };
  }

  /**
   * Hold `amount` before paying, or throw BudgetRefused. Settle the hold when the payment
   * settles; void it only if the payment never left. An id already in the ledger, for this
   * wallet and amount, returns that payment's hold (`created` is false).
   */
  async hold(amount: Dollars, options: HoldOptions = {}): Promise<Hold> {
    checkKeys(options, HOLD_KEYS, 'hold');
    const { to, note, details, rail = 'js', settlesBy, settlesWithinMs, id } = options;
    const micros = positive(toMicros(amount));
    const info = describe(to, note, details);
    const held = await this.#ledger.hold(this.#wallet, micros, {
      payment: id ?? null,
      rail,
      info: info === null ? null : JSON.stringify(info),
      until: settlesBy === undefined || settlesBy === null ? null : momentMs(settlesBy, 'settlesBy'),
      withinMs: settlesWithinMs === undefined || settlesWithinMs === null ? null : durationMs(settlesWithinMs, 'settlesWithinMs'),
      limits: this.#limits,
    });
    return new Hold(this.#ledger, held.payment, micros, held.state, held.created);
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
    if (!hold.created) throw new UsageError(`payment ${hold.id} is already in the ledger (${hold.state}); pay() doesn't make it again`);
    let result: T;
    try {
      result = await fn(hold);
    } catch (error) {
      if (hold.state === 'held') {
        try {
          if (isNotSent(error)) await hold.void({ reason: `not sent: ${errorText(error)}` });
          else await hold.note('unknown', errorText(error));
        } catch {
          // Recording failed; the payment stays held, and keeps counting.
        }
      }
      throw error;
    }
    if (hold.state === 'held') {
      try {
        await hold.settle({ tx: transactionOf(result) });
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

  close(): void { this.#ledger.close(); }

  [Symbol.dispose](): void { this.close(); }

  async [Symbol.asyncDispose](): Promise<void> { this.close(); }
}

function warnLooser(onWarning: ((message: string) => void) | undefined, row: BudgetRow, asked: Limits, path: string): void {
  const stored = { cap: row.cap, windowMs: row.window_ms, perPayment: row.per_payment, maxPayments: row.max_payments };
  const merged = mergedNoteOf(row.merged_from);
  const message = `walletcap: ${shortWallet(row.wallet)} keeps its stored limits (${describeLimits(stored)}); `
    + `your code asks for ${describeLimits(asked, { window: row.window_ms, nulls: true })}. A process can tighten the limits for itself, never loosen them. `
    + `To raise them, its owner runs: npx walletcap set --wallet ${row.wallet}${pathFlag(path)} ${limitFlags(asked)}`.trimEnd()
    + (merged === null ? '' : `. ${merged}`);
  if (typeof onWarning === 'function') onWarning(message);
  else process.emitWarning(message, { type: 'BudgetWarning', code: 'WALLETCAP_LIMIT_KEPT' });
}
