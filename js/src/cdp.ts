// SPDX-License-Identifier: Apache-2.0
// A durable, shared SpendStore for Coinbase's CDP x402 spend controls.
//
// The CDP SDK's default spend store is in-memory and process-local, so a cumulative cap resets
// on restart and is not shared by replicas. This store keeps the count in the budget file that
// every process on the host opens, for every rail. append() is the authority: it holds the
// payment through the ledger's admission, inside one write transaction, so two processes that
// both pass the SDK's own in-memory check cannot both record a payment past the cap.
import { BudgetError, forAgent } from './errors.js';
import { Ledger, OPEN, walletKey } from './ledger.js';
import { checkKeys, formatAmount, formatWindow, MAX_AMOUNT, shortWallet } from './money.js';
import { MAX_PAYMENT_TIMEOUT_SECONDS } from './x402.js';

// The CDP store is its own rail. The x402 guard also writes rail 'x402', and a shared rail let a
// guard row reach the CDP loader with the wrong reference shape.
const RAIL = 'cdp';
const OPTION_KEYS = new Set(['path', 'instrument', 'asset', 'scale', 'busyTimeoutMs']);

// How long after CDP records a payment it can still settle. CDP records a payment just before
// it signs it, and its applySpendControls refuses a requirement whose maxTimeoutSeconds is over
// 3600 (MAX_PAYMENT_TIMEOUT_SECONDS in @coinbase/cdp-sdk 1.60.0 and 1.61.0), so the signed
// authorization can be redeemed for up to an hour. 60 seconds more covers the time between the
// record and the signature. The payment is held that long from the ledger's own time, and counts
// until one window after.
const SETTLES_WITHIN_MS = BigInt(MAX_PAYMENT_TIMEOUT_SECONDS) * 1000n + 60_000n;

/** A payment as CDP's SpendStore interface carries it. Structurally the same as @coinbase/cdp-sdk/x402's SpendLedgerEntry. */
export interface SpendLedgerEntry {
  atomicAmount: bigint | string | number;
  asset: string;
  network: string;
  payTo: string;
  at: number;
}

