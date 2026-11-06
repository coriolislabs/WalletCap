// SPDX-License-Identifier: Apache-2.0
// walletcap: one spend budget per wallet, counted across every process,
// replica, key, permission and payment rail on one host that pays from it.
//
// Agent payment kits count "spent so far" per process, per key, per permission
// or per period, so a restart, a second replica, one more key or the next
// period starts the count again. This budget is counted per wallet, in a file
// every process on the host shares, over a rolling window. Changing a limit
// never resets what has been spent, a restart can lower a limit but never raise
// one, and if the count cannot be read, nothing is paid.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SharedBudgetStore } from './cdp.mjs';
import { BudgetError, BudgetRefused, isNotSent, notSent, PaymentNotRecorded } from './errors.mjs';
import { checkKeys, Ledger, SCHEMA_VERSION, SETTLES_BY } from './ledger.mjs';
import {
  defaultBudgetPath, describeLimits, expandHome, formatUsd, formatWindow, limitFlags, MAX_AMOUNT,
  normalizeWallet, parseLimits, shortWallet, toMicros,
} from './money.mjs';
import { guardX402ActionProvider, guardX402Client, MAX_PAYMENT_TIMEOUT_SECONDS, USD_ASSETS } from './x402.mjs';

export {
  BudgetError, BudgetRefused, defaultBudgetPath, formatUsd, MAX_AMOUNT, MAX_PAYMENT_TIMEOUT_SECONDS, notSent,
  PaymentNotRecorded, SCHEMA_VERSION, SharedBudgetStore, toMicros, USD_ASSETS,
};

const LIMIT_KEYS = ['perPayment', 'perHour', 'perDay', 'perWeek', 'cap', 'window', 'maxPayments'];
const OPTION_KEYS = new Set(['wallet', 'path', 'create', 'busyTimeoutMs', 'onWarning', ...LIMIT_KEYS]);
const CDP_STORE_KEYS = new Set(['asset', 'scale']);
const TO_LIMIT = 256;
const NOTE_LIMIT = 1024;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

const positive = micros => {
  if (micros === 0n) throw new BudgetError('the amount must be more than $0');
  return micros;
};

const millis = (value, label) => {
  if (value instanceof Date) return BigInt(value.getTime());
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new BudgetError(`${label} must be a Date or milliseconds since the epoch`);
};

const describe = (to, note, details) => {
  if (to !== undefined && (typeof to !== 'string' || to.length > TO_LIMIT)) throw new BudgetError(`to must be a string of at most ${TO_LIMIT} characters`);
  if (note !== undefined && (typeof note !== 'string' || note.length > NOTE_LIMIT)) throw new BudgetError(`note must be a string of at most ${NOTE_LIMIT} characters`);
  if (details !== undefined && (details === null || typeof details !== 'object' || Array.isArray(details))) throw new BudgetError('details must be a plain object');
  const info = { ...details, ...(to === undefined ? {} : { to }), ...(note === undefined ? {} : { note }) };
  for (const key of Object.keys(info)) if (info[key] === undefined || info[key] === null) delete info[key];
  return Object.keys(info).length === 0 ? null : info;
};

const transactionOf = result => {
  if (typeof result === 'string' && TX_HASH.test(result)) return result;
  if (result !== null && typeof result === 'object') {
    for (const key of ['hash', 'transactionHash', 'transaction']) {
      if (typeof result[key] === 'string' && TX_HASH.test(result[key])) return result[key];
    }
  }
  return undefined;
};

const parseInfo = text => {
  try {
    const info = text ? JSON.parse(text) : {};
    return info !== null && typeof info === 'object' ? info : {};
  } catch {
    return {};
  }
};

const label = (row, info) => {
  if (row.status === 'committed') return info.outcome === 'unknown' ? 'unknown' : 'settled';
  if (!row.counting) return 'expired';
  return info.outcome === 'refused' || info.outcome === 'unknown' ? info.outcome : 'in flight';
};

