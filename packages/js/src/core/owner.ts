// SPDX-License-Identifier: Apache-2.0
// The owner's handle: set and change limits, freeze and unfreeze, and reconcile payments with
// evidence: void one that never left, settle one that paid, or void every payment of unknown
// outcome that can no longer settle. The `walletcap` CLI is this handle.
//
// In the library this is an API boundary, not a security one: any process that can open the
// file can open an owner's handle. A budget the agent can't change runs under another OS user
// or behind a service.
import { resolve } from 'node:path';
import { UsageError } from './errors.js';
import { Ledger } from './ledger.js';
import { heldPaymentOf, type HeldPayment, type Payment, paymentOf, type PaymentRecord, recordOf, type Status, statusOf } from './budget.js';
import {
  checkKeys,
  defaultBudgetPath,
  DOLLAR_UNITS,
  expandHome,
  type LimitOptions,
  type Micros,
  normalizeWallet,
  parseLimits,
  shortWallet,
  toWindowMs,
  type Window,
} from './money.js';
import { withJSON } from './wire.js';

const OPTION_KEYS = new Set(['path', 'create', 'busyTimeoutMs']);
const LIMIT_KEYS = new Set(['perPayment', 'perHour', 'perDay', 'perWeek', 'cap', 'window', 'maxPayments']);

export interface OwnerOptions {
  /** The budget file. Defaults to $WALLETCAP_PATH, else the per-user state directory. */
  path?: string;
  /** Create the file (0600, its folder 0700) if it is missing. Defaults to false. */
  create?: boolean;
  /** How long to wait for another process's write, in milliseconds. Defaults to 30000. */
  busyTimeoutMs?: number;
}

/** A budget's limits, as its owner set them. */
export interface BudgetLimits {
  /** The name it is kept under. */
  wallet: string;
  unit: string;
  cap: Micros;
  /** Milliseconds. */
  windowMs: bigint;
  perPayment: Micros | null;
  maxPayments: bigint | null;
  frozen: boolean;
}

/** Open the budget file as its owner. */
/** A payment the owner's bulk release voided. */
export interface VoidedPayment {
  id: string;
  /** Micro-dollars. */
  amount: Micros;
}

export function openOwner(options: OwnerOptions = {}): Promise<Owner> {
  return Owner.open(options);
}

/** The owner's handle. Open it with openOwner(). */
export class Owner {
  readonly #ledger: Ledger;
  readonly #path: string;

  private constructor(ledger: Ledger, path: string) {
    this.#ledger = ledger;
    this.#path = path;
  }

  /** The same as openOwner(). */
  static async open(options: OwnerOptions = {}): Promise<Owner> {
    checkKeys(options, OPTION_KEYS, 'openOwner');
    const path = resolve(expandHome(options.path ?? defaultBudgetPath()));
    const ledger = await Ledger.open(path, { busyTimeoutMs: options.busyTimeoutMs ?? 30_000, create: options.create ?? false });
    return new Owner(ledger, path);
  }

  /** The budget file. */
  get path(): string {
    return this.#path;
  }

  /** Every budget in the file, by name. */
  async budgets(): Promise<BudgetLimits[]> {
    return (await this.#ledger.budgets()).map(row =>
      withJSON({
        wallet: row.wallet,
        unit: row.unit,
        cap: row.cap,
        windowMs: row.window_ms,
        perPayment: row.per_payment,
        maxPayments: row.max_payments,
        frozen: row.frozen_at !== null,
      }),
    );
  }

