// SPDX-License-Identifier: Apache-2.0
// A durable, shared SpendStore for Coinbase's CDP x402 spend controls.
//
// The CDP SDK's default spend store is in-memory and process-local, so a
// cumulative cap resets on restart and is not shared by replicas. This store
// keeps the count in the budget file that every process on the host opens, for
// every rail. append() is the authority: it re-checks the shared budget inside
// one write transaction, so two processes that both pass the SDK's own
// in-memory check cannot both record a payment past the cap.
import { BudgetError } from './errors.mjs';
import { checkKeys, instrumentName, integer, Ledger } from './ledger.mjs';
import { MAX_AMOUNT } from './money.mjs';
import { MAX_PAYMENT_TIMEOUT_SECONDS } from './x402.mjs';

// The CDP store is its own rail. The x402 guard also writes rail 'x402',
// and a shared rail let a guard row reach the CDP loader with the wrong
// reference shape.
const RAIL = 'cdp';
const OPTION_KEYS = new Set(['path', 'instrument', 'asset', 'scale', 'busyTimeoutMs']);

// How long after CDP records a payment it can still settle. CDP records a payment just before
// it signs it, and its applySpendControls refuses a requirement whose maxTimeoutSeconds is over
// 3600 (MAX_PAYMENT_TIMEOUT_SECONDS in @coinbase/cdp-sdk 1.60.0 and 1.61.0), so the signed
// authorization can be redeemed for up to an hour. 60 seconds more covers the time between the
// record and the signature. The payment counts until one window after that.
const SETTLES_WITHIN_MS = BigInt(MAX_PAYMENT_TIMEOUT_SECONDS) * 1000n + 60_000n;

// CDP compares assets after this normalization (EVM addresses lowercased).
const normalizeAsset = asset => {
  const trimmed = String(asset).trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
};

const parseReference = text => {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
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
 * process on the host, for every rail. Pass it as `store` to applySpendControls, and set
 * maxCumulativeSpend there too: the SDK only records through its store when a
 * cumulative cap is configured. A payment CDP rolls back keeps counting here
 * as long as it would have settled, unless its owner releases it sooner.
 */
export class SharedBudgetStore {
  #ledger;
  #instrument;
  #asset;
  #scale;

  constructor(options) {
    checkKeys(options, OPTION_KEYS, 'SharedBudgetStore');
    const { path, instrument, asset, scale = 1n, busyTimeoutMs = 30_000 } = options;
    if (typeof path !== 'string' || path.length === 0) throw new BudgetError('path is required');
    this.#instrument = instrumentName(instrument);
    if (typeof asset !== 'string' || asset.trim().length === 0) throw new BudgetError('asset is required');
    this.#asset = normalizeAsset(asset);
    this.#scale = integer(scale, 'scale');
    this.#ledger = new Ledger(path, { busyTimeoutMs });
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
    const { now, rows } = this.#ledger.countedRows(this.#instrument);
    const { window_ms: windowMs } = this.#ledger.budget(this.#instrument) ?? {};
    // A settled payment that still counts past its window (its reservation's expiry) is dated
    // to the moment it counts from, so CDP's own window check keeps it while walletcap does.
    const countsFrom = row => (row.expires_at_ms !== null && windowMs !== undefined && row.expires_at_ms - windowMs - 1n > row.at_ms
      ? row.expires_at_ms - windowMs - 1n
      : row.at_ms);
    return rows.map(row => {
      const own = parseReference(row.reference);
      // A CDP entry carries atomicAmount. 0.2.0 wrote those on rail 'x402'; accept
      // both so an existing budget keeps counting after the rail split. A guard
      // row has no atomicAmount and falls through to the synthetic entry below.
      let atomic = null;
      if (own && own.atomicAmount !== undefined && normalizeAsset(own.asset) === this.#asset) {
        try { atomic = integer(own.atomicAmount, 'atomicAmount', { allowZero: true }); } catch { atomic = null; }
      }
      if (atomic !== null) {
        // A payment the payee refused stays open, and counts as of now for as long as it does. A
        // settled one is dated by the ledger, not by the time CDP put in its entry.
        const at = row.status === 'reserved' ? Number(now) : Number(countsFrom(row));
        return { atomicAmount: atomic, asset: this.#asset, network: own.network, payTo: own.payTo, at };
      }
      // Spend from another rail (or another asset) counts in this asset's units, rounded up.
      return {
        atomicAmount: ceilDiv(row.amount, this.#scale),
        asset: this.#asset,
        network: `ledger:${row.rail}`,
        payTo: `ledger:${row.spend_id}`,
        // The SDK drops an entry older than its own window; a reservation still
        // open counts as of now, however long ago it was taken.
        at: row.status === 'reserved' ? Number(now) : Number(countsFrom(row)),
      };
    });
  }

  async append(entry) {
    const asset = normalizeAsset(entry.asset);
    if (asset !== this.#asset) {
      throw new BudgetError(`this CDP store counts ${this.#asset}, not ${asset}`);
    }
    const atomic = integer(entry.atomicAmount, 'atomicAmount', { allowZero: true });
    if (atomic === 0n) return;
    const spend = atomic * this.#scale;
    if (spend > MAX_AMOUNT) throw new BudgetError('payment does not fit in the budget unit');
    // The SDK records a payment when it creates it and removes it if settlement
    // fails, so the row counts at once: an unknown outcome keeps counting. It counts
    // from the ledger's own time, until one window past the last moment the signed
    // authorization can be redeemed (SETTLES_WITHIN_MS). The entry's `at` is CDP's, so
    // it is kept only in the reference, which is how removeEntry() finds the row again.
    this.#ledger.record(this.#instrument, spend, { rail: RAIL, reference: reference(entry), settlesWithinMs: SETTLES_WITHIN_MS });
  }

  async prune(olderThanMs) {
    // Only settled payments that no longer count go, whatever window the caller uses.
    this.#ledger.prune(this.#instrument, olderThanMs);
  }

  async removeEntry(entry) {
    // CDP removes a payment from its store in cases the store can't tell apart, and
    // a signed authorization may still be out there. So the payment keeps counting,
    // as an open reservation marked refused, for as long as it would have settled:
    // until one window past the last moment the authorization can be redeemed.
    // Someone who has checked the chain can release it sooner.
    const ref = reference(entry);
    this.#ledger.reopenByReference(this.#instrument, RAIL, ref, { outcome: 'refused' });
    // 0.2.0 wrote CDP entries on the x402 rail; try the old rail too. A guard
    // entry has a different reference, so it cannot match this one.
    this.#ledger.reopenByReference(this.#instrument, 'x402', ref, { outcome: 'refused' });
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
