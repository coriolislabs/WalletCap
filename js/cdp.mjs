// SPDX-License-Identifier: Apache-2.0
// A durable, shared SpendStore for Coinbase's CDP x402 spend controls.
//
// The CDP SDK's default spend store is in-memory and process-local, so a
// cumulative cap resets on restart and is not shared by replicas. This store
// keeps the count in the budget file that every process, replica and rail
// opens. append() is the authority: it re-checks the shared budget inside one
// write transaction, so two processes that both pass the SDK's own in-memory
// check cannot both record a payment past the cap.
import { BudgetError } from './errors.mjs';
import { identifier, Ledger, units } from './ledger.mjs';
import { MAX_AMOUNT } from './money.mjs';

const RAIL = 'x402';

// CDP compares assets after this normalization (EVM addresses lowercased).
const normalizeAsset = asset => {
  const trimmed = String(asset).trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
};

const reference = entry => JSON.stringify({
  atomicAmount: String(entry.atomicAmount),
  asset: entry.asset,
  network: entry.network,
  payTo: entry.payTo,
  at: Number(entry.at),
});

const ceilDiv = (numerator, denominator) => (numerator + denominator - 1n) / denominator;

/**
 * A CDP SpendStore whose count lives in the budget file shared by every
 * process, replica and rail. Pass it as `store` to applySpendControls, and set
 * maxCumulativeSpend there too: the SDK only records through its store when a
 * cumulative cap is configured. A payment CDP rolls back keeps counting here
 * until it is released; Budget.guard() frees it on its own once its
 * authorization expires.
 */
export class SharedBudgetStore {
  #ledger;
  #instrument;
  #asset;
  #scale;

  constructor({ path, instrument, asset, scale = 1n, clock = Date.now, busyTimeoutMs = 30_000 }) {
    if (typeof path !== 'string' || path.length === 0) throw new BudgetError('path is required');
    this.#instrument = identifier(instrument, 'instrument');
    if (typeof asset !== 'string' || asset.trim().length === 0) throw new BudgetError('asset is required');
    this.#asset = normalizeAsset(asset);
    this.#scale = units(scale, 'scale');
    this.#ledger = new Ledger(path, { clock, busyTimeoutMs });
  }

  get instrument() { return this.#instrument; }

  /** Record the instrument's budget once; declaring it again with other limits is refused. */
  declare({ unit, cap, windowMs, perPayment = null, maxUses = null }) {
    this.#ledger.declare(this.#instrument, { unit, cap, windowMs, perPayment, maxUses });
  }

  // --- CDP SpendStore -------------------------------------------------------

  async size() {
    return Number(this.#ledger.counted(this.#instrument).uses);
  }

  async load() {
    const now = this.#ledger.now();
    return this.#ledger.countedRows(this.#instrument, now).map(row => {
      const own = row.rail === RAIL && row.reference ? JSON.parse(row.reference) : null;
      if (own && own.asset === this.#asset) {
        // A payment the payee refused stays open, and counts as of now for as long as it does.
        const at = row.status === 'reserved' ? Number(now) : own.at;
        return { atomicAmount: BigInt(own.atomicAmount), asset: own.asset, network: own.network, payTo: own.payTo, at };
      }
      // Spend from another rail (or another asset) counts in this asset's units, rounded up.
      return {
        atomicAmount: ceilDiv(row.amount, this.#scale),
        asset: this.#asset,
        network: `ledger:${row.rail}`,
        payTo: `ledger:${row.spend_id}`,
        // The SDK drops an entry older than its own window; a reservation still
        // open counts as of now, however long ago it was taken.
        at: row.status === 'reserved' ? Number(now) : Number(row.at_ms),
      };
    });
  }

  async append(entry) {
    const atomic = units(entry.atomicAmount, 'atomicAmount', { allowZero: true });
    if (atomic === 0n) return;
    const spend = atomic * this.#scale;
    if (spend > MAX_AMOUNT) throw new BudgetError('payment does not fit in the budget unit');
    // The SDK records a payment when it creates it and removes it if settlement
    // fails, so the row counts at once, with no expiry: an unknown outcome keeps counting.
    this.#ledger.record(this.#instrument, spend, {
      rail: RAIL,
      reference: reference(entry),
      atMs: units(entry.at, 'at', { allowZero: true }),
    });
  }

  async prune(olderThanMs) {
    // Only settled payments that no longer count go, whatever window the caller uses.
    this.#ledger.prune(this.#instrument, olderThanMs);
  }

  async removeEntry(entry) {
    // CDP removes a payment from its store in cases the store can't tell apart, and
    // a signed authorization may still be out there. So the payment keeps counting,
    // as an open reservation marked refused, until someone who has checked the chain
    // releases it.
    this.#ledger.reopenByReference(this.#instrument, RAIL, reference(entry), { outcome: 'refused' });
  }

  // --- Budget -----------------------------------------------------------------

  /** Refuse every later payment for the instrument, on every rail. */
  revoke() { this.#ledger.revoke(this.#instrument); }

  /** What counts against the instrument's budget right now, in budget units. */
  status() {
    const { instrument, unit, cap, spent, reserved, uses, revoked, remaining } = this.#ledger.status(this.#instrument);
    return { instrument, unit, cap, spent, reserved, uses, revoked, remaining };
  }

  close() { this.#ledger.close(); }
}
