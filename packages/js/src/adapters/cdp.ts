// SPDX-License-Identifier: Apache-2.0
// walletcap/cdp: a durable, shared SpendStore for Coinbase's CDP x402 spend controls.
//
//   import { cdpStore } from 'walletcap/cdp';
//   applySpendControls(client, { ...limits, allowedAssets: [USDC], store: cdpStore(budget, { asset: USDC }) });
//
// The CDP SDK's default spend store is in-memory and process-local, so a cumulative cap resets
// on restart and is not shared by replicas. This store keeps the count in the budget's own file,
// which every process on the host opens, for every rail. append() holds the payment through the
// ledger's admission, inside one write transaction, so two processes that both pass the SDK's
// own in-memory check cannot both record a payment past the cap.
import { ledgerOf } from '../core/_ledgers.js';
import type { Budget, Hold } from '../core/budget.js';
import { BudgetRefused, forAgent, UsageError } from '../core/errors.js';
import { OPEN } from '../core/ledger.js';
import { checkKeys, MAX_AMOUNT } from '../core/money.js';
import { MAX_PAYMENT_TIMEOUT_SECONDS } from './_x402.js';

// The CDP store is its own rail. The x402 guard also writes rail 'x402', and a shared rail let a
// guard row reach the CDP loader with the wrong reference shape.
const RAIL = 'cdp';
const OPTION_KEYS = new Set(['asset', 'scale']);

// How long after CDP records a payment it can still settle. CDP records a payment just before
// it signs it, and its applySpendControls refuses a requirement whose maxTimeoutSeconds is over
// 3600 (MAX_PAYMENT_TIMEOUT_SECONDS in @coinbase/cdp-sdk 1.60.0 and 1.61.0), so the signed
// authorization can be redeemed for up to an hour. 60 seconds more covers the time between the
// record and the signature. The payment is held that long from the ledger's own time, and counts
// until one window after.
const SETTLES_WITHIN_MS = BigInt(MAX_PAYMENT_TIMEOUT_SECONDS) * 1000n + 60_000n;

/** A payment as CDP's SpendStore interface carries it: @coinbase/cdp-sdk/x402's SpendLedgerEntry. */
export interface SpendLedgerEntry {
  atomicAmount: bigint;
  asset: string;
  /** CAIP-2, like 'eip155:8453'. */
  network: `${string}:${string}`;
  payTo: string;
  at: number;
}

/** What append() and removeEntry() take: a SpendLedgerEntry, or one whose amount is a decimal string or a number. */
export interface SpendLedgerEntryInput extends Omit<SpendLedgerEntry, 'atomicAmount' | 'network'> {
  atomicAmount: bigint | string | number;
  network: string;
}

// CDP compares assets after this normalization (EVM addresses lowercased).
const normalizeAsset = (asset: unknown): string => {
  const trimmed = String(asset).trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
};

