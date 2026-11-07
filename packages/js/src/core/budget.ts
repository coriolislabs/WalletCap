// SPDX-License-Identifier: Apache-2.0
// The budget: one per wallet, counted across every process, replica, key, permission and payment
// rail on one host that pays from it. The core imports no vendor adapter; the adapters
// (src/adapters) import the core.
//
// Agent payment kits count "spent so far" per process, per key, per permission or per period, so
// a restart, a second replica, one more key or the next period starts the count again. This
// budget is counted per wallet, in a file every process on the host shares, over a rolling
// window. Changing a limit never resets what has been spent, a restart can lower a limit but
// never raise one, and if the count cannot be read, nothing is paid.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BudgetError, isNotSent, PaymentNotRecorded, type RefusalReason } from './errors.js';
import { type BudgetRow, Ledger, mergedNoteOf, OPEN, type Outcome, type PaymentRow, SETTLES_BY } from './ledger.js';
import {
  checkKeys, defaultBudgetPath, describeLimits, type Dollars, expandHome, formatUsd, formatWindow, type LimitOptions, type Limits, limitFlags,
  type Micros, normalizeWallet, parseLimits, shortWallet, toMicros,
} from './money.js';

// Each budget's ledger, for the adapters: they read what the public API doesn't give.
const ledgers = new WeakMap<Budget, Ledger>();

/** Internal, for the adapters (not exported by the package): the ledger a budget counts in. */
export function ledgerOf(budget: Budget): Ledger {
  const ledger = ledgers.get(budget);
  if (ledger === undefined) throw new BudgetError('that is not a budget walletcap opened');
  return ledger;
}

const LIMIT_KEYS = ['perPayment', 'perHour', 'perDay', 'perWeek', 'cap', 'window', 'maxPayments'];
const OPTION_KEYS = new Set(['wallet', 'path', 'create', 'busyTimeoutMs', 'onWarning', ...LIMIT_KEYS]);
const TO_LIMIT = 256;
const NOTE_LIMIT = 1024;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export interface BudgetOptions extends LimitOptions {
  /** The wallet or account the money leaves from. EVM addresses are lowercased, bare or CAIP-10. */
  wallet: string;
  /** The budget file. Defaults to $WALLETCAP_PATH, else the per-user state directory. */
  path?: string;
  /** Create the file and the wallet's budget if missing. Defaults to false: only its owner's `walletcap set` creates them. Pass true only for a demo or a first-run setup. */
  create?: boolean;
  /** How long to wait for another process's write, in milliseconds. Defaults to 30000. The wait never blocks the event loop. */
  busyTimeoutMs?: number;
  /** Called instead of process.emitWarning when the file keeps a limit tighter than the code asks for. */
  onWarning?: (message: string) => void;
}

/** Whether an amount would be paid right now. */
export interface Check {
  ok: boolean;
  reason?: RefusalReason;
  message?: string;
  /** The message without the ids of open payments or what their owner can do about them. */
  brief?: string;
  /** Micro-dollars left in the window. */
  remaining: Micros;
}