  /** What counts against `wallet`'s budget now. */
  async status(wallet: string): Promise<Status> {
    return statusOf(await this.#ledger.status(wallet), this.#path);
  }

  /** `wallet`'s newest payments first. */
  async history(wallet: string, { limit = 20 }: { limit?: number | string } = {}): Promise<Payment[]> {
    return (await this.#ledger.history(wallet, { limit })).map(paymentOf);
  }

  /** `wallet`'s held payments that still count, oldest first. */
  async holds(wallet: string): Promise<HeldPayment[]> {
    return (await this.#ledger.counting(wallet, { heldOnly: true })).map(heldPaymentOf);
  }

  /** One payment by its id, or null. */
  async payment(id: string): Promise<PaymentRecord | null> {
    const row = await this.#ledger.payment(id);
    return row === null ? null : recordOf(row);
  }

  /**
   * Set `wallet`'s limits, up or down, creating its budget if it has none (which needs a rolling
   * limit). What was spent keeps counting. The window changes only while no payment counts.
   */
  async setLimits(wallet: string, limits: LimitOptions): Promise<Status> {
    checkKeys(limits, LIMIT_KEYS, 'setLimits');
    const name = normalizeWallet(wallet);
    const parsed = parseLimits(limits);
    if (Object.keys(parsed).length === 0) throw new UsageError("setLimits needs a limit, like { perDay: '$150' }");
    const row = await this.#ledger.budget(name);
    if (row === null) {
      if (parsed.cap === undefined || parsed.windowMs === undefined) {
        throw new UsageError(`${shortWallet(name)} has no budget yet: give it a rolling limit too, like --per-day 150`);
      }
      await this.#ledger.createBudget(name, {
        cap: parsed.cap,
        windowMs: parsed.windowMs,
        perPayment: parsed.perPayment ?? null,
        maxPayments: parsed.maxPayments ?? null,
      });
    } else {
      if (!DOLLAR_UNITS.has(row.unit)) throw new UsageError(`${shortWallet(name)}'s budget counts in ${row.unit}, not usd`);
      const changes: { cap?: bigint; windowMs?: bigint; perPayment?: bigint | null; maxPayments?: bigint | null } = {};
      if (parsed.cap !== undefined) changes.cap = parsed.cap;
      if (parsed.windowMs !== undefined) changes.windowMs = parsed.windowMs;
      if (parsed.perPayment !== undefined) changes.perPayment = parsed.perPayment;
      if (parsed.maxPayments !== undefined) changes.maxPayments = parsed.maxPayments;
      await this.#ledger.setLimits(name, changes);
    }
    return this.status(name);
  }

  /** Refuse every payment from `wallet`, on every rail and in every process, until unfreeze(). */
  async freeze(wallet: string): Promise<void> {
    await this.#ledger.freeze(wallet);
  }

  /** Allow payments again, after freeze() or after an upgrade froze the budget. */
  async unfreeze(wallet: string): Promise<void> {
    await this.#ledger.unfreeze(wallet);
  }

  /**
   * Void a held payment: evidence that it never moved money, such as the chain showing its
   * authorization unused past its expiry. It stops counting. A settled payment can't be voided.
   */
  async void(id: string, { evidence = 'voided by its owner' }: { evidence?: string } = {}): Promise<PaymentRecord> {
    return recordOf(await this.#ledger.ownerVoid(id, { evidence }));
  }

  /**
   * Settle a held or void payment: evidence that it paid, such as its transaction hash. It counts
   * through one window from now, or from its settle-by time if that is later.
   */
  async settle(id: string, { evidence = 'settled by its owner' }: { evidence?: string } = {}): Promise<PaymentRecord> {
    return recordOf(await this.#ledger.ownerSettle(id, { evidence }));
  }

  /**
   * The bulk release: void every held payment of `wallet` whose outcome is unknown or refused,
   * held at least `olderThan` ago, that can no longer settle: its settle-by time has passed, or,
   * with none, it was held for an x402 payment and is an hour and a minute old. Any other payment
   * with no settle-by time, a transfer say, has no such bound: void it by id, with evidence. Only
   * for payments its owner knows never left.
   */
  async voidUnknown(wallet: string, { olderThan }: { olderThan: Window }): Promise<VoidedPayment[]> {
    const age = toWindowMs(olderThan, 'olderThan');
    const voided = await this.#ledger.voidUnknown(wallet, age, { evidence: 'voided by its owner: unknown or refused outcome' });
    return voided.map(row => withJSON({ id: row.payment, amount: row.amount }));
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
