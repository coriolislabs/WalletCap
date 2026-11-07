// SPDX-License-Identifier: Apache-2.0
// A durable, shared SpendStore for Coinbase's CDP x402 spend controls.
//
// The CDP SDK's default spend store is in-memory and process-local, so a
// cumulative cap resets on restart and is not shared by replicas. This store
// keeps the count in the budget file that every process on the host opens, for
// every rail. append() is the authority: it re-checks the shared budget inside
// one write transaction, so two processes that both pass the SDK's own
// in-memory check cannot both record a payment past the cap.
import { BudgetError, forAgent } from './errors.mjs';
import { Ledger, walletKey } from './ledger.mjs';
import { checkKeys, formatAmount, formatWindow, MAX_AMOUNT, shortWallet } from './money.mjs';
import { MAX_PAYMENT_TIMEOUT_SECONDS } from './x402.mjs';

// The CDP store is its own rail. The x402 guard also writes rail 'x402', and a shared rail let a
// guard row reach the CDP loader with the wrong reference shape.
const RAIL = 'cdp';
const OPTION_KEYS = new Set(['path', 'instrument', 'asset', 'scale', 'busyTimeoutMs']);
const OPEN = (1n << 63n) - 1n;

// How long after CDP records a payment it can still settle. CDP records a payment just before
// it signs it, and its applySpendControls refuses a requirement whose maxTimeoutSeconds is over
// 3600 (MAX_PAYMENT_TIMEOUT_SECONDS in @coinbase/cdp-sdk 1.60.0 and 1.61.0), so the signed
// authorization can be redeemed for up to an hour. 60 seconds more covers the time between the
// record and the signature. The payment is held that long from the ledger's own time, and counts
// until one window after.
const SETTLES_WITHIN_MS = BigInt(MAX_PAYMENT_TIMEOUT_SECONDS) * 1000n + 60_000n;

// CDP compares assets after this normalization (EVM addresses lowercased).
const normalizeAsset = asset => {
  const trimmed = String(asset).trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
};

const parseInfo = text => {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
};

const fingerprint = entry => JSON.stringify({
  atomicAmount: String(entry.atomicAmount),
  asset: entry.asset,
  network: entry.network,
  payTo: entry.payTo,
  at: Number(entry.at),
});

const ceilDiv = (numerator, denominator) => (numerator + denominator - 1n) / denominator;

/**
 * A CDP SpendStore whose count lives in the budget file shared by every process on the host,
 * for every rail. Pass it as `store` to applySpendControls, and set maxCumulativeSpend there too:
 * the SDK only records through its store when a cumulative cap is configured. append() holds the
 * payment through the ledger's admission, so two processes that both pass the SDK's own check
 * can't both record a payment past the cap. A payment CDP rolls back keeps counting as long as it
 * would have settled.
 */
export class SharedBudgetStore {
  #ledger;
  #instrument;
  #asset;
  #scale;
  // The payments this store appended, by CDP's entry, so removeEntry() can find one.
  #appended = new Map();

  constructor(options) {
    checkKeys(options, OPTION_KEYS, 'SharedBudgetStore');
    const { path, instrument, asset, scale = 1n, busyTimeoutMs = 30_000 } = options;
    if (typeof path !== 'string' || path.length === 0) throw new BudgetError('path is required');
    this.#instrument = walletKey(instrument);
    if (typeof asset !== 'string' || asset.trim().length === 0) throw new BudgetError('asset is required');
    this.#asset = normalizeAsset(asset);
    if (!(typeof scale === 'bigint' || Number.isSafeInteger(scale)) || BigInt(scale) <= 0n) throw new BudgetError('scale must be a positive integer');
    this.#scale = BigInt(scale);
    this.#ledger = new Ledger(path, { busyTimeoutMs, create: true });
  }

