// SPDX-License-Identifier: Apache-2.0
// One spend budget per wallet, counted across every process, replica, key, permission and rail.

export declare const SCHEMA_VERSION: string;
/** The largest amount a budget holds, in its own unit (micro-dollars for openBudget). */
export declare const MAX_AMOUNT: bigint;

/**
 * Dollars: a string ("$12.50", "12.50 USDC", "$1,000") read exactly, a number
 * of dollars rounded to the nearest micro-dollar, or a bigint of micro-dollars
 * (1_000_000n is $1).
 */
export type Dollars = string | number | bigint;

/** A rolling window: "24h", "7d", "30m", "day", or milliseconds. */
export type Window = string | number | bigint;

export type RefusalReason = 'budget' | 'per_payment' | 'uses' | 'revoked' | 'asset';

export declare class BudgetError extends Error {}

export declare class BudgetRefused extends BudgetError {
  readonly reason: RefusalReason;
  readonly code: `budget_${RefusalReason}`;
}

/** Tag an error to say the payment never left the wallet, so pay() gives its amount back. */
export declare function notSent<E>(error?: E): E extends Error ? E & { notSent: true } : Error & { notSent: true };

export interface Limits {
  /** Most one payment may spend; null for no per-payment limit. */
  perPayment?: Dollars | null;
  /** One rolling limit: perHour, perDay, perWeek, or cap with window. */
  perHour?: Dollars;
  perDay?: Dollars;
  perWeek?: Dollars;
  cap?: Dollars;
  window?: Window;
  /** Most payments in one window; null for no limit. */
  maxPayments?: number | bigint | null;
}

export interface BudgetOptions extends Limits {
  /** The wallet or account the money leaves from. EVM addresses are lowercased, bare or CAIP-10. */
  wallet: string;
  /** The budget file. Defaults to $WALLETCAP_PATH, else the per-user state directory. */
  path?: string;
  /** Create the file and the wallet's budget if missing (default false: only an owner's `walletcap set` creates them). Pass true only for a demo or a first-run setup. */
  create?: boolean;
  /** Milliseconds since the epoch. Defaults to Date.now. */
  clock?: () => number;
  /** How long to wait for another process's write. Defaults to 30000. */
  busyTimeoutMs?: number;
  /** Called instead of process.emitWarning when the file keeps a limit tighter than the code asks for. */
  onWarning?: (message: string) => void;
}

export interface Check {
  ok: boolean;
  reason?: RefusalReason;
  message?: string;
  /** Micro-dollars left in the window. */
  remaining: bigint;
}

export interface PaymentDetails {
  /** Who is paid, for the history. */
  to?: string;
  /** What for, for the history. */
  note?: string;
  /** More JSON fields kept with the payment. */
  details?: Record<string, unknown>;
  /** The rail, for the history. Defaults to 'js'. */
  rail?: string;
  /** The last moment the payment could still settle. An open reservation stops counting one window after it. */
  settlesBy?: Date | number | bigint;
}

export declare class Reservation {
  /** Unique per payment: a good idempotency key. */
  readonly id: string;
  /** Micro-dollars. */
  readonly amount: bigint;
  readonly open: boolean;
  /** The payment settled: it counts for one rolling window from now. */
  commit(result?: { tx?: string; outcome?: string; error?: string }): void;
  /** The payment never left the wallet: give its amount back. */
  release(): void;
  annotate(fields: Record<string, unknown>): void;
}

export interface Status {
  wallet: string;
  path: string;
  /** Micro-dollars per window. */
  cap: bigint;
  /** Milliseconds. */
  window: bigint;
  perPayment: bigint | null;
  maxPayments: bigint | null;
  /** Settled in the window, micro-dollars. */
  spent: bigint;
  /** Reserved and not yet settled or released, micro-dollars. */
  inFlight: bigint;
  remaining: bigint;
  payments: bigint;
  frozen: boolean;
  /** One line for a log. */
  summary: string;
}

export interface Payment {
  id: string;
  amount: bigint;
  status: 'settled' | 'in flight' | 'refused' | 'unknown' | 'expired';
  /** Whether it counts against the budget right now. */
  counting: boolean;
  at: Date;
  rail: string;
  to?: string;
  note?: string;
  tx?: string;
}

export interface AssetEntry {
  /** CAIP-2, like 'eip155:8453'. */
  network: string;
  asset: string;
  decimals: number;
}

/** The USD stablecoins guard() counts at face value without being told. */
export declare const USD_ASSETS: readonly Readonly<AssetEntry>[];