const parseInfo = (text: string | null): Record<string, unknown> | null => {
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const fingerprint = (entry: SpendLedgerEntryInput): string =>
  JSON.stringify({
    atomicAmount: String(entry.atomicAmount),
    asset: entry.asset,
    network: entry.network,
    payTo: entry.payTo,
    at: Number(entry.at),
  });

const CAIP2 = /^[^:]+:.+$/;

const ceilDiv = (numerator: bigint, denominator: bigint): bigint => (numerator + denominator - 1n) / denominator;

/** CDP's SpendStore interface, which @coinbase/cdp-sdk/x402's applySpendControls takes as `store`. */
export interface SpendStore {
  size(): Promise<number>;
  load(): Promise<SpendLedgerEntry[]>;
  append(entry: SpendLedgerEntryInput): Promise<void>;
  prune(olderThanMs?: number): Promise<void>;
  removeEntry(entry: SpendLedgerEntryInput): Promise<void>;
  /** Nothing to close: the store counts in the budget's own file, which budget.close() closes. */
  close(): void;
}

/**
 * A CDP SpendStore that counts in `budget`, for a USD stablecoin `asset` with 6 decimals (or
 * `scale` budget units per atomic unit). Pass it as `store` to applySpendControls, and set
 * maxCumulativeSpend there too: the SDK only records through its store when a cumulative cap is
 * configured. A payment CDP rolls back keeps counting as long as it would have settled.
 */
export function cdpStore(budget: Budget, options: { asset: string; scale?: bigint | number }): SpendStore {
  checkKeys(options, OPTION_KEYS, 'cdpStore');
  const ledger = ledgerOf(budget);
  const { asset: given, scale: givenScale = 1n } = options;
  if (typeof given !== 'string' || given.trim().length === 0) throw new UsageError('asset is required');
  if (!(typeof givenScale === 'bigint' || Number.isSafeInteger(givenScale)) || BigInt(givenScale) <= 0n)
    throw new UsageError('scale must be a positive integer');
  const asset = normalizeAsset(given);
  const scale = BigInt(givenScale);
  const wallet = budget.wallet;
  // The payments this store appended, by CDP's entry, so removeEntry() can find one.
  const appended = new Map<string, Hold[]>();

  return {
    async size() {
      return (await ledger.counting(wallet)).length;
    },

    async load() {
      const rows = await ledger.counting(wallet);
      return rows.map((row): SpendLedgerEntry => {
        // Dated to the moment its window counts from, so CDP's own window check keeps it as long
        // as walletcap does: now, for a payment that counts until evidence ends it.
        const countsFrom = row.counts_from ?? row.now;
        const at = Number(countsFrom === OPEN || countsFrom > row.now ? row.now : countsFrom);
        const own = parseInfo(row.info);
        const network = own?.network;
        if (own?.atomicAmount !== undefined && normalizeAsset(own.asset) === asset && typeof network === 'string' && CAIP2.test(network)) {
          try {
            return { atomicAmount: BigInt(own.atomicAmount as string), asset, network: network as `${string}:${string}`, payTo: String(own.payTo), at };
          } catch {
            /* not a CDP entry after all */
          }
        }
        // Spend from another rail (or another asset) counts in this asset's units, rounded up.
        return { atomicAmount: ceilDiv(row.amount, scale), asset, network: `ledger:${row.rail}`, payTo: `ledger:${row.payment}`, at };
      });
    },

    async append(entry) {
      const paid = normalizeAsset(entry.asset);
      if (paid !== asset) throw new BudgetRefused('asset', `this CDP store counts ${asset}, not ${paid}`);
      let atomic: bigint;
      try {
        atomic = BigInt(entry.atomicAmount);
      } catch {
        throw new BudgetRefused('terms', 'atomicAmount must be an integer');
      }
      if (atomic < 0n) throw new BudgetRefused('terms', 'atomicAmount must be an integer');
      if (atomic === 0n) return;
      const spend = atomic * scale;
      if (spend > MAX_AMOUNT) throw new BudgetRefused('terms', 'payment does not fit in the budget unit');
      // CDP records a payment when it creates it and removes it if settlement fails, so it is held
      // at once, from the ledger's own time, until the signed authorization can no longer be
      // redeemed. The entry's own `at` is CDP's, kept only with the payment.
      // Held through the budget, so the paying process's own limits bind it too.
      const key = fingerprint(entry);
      let held: Hold;
      try {
        held = await budget.hold(spend, { rail: RAIL, details: JSON.parse(key) as Record<string, unknown>, settlesWithin: SETTLES_WITHIN_MS });
      } catch (error) {
        throw forAgent(error); // CDP passes it on to the agent: no hold ids, no void instructions
      }
      appended.set(key, [...(appended.get(key) ?? []), held]);
    },

    async prune() {
      // The ledger keeps every payment; one that no longer counts is never read.
    },

    async removeEntry(entry) {
      // CDP removes a payment from its store in cases the store can't tell apart, and a signed
      // authorization may still be out there. So the payment keeps counting for as long as it
      // would have settled, noted refused. Someone who has checked the chain can void it sooner.
      const key = fingerprint(entry);
      const [held, ...rest] = appended.get(key) ?? [];
      if (held === undefined) return;
      if (rest.length === 0) appended.delete(key);
      else appended.set(key, rest);
      await held.note('refused', 'removed by CDP');
    },

    close() {},
  };
}