/** An amount taken from the budget for one payment, until it is committed or released. */
export class Reservation {
  #ledger;
  #id;
  #amount;
  #info;
  #state = 'open';

  constructor(ledger, id, amount, info) {
    this.#ledger = ledger;
    this.#id = id;
    this.#amount = amount;
    this.#info = info;
  }

  /** Unique per payment: a good idempotency key for the rail you pay through. */
  get id() { return this.#id; }

  /** In micro-dollars. */
  get amount() { return this.#amount; }

  get open() { return this.#state === 'open'; }

  /**
   * The payment settled. It counts for one rolling window from now, and, with a
   * settlesBy, at least until one window past it: a commit never shortens a hold.
   */
  commit({ tx, outcome, error } = {}) {
    if (!this.open) throw new BudgetError(`reservation ${this.#id} is already ${this.#state}`);
    const info = { ...this.#info, ...(tx ? { tx } : {}), ...(outcome ? { outcome } : {}), ...(error ? { error } : {}) };
    this.#ledger.commit(this.#id, { reference: Object.keys(info).length > 0 ? JSON.stringify(info) : undefined });
    this.#state = 'committed';
  }

  /** The payment never left the wallet: give its amount back. */
  release() {
    if (!this.open) throw new BudgetError(`reservation ${this.#id} is already ${this.#state}`);
    this.#ledger.release(this.#id);
    this.#state = 'released';
  }

  /** Note what is known about an open payment; it keeps counting, as before. */
  annotate(fields) {
    if (!this.open) return;
    this.#info = { ...this.#info, ...fields };
    this.#ledger.annotate(this.#id, JSON.stringify(this.#info));
  }

  // Internal (the key is not exported): an open payment learns, once, the last moment it could settle.
  [SETTLES_BY](settlesByMs) {
    if (this.open) this.#ledger.settlesBy(this.#id, settlesByMs);
  }
}

/**
 * Open the wallet's budget. Its owner creates it first with `walletcap set`;
 * pass `create: true` only to create it on first use (a demo or a first-run
 * setup). Limits are dollars: strings ("$150", "12.50 USDC"), numbers (12.5)
 * or bigint micro-dollars.
 *
 *   // The owner creates it once: npx walletcap set --wallet 0x… --per-payment 50 --per-day 150
 *   const budget = openBudget({ wallet: '0x…', perPayment: '$50', perDay: '$150' });
 *   await budget.pay('$12.50', () => sendUsdc(to, amount));
 */
export function openBudget(options) {
  return new Budget(options);
}

export class Budget {
  #ledger;
  #wallet;
  #path;

  constructor(options = {}) {
    checkKeys(options, OPTION_KEYS, 'openBudget');
    this.#wallet = normalizeWallet(options.wallet);
    this.#path = resolve(expandHome(options.path ?? defaultBudgetPath()));
    // Fail closed: a missing budget file refuses every payment until its
    // owner creates it. `create: true` is for a demo or a first-run setup.
    const create = options.create ?? false;
    const limits = parseLimits(options);
    if (!create && !existsSync(this.#path)) {
      throw new BudgetError(`no budget file at ${this.#path}; its owner creates one with: npx walletcap set --wallet ${this.#wallet}${this.#pathFlag()} --per-day <dollars>`);
    }
    if (create) mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    this.#ledger = new Ledger(this.#path, { busyTimeoutMs: options.busyTimeoutMs ?? 30_000 });
    try {
      const { looser, row } = this.#ledger.ensure(this.#wallet, limits, { unit: 'usd', create });
      if (looser.length > 0) this.#warnKept(options.onWarning, row, limits);
    } catch (error) {
      this.#ledger.close();
      throw error;
    }
  }

  /** The name the budget is kept under: an EVM address, lowercased. */
  get wallet() { return this.#wallet; }

  /** The budget file. */
  get path() { return this.#path; }

  #pathFlag() {
    return this.#path === resolve(defaultBudgetPath()) ? '' : ` --path ${JSON.stringify(this.#path)}`;
  }

  #warnKept(onWarning, row, asked) {
    const stored = { cap: row.cap, windowMs: row.window_ms, perPayment: row.per_payment, maxUses: row.max_uses };
    const message = `walletcap: ${shortWallet(this.#wallet)} keeps its stored limits (${describeLimits(stored)}); `
      + `your code asks for ${describeLimits(asked, { window: row.window_ms, nulls: true })}. A restart can lower a limit but never raise one. `
      + `To raise it, its owner runs: npx walletcap set --wallet ${this.#wallet}${this.#pathFlag()} ${limitFlags(asked)}`.trimEnd();
    if (typeof onWarning === 'function') onWarning(message);
    else process.emitWarning(message, { type: 'BudgetWarning', code: 'WALLETCAP_LIMIT_KEPT' });
  }

  /** Whether `amount` would be paid right now, without taking it. */
  check(amount) {
    const { refusal, remaining } = this.#ledger.check(this.#wallet, positive(toMicros(amount)));
    return refusal === null
      ? { ok: true, remaining }
      : { ok: false, reason: refusal.reason, message: refusal.message, remaining };
  }

  /**
   * Take `amount` before paying, or throw BudgetRefused. Commit the reservation
   * when the payment settles; release it only if the payment never left.
   * `settlesBy` is the last moment the payment could still settle, if known: an
   * open reservation stops counting one window after it. A moment already past
   * counts as now.
   */
  reserve(amount, { to, note, details, rail = 'js', settlesBy } = {}) {
    const micros = positive(toMicros(amount));
    const info = describe(to, note, details);
    const id = this.#ledger.reserve(this.#wallet, micros, {
      rail,
      reference: info === null ? null : JSON.stringify(info),
      settlesByMs: settlesBy === undefined || settlesBy === null ? null : millis(settlesBy, 'settlesBy'),
    });
    return new Reservation(this.#ledger, id, micros, info);
  }

  /**
   * Reserve `amount`, run `fn` to make the payment, then record it. If `fn`
   * throws, the payment may still have left, so it stays in flight, marked
   * unknown: it counts until one window past `settlesBy`, or, without one,
   * until its owner releases it. An error tagged with notSent() gives the
   * amount back. If the payment went through but can't be recorded, it throws
   * PaymentNotRecorded, which is not a BudgetError: don't pay again. `fn`
   * receives the reservation; its id makes a good idempotency key. Returns what
   * `fn` returns.
   */
  async pay(amount, fn, options = {}) {
    if (typeof fn !== 'function') throw new BudgetError('pay(amount, fn) calls fn to make the payment, and fn is missing');
    const reservation = this.reserve(amount, options);
    let result;
    try {
      result = await fn(reservation);
    } catch (error) {
      if (reservation.open) {
        try {
          if (isNotSent(error)) reservation.release();
          else reservation.annotate({ outcome: 'unknown', error: String(error?.message ?? error).slice(0, 200) });
        } catch {
          // Recording failed; the reservation stays open, and keeps counting.
        }
      }
      throw error;
    }
    if (reservation.open) {
      try {
        reservation.commit({ tx: transactionOf(result) });
      } catch (error) {
        throw new PaymentNotRecorded(reservation.id, { cause: error });
      }
    }
    return result;
  }

  /** What has been spent, what is in flight and what is left, in micro-dollars, plus a one-line summary. */
  status() {
    const s = this.#ledger.status(this.#wallet);
    const status = {
      wallet: this.#wallet,
      path: this.#path,
      cap: s.cap,
      window: s.windowMs,
      perPayment: s.perPayment,
      maxPayments: s.maxUses,
      spent: s.spent,
      inFlight: s.reserved,
      remaining: s.remaining,
      payments: s.uses,
      frozen: s.revoked,
    };
    return { ...status, summary: summarize(status) };
  }

  /** Change the limits, up or down. What was spent keeps counting: nothing resets. */
  setLimits(limits) {
    checkKeys(limits, new Set(LIMIT_KEYS), 'setLimits');
    const parsed = parseLimits(limits);
    if (Object.keys(parsed).length === 0) throw new BudgetError("setLimits needs a limit, like { perDay: '$150' }");
    this.#ledger.setLimits(this.#wallet, parsed, { unit: 'usd' });
    return this.status();
  }

  /** Refuse every payment from this wallet, on every rail and in every process, until unfreeze(). */
  freeze() { this.#ledger.revoke(this.#wallet); }

  unfreeze() { this.#ledger.unrevoke(this.#wallet); }

  /**
   * The open payments that still count, oldest first, with why each is open:
   * 'in flight' (no outcome yet), 'refused' (the payee said it failed but may
   * still hold the authorization) or 'unknown' (the payment call failed after
   * the money may have left). `until` is when it stops counting, or null if
   * only a release ends it. Its owner releases one that never left the wallet.
   */
  holds() {
    return this.#ledger.holds(this.#wallet).map(row => {
      const info = parseInfo(row.reference);
      return {
        id: row.spend_id,
        amount: row.amount,
        reason: info.outcome === 'refused' || info.outcome === 'unknown' ? info.outcome : 'in flight',
        at: new Date(Number(row.at_ms)),
        ageMs: row.now - row.at_ms,
        until: row.expires_at_ms === null ? null : new Date(Number(row.expires_at_ms - 1n)),
        rail: row.rail,
        to: info.to ?? info.payTo,
        note: info.note ?? (info.network ? `${info.network}` : undefined),
        error: info.error,
      };
    });
  }

  /** The newest payments first. */
  history({ limit = 20 } = {}) {
    return this.#ledger.history(this.#wallet, { limit }).map(row => {
      const info = parseInfo(row.reference);
      return {
        id: row.spend_id,
        amount: row.amount,
        status: label(row, info),
        counting: row.counting,
        at: new Date(Number(row.at_ms)),
        rail: row.rail,
        to: info.to ?? info.payTo,
        note: info.note ?? (info.network ? `${info.network}` : undefined),
        tx: info.tx,
      };
    });
  }

  /** Count every payment an x402 client (@x402/core 2.x) makes in this budget. Returns the client. */
  guard(client, options) { return guardX402Client(client, this, options); }

  /** Count every payment a Coinbase AgentKit X402ActionProvider makes in this budget. Returns the provider. */
  guardAgentKit(provider, options) { return guardX402ActionProvider(provider, this, options); }

  /** A SpendStore for Coinbase's CDP applySpendControls, counting in this budget. For a 6-decimal USD stablecoin. */
  cdpStore(options = {}) {
    checkKeys(options, CDP_STORE_KEYS, 'cdpStore');
    const { asset, scale = 1n } = options;
    return new SharedBudgetStore({ path: this.#path, instrument: this.#wallet, asset, scale });
  }

  close() { this.#ledger.close(); }

  [Symbol.dispose]() { this.close(); }
}

function summarize({ wallet, cap, window, perPayment, maxPayments, spent, inFlight, remaining, frozen }) {
  const parts = [`${shortWallet(wallet)}: ${formatUsd(spent)} spent of ${formatUsd(cap)} per ${formatWindow(window)}, ${formatUsd(remaining)} left`];
  if (inFlight > 0n) parts.push(`${formatUsd(inFlight)} in flight`);
  if (perPayment !== null) parts.push(`at most ${formatUsd(perPayment)} a payment`);
  if (maxPayments !== null) parts.push(`at most ${maxPayments} payments per ${formatWindow(window)}`);
  if (frozen) parts.push('FROZEN');
  return parts.join(' · ');
}