  get instrument() { return this.#instrument; }

  /** Record the instrument's budget once; declaring it again with other limits is refused. */
  declare({ unit, cap, windowMs, perPayment = null, maxUses = null }) {
    const row = this.#ledger.budget(this.#instrument);
    if (row === null) {
      this.#ledger.createBudget(this.#instrument, { unit, cap, windowMs, perPayment, maxPayments: maxUses });
      return;
    }
    const asked = { unit, cap: BigInt(cap), window_ms: BigInt(windowMs), per_payment: perPayment === null ? null : BigInt(perPayment), max_payments: maxUses === null ? null : BigInt(maxUses) };
    if (Object.keys(asked).some(key => row[key] !== asked[key])) {
      const text = limits => [`${formatAmount(limits.cap, limits.unit)} per ${formatWindow(limits.window_ms)}`,
        ...(limits.per_payment === null ? [] : [`at most ${formatAmount(limits.per_payment, limits.unit)} a payment`]),
        ...(limits.max_payments === null ? [] : [`${limits.max_payments} payments per ${formatWindow(limits.window_ms)}`]),
      ].join(', ') + (row.unit === asked.unit ? '' : ` in ${limits.unit}`);
      let merged = null;
      try { merged = row.merged_from === null ? null : JSON.parse(row.merged_from); } catch { merged = null; }
      const note = merged === null ? '' : `. The 0.3.0 upgrade merged the budget${merged.length === 1 ? '' : 's'} 0.2.x kept under ${merged.join(', ')} `
        + "into this one, with the tighter of each limit; its owner can change them with 'walletcap set'";
      throw new BudgetError(`${shortWallet(this.#instrument)}'s budget is already declared with other limits: ${text(row)}, not ${text(asked)}${note}`);
    }
  }

  // --- CDP SpendStore -------------------------------------------------------

  async size() {
    return this.#ledger.counting(this.#instrument).length;
  }

  async load() {
    return this.#ledger.counting(this.#instrument).map(row => {
      // Dated to the moment its window counts from, so CDP's own window check keeps it as long
      // as walletcap does: now, for a payment that counts until evidence ends it.
      const at = Number(row.counts_from === OPEN || row.counts_from > row.now ? row.now : row.counts_from);
      const own = parseInfo(row.info);
      if (own?.atomicAmount !== undefined && normalizeAsset(own.asset) === this.#asset) {
        try {
          return { atomicAmount: BigInt(own.atomicAmount), asset: this.#asset, network: own.network, payTo: own.payTo, at };
        } catch { /* not a CDP entry after all */ }
      }
      // Spend from another rail (or another asset) counts in this asset's units, rounded up.
      return { atomicAmount: ceilDiv(row.amount, this.#scale), asset: this.#asset, network: `ledger:${row.rail}`, payTo: `ledger:${row.payment}`, at };
    });
  }

  async append(entry) {
    const asset = normalizeAsset(entry.asset);
    if (asset !== this.#asset) throw new BudgetError(`this CDP store counts ${this.#asset}, not ${asset}`);
    let atomic;
    try { atomic = BigInt(entry.atomicAmount); } catch { throw new BudgetError('atomicAmount must be an integer'); }
    if (atomic < 0n) throw new BudgetError('atomicAmount must be an integer');
    if (atomic === 0n) return;
    const spend = atomic * this.#scale;
    if (spend > MAX_AMOUNT) throw new BudgetError('payment does not fit in the budget unit');
    // CDP records a payment when it creates it and removes it if settlement fails, so it is held
    // at once, from the ledger's own time, until the signed authorization can no longer be
    // redeemed. The entry's own `at` is CDP's, kept only with the payment.
    let held;
    try {
      held = this.#ledger.hold(this.#instrument, spend, { rail: RAIL, info: fingerprint(entry), withinMs: SETTLES_WITHIN_MS });
    } catch (error) {
      throw forAgent(error); // CDP passes it on to the agent: no hold ids, no release instructions
    }
    const key = fingerprint(entry);
    this.#appended.set(key, [...(this.#appended.get(key) ?? []), held.payment]);
  }

  async prune() {
    // The ledger keeps every payment; one that no longer counts is never read.
  }

  async removeEntry(entry) {
    // CDP removes a payment from its store in cases the store can't tell apart, and a signed
    // authorization may still be out there. So the payment keeps counting for as long as it
    // would have settled, noted refused. Someone who has checked the chain can void it sooner.
    const key = fingerprint(entry);
    const [payment, ...rest] = this.#appended.get(key) ?? [];
    if (payment === undefined) return;
    if (rest.length === 0) this.#appended.delete(key);
    else this.#appended.set(key, rest);
    this.#ledger.note(payment, 'refused', { evidence: 'removed by CDP' });
  }

  // --- Budget -----------------------------------------------------------------

  /** Refuse every later payment for the instrument, on every rail. */
  revoke() { this.#ledger.freeze(this.#instrument); }

  /** What counts against the instrument's budget right now, in budget units. */
  status() {
    const s = this.#ledger.status(this.#instrument);
    return {
      instrument: this.#instrument, unit: s.unit, cap: s.cap, spent: s.spent, reserved: s.in_flight, uses: s.payments, revoked: s.frozen_at !== null, remaining: s.remaining,
    };
  }

  close() { this.#ledger.close(); }
}