export interface X402HookedClient {
  onBeforePaymentCreation(hook: (context: any) => Promise<unknown>): unknown;
  onAfterPaymentCreation(hook: (context: any) => Promise<unknown>): unknown;
  onPaymentCreationFailure(hook: (context: any) => Promise<unknown>): unknown;
  onPaymentResponse(hook: (context: any) => Promise<unknown>): unknown;
  registerPolicy?(policy: (version: number, requirements: any[]) => any[]): unknown;
}

export declare class Budget {
  constructor(options: BudgetOptions);
  readonly wallet: string;
  readonly path: string;
  /** Whether `amount` would be paid right now, without taking it. */
  check(amount: Dollars): Check;
  /** Take `amount` before paying, or throw BudgetRefused. */
  reserve(amount: Dollars, details?: PaymentDetails): Reservation;
  /**
   * Reserve `amount`, run `fn` to pay, then record it. If `fn` throws, the
   * payment still counts unless the error is tagged with notSent().
   */
  pay<T>(amount: Dollars, fn: (reservation: Reservation) => T | Promise<T>, details?: PaymentDetails): Promise<T>;
  status(): Status;
  /** Change the limits, up or down. What was spent keeps counting. */
  setLimits(limits: Limits): Status;
  /** Refuse every payment from this wallet, everywhere, until unfreeze(). */
  freeze(): void;
  unfreeze(): void;
  history(options?: { limit?: number }): Payment[];
  /** Count every payment an x402 client (@x402/core 2.x) makes in this budget. Returns the client. */
  guard<C extends X402HookedClient>(client: C, options?: { assets?: AssetEntry[] }): C;
  /**
   * Count every payment a Coinbase AgentKit X402ActionProvider makes in this budget: each x402
   * client the provider builds is guarded before it can sign. Returns the provider.
   */
  guardAgentKit<P extends object>(provider: P, options?: { assets?: AssetEntry[] }): P;
  /** A SpendStore for Coinbase's CDP applySpendControls that counts in this budget. */
  cdpStore(options: { asset: string; scale?: bigint | number; clock?: () => number }): SharedBudgetStore;
  close(): void;
}

/** Open the wallet's budget. Its owner creates it with `walletcap set`; pass create: true only for a demo. */
export declare function openBudget(options: BudgetOptions): Budget;

/** Dollars as micro-dollars. */
export declare function toMicros(value: Dollars, label?: string): bigint;
/** Micro-dollars as "$1,234.50". */
export declare function formatUsd(micros: bigint): string;
/** The budget file every process on this machine shares by default. */
export declare function defaultBudgetPath(): string;

// --- Coinbase CDP x402 spend controls ----------------------------------------
// Structurally compatible with SpendLedgerEntry and SpendStore in @coinbase/cdp-sdk/x402.

export interface SpendLedgerEntry {
  atomicAmount: bigint;
  asset: string;
  network: string;
  payTo: string;
  at: number;
}

export interface SharedBudgetStoreOptions {
  /** The budget file shared by every process, replica and rail that spends from the budget. */
  path: string;
  /** The funding instrument whose budget this store spends from. */
  instrument: string;
  /** The asset the x402 client pays in, as CDP normalizes it. */
  asset: string;
  /** Budget units per atomic unit of `asset`. Defaults to 1n. */
  scale?: bigint | number;
  /** Milliseconds since the epoch. Defaults to Date.now. */
  clock?: () => number;
  /** How long to wait for another process's write transaction. Defaults to 30000. */
  busyTimeoutMs?: number;
}

export interface BudgetDeclaration {
  unit: string;
  cap: bigint | number;
  windowMs: bigint | number;
  perPayment?: bigint | number | null;
  maxUses?: bigint | number | null;
}

export interface BudgetStatus {
  instrument: string;
  unit: string;
  cap: bigint;
  spent: bigint;
  reserved: bigint;
  uses: bigint;
  revoked: boolean;
  remaining: bigint;
}

export declare class SharedBudgetStore {
  constructor(options: SharedBudgetStoreOptions);
  readonly instrument: string;
  declare(budget: BudgetDeclaration): void;
  size(): Promise<number>;
  load(): Promise<SpendLedgerEntry[]>;
  append(entry: SpendLedgerEntry): Promise<void>;
  prune(olderThanMs: number): Promise<void>;
  removeEntry(entry: SpendLedgerEntry): Promise<void>;
  revoke(): void;
  status(): BudgetStatus;
  close(): void;
}