export interface SharedBudgetStoreOptions {
  /** The budget file shared by every process on one host, on every rail, that spends from the budget. */
  path: string;
  /** The funding instrument whose budget this store spends from. */
  instrument: string;
  /** The asset the x402 client pays in, as CDP normalizes it. */
  asset: string;
  /** Budget units per atomic unit of `asset`. Defaults to 1n. */
  scale?: bigint | number;
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

// CDP compares assets after this normalization (EVM addresses lowercased).
const normalizeAsset = (asset: unknown): string => {
  const trimmed = String(asset).trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
};

const parseInfo = (text: string | null): Record<string, unknown> | null => {
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const fingerprint = (entry: SpendLedgerEntry): string => JSON.stringify({
  atomicAmount: String(entry.atomicAmount),
  asset: entry.asset,
  network: entry.network,
  payTo: entry.payTo,
  at: Number(entry.at),
});

const ceilDiv = (numerator: bigint, denominator: bigint): bigint => (numerator + denominator - 1n) / denominator;

/**
 * A CDP SpendStore whose count lives in the budget file shared by every process on the host, for
 * every rail. Pass it as `store` to applySpendControls, and set maxCumulativeSpend there too:
 * the SDK only records through its store when a cumulative cap is configured. The file is opened
 * on first use. A payment CDP rolls back keeps counting as long as it would have settled.
 */
export class SharedBudgetStore {
  readonly #path: string;
  readonly #busyTimeoutMs: number;
  readonly #instrument: string;
  readonly #asset: string;
  readonly #scale: bigint;
  #ledger: Promise<Ledger> | null = null;
  #closed = false;
  // The payments this store appended, by CDP's entry, so removeEntry() can find one.
  readonly #appended = new Map<string, string[]>();

  constructor(options: SharedBudgetStoreOptions) {
    checkKeys(options, OPTION_KEYS, 'SharedBudgetStore');
    const { path, instrument, asset, scale = 1n, busyTimeoutMs = 30_000 } = options;
    if (typeof path !== 'string' || path.length === 0) throw new BudgetError('path is required');
    this.#path = path;
    this.#busyTimeoutMs = busyTimeoutMs;
    this.#instrument = walletKey(instrument);
    if (typeof asset !== 'string' || asset.trim().length === 0) throw new BudgetError('asset is required');
    this.#asset = normalizeAsset(asset);
    if (!(typeof scale === 'bigint' || Number.isSafeInteger(scale)) || BigInt(scale) <= 0n) throw new BudgetError('scale must be a positive integer');
    this.#scale = BigInt(scale);
  }

  get instrument(): string { return this.#instrument; }

  #open(): Promise<Ledger> {
    if (this.#closed) return Promise.reject(new BudgetError(`the budget file ${this.#path} is closed`));
    this.#ledger ??= Ledger.open(this.#path, { busyTimeoutMs: this.#busyTimeoutMs, create: true });
    return this.#ledger;
  }

  /** Record the instrument's budget once; declaring it again with other limits is refused. */
  async declare({ unit, cap, windowMs, perPayment = null, maxUses = null }: BudgetDeclaration): Promise<void> {
    const ledger = await this.#open();
    const row = await ledger.budget(this.#instrument);
    const asked = {
      unit,
      cap: BigInt(cap),
      window_ms: BigInt(windowMs),
      per_payment: perPayment === null ? null : BigInt(perPayment),
      max_payments: maxUses === null ? null : BigInt(maxUses),
    };
    if (row === null) {
      await ledger.createBudget(this.#instrument, { unit, cap: asked.cap, windowMs: asked.window_ms, perPayment: asked.per_payment, maxPayments: asked.max_payments });
      return;
    }
    const same = row.unit === asked.unit && row.cap === asked.cap && row.window_ms === asked.window_ms
      && row.per_payment === asked.per_payment && row.max_payments === asked.max_payments;
    if (same) return;
    const text = (limits: typeof asked): string => [`${formatAmount(limits.cap, limits.unit)} per ${formatWindow(limits.window_ms)}`,
      ...(limits.per_payment === null ? [] : [`at most ${formatAmount(limits.per_payment, limits.unit)} a payment`]),
      ...(limits.max_payments === null ? [] : [`${limits.max_payments} payments per ${formatWindow(limits.window_ms)}`]),
    ].join(', ') + (row.unit === asked.unit ? '' : ` in ${limits.unit}`);
    let merged: string[] | null = null;
    try { merged = row.merged_from === null ? null : JSON.parse(row.merged_from) as string[]; } catch { merged = null; }
    const note = merged === null ? '' : `. The 0.3.0 upgrade merged the budget${merged.length === 1 ? '' : 's'} 0.2.x kept under ${merged.join(', ')} `
      + "into this one, with the tighter of each limit; its owner can change them with 'walletcap set'";
    throw new BudgetError(`${shortWallet(this.#instrument)}'s budget is already declared with other limits: ${text(row)}, not ${text(asked)}${note}`);
  }

  // --- CDP SpendStore -------------------------------------------------------

  async size(): Promise<number> {
    return (await (await this.#open()).counting(this.#instrument)).length;
  }

  async load(): Promise<SpendLedgerEntry[]> {
    const rows = await (await this.#open()).counting(this.#instrument);
    return rows.map(row => {
      // Dated to the moment its window counts from, so CDP's own window check keeps it as long
      // as walletcap does: now, for a payment that counts until evidence ends it.
      const countsFrom = row.counts_from ?? row.now;
      const at = Number(countsFrom === OPEN || countsFrom > row.now ? row.now : countsFrom);
      const own = parseInfo(row.info);
      if (own?.atomicAmount !== undefined && normalizeAsset(own.asset) === this.#asset) {
        try {
          return { atomicAmount: BigInt(own.atomicAmount as string), asset: this.#asset, network: String(own.network), payTo: String(own.payTo), at };
        } catch { /* not a CDP entry after all */ }
      }
      // Spend from another rail (or another asset) counts in this asset's units, rounded up.
      return { atomicAmount: ceilDiv(row.amount, this.#scale), asset: this.#asset, network: `ledger:${row.rail}`, payTo: `ledger:${row.payment}`, at };
    });
  }

  async append(entry: SpendLedgerEntry): Promise<void> {
    const asset = normalizeAsset(entry.asset);
    if (asset !== this.#asset) throw new BudgetError(`this CDP store counts ${this.#asset}, not ${asset}`);
    let atomic: bigint;
    try { atomic = BigInt(entry.atomicAmount); } catch { throw new BudgetError('atomicAmount must be an integer'); }
    if (atomic < 0n) throw new BudgetError('atomicAmount must be an integer');
    if (atomic === 0n) return;
    const spend = atomic * this.#scale;
    if (spend > MAX_AMOUNT) throw new BudgetError('payment does not fit in the budget unit');
    // CDP records a payment when it creates it and removes it if settlement fails, so it is held
    // at once, from the ledger's own time, until the signed authorization can no longer be
    // redeemed. The entry's own `at` is CDP's, kept only with the payment.
    const ledger = await this.#open();
    let held;
    try {
      held = await ledger.hold(this.#instrument, spend, { rail: RAIL, info: fingerprint(entry), withinMs: SETTLES_WITHIN_MS });
    } catch (error) {
      throw forAgent(error); // CDP passes it on to the agent: no hold ids, no release instructions
    }
    const key = fingerprint(entry);
    this.#appended.set(key, [...(this.#appended.get(key) ?? []), held.payment]);
  }

  async prune(_olderThanMs?: number): Promise<void> {
    // The ledger keeps every payment; one that no longer counts is never read.
  }

  async removeEntry(entry: SpendLedgerEntry): Promise<void> {
    // CDP removes a payment from its store in cases the store can't tell apart, and a signed
    // authorization may still be out there. So the payment keeps counting for as long as it
    // would have settled, noted refused. Someone who has checked the chain can void it sooner.
    const key = fingerprint(entry);
    const [payment, ...rest] = this.#appended.get(key) ?? [];
    if (payment === undefined) return;
    if (rest.length === 0) this.#appended.delete(key);
    else this.#appended.set(key, rest);
    await (await this.#open()).note(payment, 'refused', { evidence: 'removed by CDP' });
  }

  // --- Budget -----------------------------------------------------------------

  /** Refuse every later payment for the instrument, on every rail. */
  async revoke(): Promise<void> { await (await this.#open()).freeze(this.#instrument); }

  /** What counts against the instrument's budget right now, in budget units. */
  async status(): Promise<BudgetStatus> {
    const s = await (await this.#open()).status(this.#instrument);
    return {
      instrument: this.#instrument, unit: s.unit, cap: s.cap, spent: s.spent, reserved: s.in_flight, uses: s.payments, revoked: s.frozen_at !== null, remaining: s.remaining,
    };
  }

  close(): void {
    this.#closed = true;
    const opened = this.#ledger;
    this.#ledger = null;
    opened?.then(ledger => ledger.close(), () => {});
  }
}