/** What a payment is for, and how long it can still settle. */
export interface PaymentDetails {
  /** Who is paid, for the history. */
  to?: string;
  /** What for, for the history. */
  note?: string;
  /** More JSON fields kept with the payment. */
  details?: Record<string, unknown>;
  /** The rail, for the history. Defaults to 'js'. */
  rail?: string;
  /**
   * The last moment the payment could still settle, after now (a moment that isn't is refused).
   * An open reservation, one whose outcome is unknown included, stops counting one window after
   * it. Without it, an open reservation counts until it is committed or released.
   */
  settlesBy?: Date | number | bigint;
  /** The same, as a time from now by the ledger's clock, in milliseconds. */
  settlesWithinMs?: bigint;
  /** The payment's identity on its rail (eip3009:<from>:<nonce>, tx:<hash>) or your own key: one id is one payment. */
  id?: string;
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
  /** Settled in the window. */
  spent: Micros;
  /** Held and not yet settled or voided. */
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

/** An open payment that still counts against the budget. */
export interface Hold {
  id: string;
  amount: Micros;
  /**
   * 'in flight': no outcome yet. 'refused': the payee said it failed, but may still hold the
   * authorization. 'unknown': the payment call failed after the money may have left.
   */
  reason: 'in flight' | Outcome;
  at: Date;
  /** How long ago it was taken, in milliseconds. */
  ageMs: bigint;
  /** When it stops counting, or null if only evidence ends it. */
  until: Date | null;
  rail: string;
  to?: string;
  note?: string;
  error?: string;
}

type Info = Record<string, unknown>;

const positive = (micros: Micros): Micros => {
  if (micros === 0n) throw new BudgetError('the amount must be more than $0');
  return micros;
};

const millis = (value: unknown, label: string): bigint => {
  if (value instanceof Date) return BigInt(value.getTime());
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new BudgetError(`${label} must be a Date or milliseconds since the epoch`);
};

const describe = (to: unknown, note: unknown, details: unknown): Info | null => {
  if (to !== undefined && (typeof to !== 'string' || to.length > TO_LIMIT)) throw new BudgetError(`to must be a string of at most ${TO_LIMIT} characters`);
  if (note !== undefined && (typeof note !== 'string' || note.length > NOTE_LIMIT)) throw new BudgetError(`note must be a string of at most ${NOTE_LIMIT} characters`);
  if (details !== undefined && (details === null || typeof details !== 'object' || Array.isArray(details))) throw new BudgetError('details must be a plain object');
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

const label = (row: PaymentRow, info: Info): Payment['status'] => {
  if (row.state === 'settled') return info.outcome === 'unknown' ? 'unknown' : 'settled';
  if (row.state === 'void') return 'void';
  if (row.counting !== 1n) return 'expired';
  return row.outcome ?? 'in flight';
};

// When a payment stops counting, or null while only evidence can end it.
const countsUntil = (row: PaymentRow): Date | null => (row.counts_from === null || row.counts_from === OPEN ? null : new Date(Number(row.counts_from + row.window_ms)));

const noteOf = (info: Info): string | undefined => textOf(info.note) ?? (info.network ? String(info.network) : undefined);

/** An amount taken from the budget for one payment, until it is committed or released. */
export class Reservation {
  readonly #ledger: Ledger;
  readonly #id: string;
  readonly #amount: Micros;
  #info: Info | null;
  #state: 'open' | 'committed' | 'released' = 'open';

  /** Internal: Budget.reserve() makes these. */
  constructor(ledger: Ledger, id: string, amount: Micros, info: Info | null) {
    this.#ledger = ledger;
    this.#id = id;
    this.#amount = amount;
    this.#info = info;
  }

  /** The payment's identity in the ledger: a good idempotency key for the rail you pay through. */
  get id(): string { return this.#id; }

  /** In micro-dollars. */
  get amount(): Micros { return this.#amount; }

  get open(): boolean { return this.#state === 'open'; }

  /**
   * The payment settled. It counts for one rolling window from now, and, with a settlesBy, at
   * least until one window past it: a commit never shortens a hold.
   */
  async commit({ tx }: { tx?: string | undefined } = {}): Promise<void> {
    if (!this.open) throw new BudgetError(`reservation ${this.#id} is already ${this.#state}`);
    await this.#ledger.settle(this.#id, { evidence: tx ?? null });
    this.#state = 'committed';
  }

  /** The payment never left the wallet: give its amount back. */
  async release(): Promise<void> {
    if (!this.open) throw new BudgetError(`reservation ${this.#id} is already ${this.#state}`);
    await this.#ledger.void(this.#id, { evidence: 'not sent' });
    this.#state = 'released';
  }

  /** Note what is known about an open payment, like { outcome: 'unknown' }; it keeps counting. */
  async annotate(fields: { outcome?: Outcome; error?: string } & Info): Promise<void> {
    if (!this.open) return;
    this.#info = { ...this.#info, ...fields };
    if (fields.outcome !== undefined) await this.#ledger.note(this.#id, fields.outcome, { evidence: fields.error ?? null });
  }

  // Internal (the key is not exported): an open payment learns, once, the last moment it could settle.
  async [SETTLES_BY](bound: { until?: bigint; withinMs?: bigint }): Promise<void> {
    if (this.open) await this.#ledger.bound(this.#id, { until: bound.until ?? null, withinMs: bound.withinMs ?? null });
  }
}

/**
 * Open the wallet's budget. Its owner creates it first with `walletcap set`; pass
 * `create: true` only to create it on first use (a demo or a first-run setup). Limits are
 * dollars: strings ("$150", "12.50 USDC"), numbers (12.5) or bigint micro-dollars.
 *
 *   // The owner creates it once: npx walletcap set --wallet 0x… --per-payment 50 --per-day 150
 *   const budget = await openBudget({ wallet: '0x…', perPayment: '$50', perDay: '$150' });
 *   await budget.pay('$12.50', () => sendUsdc(to, amount));
 */
export function openBudget(options: BudgetOptions): Promise<Budget> {
  return Budget.open(options);
}

export class Budget {
  readonly #ledger: Ledger;
  readonly #wallet: string;
  readonly #path: string;

  private constructor(ledger: Ledger, wallet: string, path: string) {
    this.#ledger = ledger;
    this.#wallet = wallet;
    this.#path = path;
  }

  /** The same as openBudget(). */
  static async open(options: BudgetOptions): Promise<Budget> {
    checkKeys(options, OPTION_KEYS, 'openBudget');
    const wallet = normalizeWallet(options.wallet);
    const path = resolve(expandHome(options.path ?? defaultBudgetPath()));
    // Fail closed: a missing budget file refuses every payment until its owner creates it.
    // `create: true` is for a demo or a first-run setup.
    const create = options.create ?? false;
    const limits = parseLimits(options);
    if (!create && !existsSync(path)) {
      throw new BudgetError(`no budget file at ${path}; its owner creates one with: npx walletcap set --wallet ${wallet}${pathFlag(path)} --per-day <dollars>`);
    }
    const ledger = await Ledger.open(path, { busyTimeoutMs: options.busyTimeoutMs ?? 30_000, create });
    const budget = new Budget(ledger, wallet, path);
    ledgers.set(budget, ledger);
    try {
      await budget.#ensure(limits, create, options.onWarning);
    } catch (error) {
      ledger.close();
      throw error;
    }
    return budget;
  }

  // Create the budget with `limits`, or move its stored limits toward them: a tighter limit is
  // stored, a looser one is reported and left alone. A restart can lower a limit; only
  // setLimits() raises one.
  async #ensure(limits: Limits, create: boolean, onWarning: ((message: string) => void) | undefined): Promise<void> {
    let row = await this.#ledger.budget(this.#wallet);
    if (row === null) {
      if (!create) throw new BudgetError(`${shortWallet(this.#wallet)} has no budget in ${this.#path}`);
      if (limits.cap === undefined || limits.windowMs === undefined) {
        throw new BudgetError(`${shortWallet(this.#wallet)} has no budget yet: give it a rolling limit, like perDay: '$150'`);
      }
      await this.#ledger.createBudget(this.#wallet, {
        cap: limits.cap, windowMs: limits.windowMs, perPayment: limits.perPayment ?? null, maxPayments: limits.maxUses ?? null,
      });
      return;
    }
    if (row.unit !== 'usd' && row.unit !== 'usdc') throw new BudgetError(`${shortWallet(this.#wallet)}'s budget counts in ${row.unit}, not usd`);
    const lowered: { cap?: bigint; perPayment?: bigint | null; maxPayments?: bigint | null } = {};
    let looser = false;
    const sameWindow = limits.windowMs === undefined || limits.windowMs === row.window_ms;
    if (limits.cap !== undefined) {
      if (!sameWindow) looser = true;
      else if (limits.cap < row.cap) lowered.cap = limits.cap;
      else if (limits.cap > row.cap) looser = true;
    }
    if (limits.perPayment !== undefined) {
      const asked = limits.perPayment;
      if (asked !== null && (row.per_payment === null || asked < row.per_payment)) lowered.perPayment = asked;
      else if (row.per_payment !== null && (asked === null || asked > row.per_payment)) looser = true;
    }
    if (limits.maxUses !== undefined && limits.maxUses !== row.max_payments) {
      const asked = limits.maxUses;
      if (sameWindow && asked !== null && (row.max_payments === null || asked < row.max_payments)) lowered.maxPayments = asked;
      else looser = true;
    }
    if (Object.keys(lowered).length > 0) row = await this.#ledger.setLimits(this.#wallet, lowered);
    if (looser) this.#warnKept(onWarning, row, limits);
  }

  /** The name the budget is kept under: an EVM address, lowercased. */
  get wallet(): string { return this.#wallet; }

  /** The budget file. */
  get path(): string { return this.#path; }

  #warnKept(onWarning: ((message: string) => void) | undefined, row: BudgetRow, asked: Limits): void {
    const stored = { cap: row.cap, windowMs: row.window_ms, perPayment: row.per_payment, maxUses: row.max_payments };
    const merged = mergedNoteOf(row.merged_from);
    const message = `walletcap: ${shortWallet(this.#wallet)} keeps its stored limits (${describeLimits(stored)}); `
      + `your code asks for ${describeLimits(asked, { window: row.window_ms, nulls: true })}. A restart can lower a limit but never raise one. `
      + `To raise it, its owner runs: npx walletcap set --wallet ${this.#wallet}${pathFlag(this.#path)} ${limitFlags(asked)}`.trimEnd()
      + (merged === null ? '' : `. ${merged}`);
    if (typeof onWarning === 'function') onWarning(message);
    else process.emitWarning(message, { type: 'BudgetWarning', code: 'WALLETCAP_LIMIT_KEPT' });
  }

  /** Whether `amount` would be paid right now, without taking it. */
  async check(amount: Dollars): Promise<Check> {
    const { refusal, remaining } = await this.#ledger.check(this.#wallet, positive(toMicros(amount)));
    return refusal === null
      ? { ok: true, remaining }
      : { ok: false, reason: refusal.reason, message: refusal.message, brief: refusal.brief, remaining };
  }

  /**
   * Take `amount` before paying, or throw BudgetRefused. Commit the reservation when the
   * payment settles; release it only if the payment never left. `settlesBy` is the last moment
   * the payment could still settle, if known: an open reservation stops counting one window
   * after it. It must be after now.
   */
  async reserve(amount: Dollars, { to, note, details, rail = 'js', settlesBy, settlesWithinMs, id }: PaymentDetails = {}): Promise<Reservation> {
    const micros = positive(toMicros(amount));
    const info = describe(to, note, details);
    const held = await this.#ledger.hold(this.#wallet, micros, {
      payment: id ?? null,
      rail,
      info: info === null ? null : JSON.stringify(info),
      until: settlesBy === undefined || settlesBy === null ? null : millis(settlesBy, 'settlesBy'),
      withinMs: settlesWithinMs ?? null,
    });
    return new Reservation(this.#ledger, held.payment, micros, info);
  }

  /**
   * Reserve `amount`, run `fn` to make the payment, then record it. If `fn` throws, the payment
   * may still have left, so it stays in flight, marked unknown: it counts until one window past
   * `settlesBy`, or, without one, until its owner releases it. An error tagged with notSent()
   * gives the amount back. If the payment went through but can't be recorded, it throws
   * PaymentNotRecorded, which is not a BudgetError: don't pay again. `fn` receives the
   * reservation; its id makes a good idempotency key. Returns what `fn` returns.
   */
  async pay<T>(amount: Dollars, fn: (reservation: Reservation) => T | Promise<T>, options: PaymentDetails = {}): Promise<T> {
    if (typeof fn !== 'function') throw new BudgetError('pay(amount, fn) calls fn to make the payment, and fn is missing');
    const reservation = await this.reserve(amount, options);
    let result: T;
    try {
      result = await fn(reservation);
    } catch (error) {
      if (reservation.open) {
        try {
          if (isNotSent(error)) await reservation.release();
          else await reservation.annotate({ outcome: 'unknown', error: String((error as Error)?.message ?? error).slice(0, 200) });
        } catch {
          // Recording failed; the reservation stays open, and keeps counting.
        }
      }
      throw error;
    }
    if (reservation.open) {
      try {
        await reservation.commit({ tx: transactionOf(result) });
      } catch (error) {
        throw new PaymentNotRecorded(reservation.id, { cause: error });
      }
    }
    return result;
  }

  /** What has been spent, what is in flight and what is left, in micro-dollars, plus a one-line summary. */
  async status(): Promise<Status> {
    const s = await this.#ledger.status(this.#wallet);
    const status = {
      wallet: this.#wallet,
      path: this.#path,
      cap: s.cap,
      window: s.window_ms,
      perPayment: s.per_payment,
      maxPayments: s.max_payments,
      spent: s.spent,
      inFlight: s.in_flight,
      remaining: s.remaining,
      payments: s.payments,
      frozen: s.frozen_at !== null,
    };
    return { ...status, summary: summarize(status) };
  }

  /** Change the limits, up or down. What was spent keeps counting: nothing resets. */
  async setLimits(limits: LimitOptions): Promise<Status> {
    checkKeys(limits, new Set(LIMIT_KEYS), 'setLimits');
    const parsed = parseLimits(limits);
    if (Object.keys(parsed).length === 0) throw new BudgetError("setLimits needs a limit, like { perDay: '$150' }");
    const { maxUses, ...rest } = parsed;
    await this.#ledger.setLimits(this.#wallet, { ...rest, ...(maxUses === undefined ? {} : { maxPayments: maxUses }) });
    return this.status();
  }

  /** Refuse every payment from this wallet, on every rail and in every process, until unfreeze(). */
  async freeze(): Promise<void> { await this.#ledger.freeze(this.#wallet); }

  async unfreeze(): Promise<void> { await this.#ledger.unfreeze(this.#wallet); }

  /**
   * The open payments that still count, oldest first, with why each is open: 'in flight' (no
   * outcome yet), 'refused' (the payee said it failed but may still hold the authorization) or
   * 'unknown' (the payment call failed after the money may have left). `until` is when it stops
   * counting, or null if only evidence ends it. Its owner releases one that never left the wallet.
   */
  async holds(): Promise<Hold[]> {
    return (await this.#ledger.counting(this.#wallet, { heldOnly: true })).map(row => {
      const info = parseInfo(row.info);
      const hold: Hold = {
        id: row.payment,
        amount: row.amount,
        reason: row.outcome ?? 'in flight',
        at: new Date(Number(row.held_at)),
        ageMs: row.now - row.held_at,
        until: countsUntil(row),
        rail: row.rail,
      };
      const to = textOf(info.to) ?? textOf(info.payTo);
      const note = noteOf(info);
      const error = row.noted ?? textOf(info.error);
      if (to !== undefined) hold.to = to;
      if (note !== undefined) hold.note = note;
      if (error !== undefined) hold.error = error;
      return hold;
    });
  }

  /** The newest payments first. */
  async history({ limit = 20 }: { limit?: number | string } = {}): Promise<Payment[]> {
    return (await this.#ledger.history(this.#wallet, { limit })).map(row => {
      const info = parseInfo(row.info);
      const payment: Payment = {
        id: row.payment,
        amount: row.amount,
        status: label(row, info),
        counting: row.counting === 1n,
        at: new Date(Number(row.held_at)),
        rail: row.rail,
      };
      const to = textOf(info.to) ?? textOf(info.payTo);
      const note = noteOf(info);
      const tx = row.settled_by ?? textOf(info.tx);
      if (to !== undefined) payment.to = to;
      if (note !== undefined) payment.note = note;
      if (tx !== undefined) payment.tx = tx;
      return payment;
    });
  }

  close(): void { this.#ledger.close(); }

  [Symbol.dispose](): void { this.close(); }
}

function pathFlag(path: string): string {
  return path === resolve(defaultBudgetPath()) ? '' : ` --path ${JSON.stringify(path)}`;
}

function summarize({ wallet, cap, window, perPayment, maxPayments, spent, inFlight, remaining, frozen }: Omit<Status, 'summary' | 'path' | 'payments'>): string {
  const parts = [`${shortWallet(wallet)}: ${formatUsd(spent)} spent of ${formatUsd(cap)} per ${formatWindow(window)}, ${formatUsd(remaining)} left`];
  if (inFlight > 0n) parts.push(`${formatUsd(inFlight)} in flight`);
  if (perPayment !== null) parts.push(`at most ${formatUsd(perPayment)} a payment`);
  if (maxPayments !== null) parts.push(`at most ${maxPayments} payments per ${formatWindow(window)}`);
  if (frozen) parts.push('FROZEN');
  return parts.join(' · ');
}
