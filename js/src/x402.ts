// SPDX-License-Identifier: Apache-2.0
// Put a budget in front of any x402 v2 client from @x402/core, through the client's public
// payment hooks. It works under @x402/fetch, @x402/axios and Coinbase's CDP spend controls
// alike: whatever else is configured, every payment the client creates is counted in the shared
// budget before it is sent.
import { BudgetError, BudgetRefused, forAgent, PaymentNotRecorded } from './errors.js';
import type { Budget, Reservation } from './index.js';

/** The terms an x402 payee offers: one entry of a 402 answer's `accepts`. */
export interface PaymentRequirements {
  scheme?: string;
  network: string;
  asset: string;
  amount?: string | number | bigint;
  maxAmountRequired?: string | number | bigint;
  payTo?: string;
  maxTimeoutSeconds?: unknown;
  extra?: unknown;
  [key: string]: unknown;
}

/** What @x402/core hands its hooks: the fields the guard reads. */
export interface PaymentContext {
  selectedRequirements: PaymentRequirements;
  paymentPayload?: unknown;
  paymentRequired?: { resource?: { url?: unknown } } & Record<string, unknown>;
  settleResponse?: { success?: boolean; transaction?: string } & Record<string, unknown>;
  [key: string | symbol]: unknown;
}

/** An x402 client from @x402/core 2.x: the hooks the guard registers. */
export interface X402HookedClient {
  onBeforePaymentCreation(hook: (context: any) => Promise<unknown>): unknown;
  onAfterPaymentCreation(hook: (context: any) => Promise<unknown>): unknown;
  onPaymentCreationFailure(hook: (context: any) => Promise<unknown>): unknown;
  onPaymentResponse(hook: (context: any) => Promise<unknown>): unknown;
  registerPolicy?(policy: (version: number, requirements: any[]) => any[]): unknown;
}

/**
 * A USD-pegged stablecoin the budget counts at $1 a token. List only USD-pegged stablecoins:
 * nothing else is priced. An entry can add an asset but can't change a built-in one's decimals.
 */
export interface AssetEntry {
  /** CAIP-2, like 'eip155:8453'. */
  network: string;
  asset: string;
  /** An integer from 0 to 18. */
  decimals: number;
}

const GUARDED = Symbol.for('walletcap/x402-guard');
// Set by @coinbase/cdp-sdk/x402's applySpendControls. The CDP store and this guard both count
// one payment, so a client may have one counter, not both.
const CDP_APPLIED = '@coinbase/cdp-sdk/x402/spend-controls/applied';
const hasCdpControls = (client: object): boolean => Object.getOwnPropertySymbols(client)
  .some(symbol => symbol.description === CDP_APPLIED);
const oneCounter = (): BudgetError => new BudgetError(
  'this x402 client already has Coinbase CDP spend controls; the CDP store and the budget guard both count the payment. Use one: budget.guard(client), or applySpendControls with budget.cdpStore(), not both.',
);
const SLOT = Symbol('walletcap/x402-payment');
const FINGERPRINTS_KEPT = 10_000;

/**
 * The longest validity, in seconds, the guard lets a payee ask for: an hour, the ceiling
 * Coinbase's CDP spend controls enforce too (MAX_PAYMENT_TIMEOUT_SECONDS in @coinbase/cdp-sdk).
 * x402's clients sign an authorization that can be redeemed until maxTimeoutSeconds after
 * signing, so a payee asking for days could hold authorizations and redeem them all later. Terms
 * asking for more are passed over for shorter ones on offer, or refused before anything is signed.
 */
export const MAX_PAYMENT_TIMEOUT_SECONDS = 3600;

/** A refusal for terms whose validity walletcap can't bound to an hour or less, or null. */
export const timeoutRefusal = (requirements: PaymentRequirements | undefined): BudgetRefused | null => {
  const seconds = requirements?.maxTimeoutSeconds;
  if (typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0 && seconds <= MAX_PAYMENT_TIMEOUT_SECONDS) return null;
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0) {
    return new BudgetRefused('timeout', `the payee's terms give no whole number of seconds for how long the payment can be redeemed `
      + `(maxTimeoutSeconds: ${JSON.stringify(seconds) ?? 'none'}), so walletcap can't tell when it stops counting`);
  }
  return new BudgetRefused('timeout', `the payee asks for an authorization it could redeem for ${seconds} seconds; `
    + `walletcap signs for at most ${MAX_PAYMENT_TIMEOUT_SECONDS} seconds (an hour), as Coinbase's CDP spend controls do`);
};

// A Solana payment is a signed transaction, which the chain takes until its blockhash is 150
// blocks old, about a minute, however short maxTimeoutSeconds is.
const SOLANA_TRANSACTION_SECONDS = 120;

// x402 v1 names its networks; v2 uses CAIP-2.
const V1_NETWORKS: Readonly<Record<string, string>> = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  polygon: 'eip155:137',
  avalanche: 'eip155:43114',
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
};

/**
 * How long after it is signed a payment on these terms can settle, in seconds, or null if the
 * terms fail timeoutRefusal. Every scheme x402's clients sign expires maxTimeoutSeconds after
 * signing: EIP-3009's validBefore, the Permit2 deadline, the escrow's pre-approval expiry, a
 * batch deposit's validBefore. A Solana transaction lasts at least as long as its blockhash.
 */
export const settlesWithinSeconds = (requirements: PaymentRequirements): number | null => {
  if (timeoutRefusal(requirements) !== null) return null;
  const { network, maxTimeoutSeconds } = requirements;
  const seconds = maxTimeoutSeconds as number;
  const caip2 = Object.hasOwn(V1_NETWORKS, network) ? V1_NETWORKS[network] ?? network : String(network);
  return caip2.startsWith('solana:') ? Math.max(seconds, SOLANA_TRANSACTION_SECONDS) : seconds;
};

/**
 * USD stablecoins the budget counts at face value, by CAIP-2 network. The EVM entries are from
 * x402 2.28.0's own DEFAULT_ASSETS, plus Circle's native USDC on Optimism and Solana. Add other
 * USD-pegged stablecoins with guard(client, { assets }); their decimals can't be changed.
 */
export const USD_ASSETS: readonly Readonly<AssetEntry>[] = Object.freeze([
  { network: 'eip155:1', asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  { network: 'eip155:10', asset: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
  { network: 'eip155:137', asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
  { network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 },
  { network: 'eip155:42161', asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  { network: 'eip155:421614', asset: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', decimals: 6 },
  { network: 'eip155:43114', asset: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
  { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  { network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6 },
].map(entry => Object.freeze(entry)));

export const assetKey = (network: string, asset: string): string => {
  const caip2 = V1_NETWORKS[network] ?? network;
  const id = /^0x[0-9a-fA-F]{40}$/.test(asset) ? asset.toLowerCase() : asset;
  return `${caip2} ${id}`;
};

const BUILT_IN = new Map(USD_ASSETS.map(({ network, asset, decimals }) => [assetKey(network, asset), decimals]));

/**
 * The assets a guard prices: the built-in table plus `extra`. Each extra entry must be a
 * USD-pegged stablecoin, counted at $1 a token, with integer decimals from 0 to 18. It can add an
 * asset, but can't change a built-in one's decimals.
 */
export function assetTable(extra: unknown): Map<string, number> {
  if (!Array.isArray(extra)) throw new BudgetError('assets must be a list of { network, asset, decimals }');
  const table = new Map(BUILT_IN);
  for (const entry of extra as unknown[]) {
    const { network, asset, decimals } = (entry ?? {}) as Partial<AssetEntry>;
    if (typeof network !== 'string' || typeof asset !== 'string' || !Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 18) {
      throw new BudgetError('each asset is { network, asset, decimals }: a USD-pegged stablecoin, counted at $1 a token, with decimals from 0 to 18');
    }
    const key = assetKey(network, asset);
    const builtIn = BUILT_IN.get(key);
    if (builtIn !== undefined && builtIn !== decimals) {
      throw new BudgetError(`${asset} on ${network} is already priced with ${builtIn} decimals; an asset override can't change them`);
    }
    table.set(key, decimals as number);
  }
  return table;
}

export const atomicOf = (requirements: PaymentRequirements): bigint => {
  const raw = requirements.amount ?? requirements.maxAmountRequired;
  let atomic: bigint;
  try { atomic = BigInt(raw as string); } catch { throw new BudgetError(`the x402 amount ${JSON.stringify(raw)} is not an integer`); }
  if (atomic < 0n) throw new BudgetError('the x402 amount is negative');
  return atomic;
};

// Atomic units of a token with `decimals` as micro-dollars, rounded up: a budget may
// over-count, never under-count.
export const toMicros = (atomic: bigint, decimals: number): bigint => {
  if (decimals === 6) return atomic;
  if (decimals < 6) return atomic * 10n ** BigInt(6 - decimals);
  const divisor = 10n ** BigInt(decimals - 6);
  return (atomic + divisor - 1n) / divisor;
};

// A Unix time in seconds as milliseconds, or null if it isn't a positive whole number.
const unixMs = (value: unknown): bigint | null => {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null;
  try {
    const seconds = BigInt(value);
    return seconds > 0n ? seconds * 1000n : null;
  } catch {
    return null;
  }
};

interface SignedPayload {
  payload?: {
    authorization?: { validBefore?: unknown; from?: unknown; nonce?: unknown };
    permit2Authorization?: { deadline?: unknown; from?: unknown; nonce?: unknown };
  };
  accepted?: PaymentRequirements;
}

// When a payment just signed can no longer settle: the expiry it carries, an EIP-3009
// authorization's validBefore or a Permit2 deadline (x402's exact and upto schemes, and the
// escrow's), or else its terms' validity from now, the ledger's own time, which is after it was
// signed (settlesWithinSeconds).
const settlesBy = (payload: SignedPayload | undefined, requirements: PaymentRequirements): { settlesBy?: bigint; settlesWithinMs?: bigint } => {
  const signed = payload?.payload;
  const expiries = [unixMs(signed?.authorization?.validBefore), unixMs(signed?.permit2Authorization?.deadline)].filter((ms): ms is bigint => ms !== null);
  if (expiries.length > 0) return { settlesBy: expiries.reduce((latest, ms) => (ms > latest ? ms : latest)) };
  const within = settlesWithinSeconds(payload?.accepted ?? requirements);
  return within === null ? {} : { settlesWithinMs: BigInt(within) * 1000n };
};

// The payment's identity on its rail, when the signed payload carries one: an EIP-3009
// authorization is (from, nonce), and so is a Permit2 transfer.
const HEX = /^0x[0-9a-fA-F]+$/;
const identityOf = (payload: SignedPayload | undefined): string | undefined => {
  const signed = payload?.payload;
  const eip3009 = signed?.authorization;
  if (typeof eip3009?.from === 'string' && HEX.test(eip3009.from) && typeof eip3009.nonce === 'string' && HEX.test(eip3009.nonce)) {
    return `eip3009:${eip3009.from.toLowerCase()}:${eip3009.nonce.toLowerCase()}`;
  }
  const permit2 = signed?.permit2Authorization;
  const nonce = permit2?.nonce;
  if (typeof permit2?.from === 'string' && HEX.test(permit2.from) && (typeof nonce === 'string' || typeof nonce === 'number' || typeof nonce === 'bigint')
    && /^[0-9]+$/.test(String(nonce))) {
    return `permit2:${permit2.from.toLowerCase()}:${String(nonce)}`;
  }
  return undefined;
};

// Transports may clone a payload before handing it back (a JSON round trip, a spread); its
// signed content, which carries a nonce, still names one payment.
const fingerprint = (payload: unknown): string | null => {
  try {
    const signed = payload as SignedPayload | undefined;
    return JSON.stringify({ accepted: signed?.accepted, payload: signed?.payload });
  } catch {
    return null;
  }
};

interface Slot {
  amount: bigint;
  reservation: Reservation | null;
  payload: unknown;
}

/**
 * Count every payment `client` makes in `budget`. A payment is checked before it is signed,
 * reserved once its payload exists (after every other hook has passed), and stops counting only
 * when the server confirms settlement (it then counts for one window) or when it can no longer
 * settle.
 */
export function guardX402Client<C extends X402HookedClient>(client: C, budget: Budget, { assets = [] }: { assets?: AssetEntry[] } = {}): C {
  for (const hook of ['onBeforePaymentCreation', 'onAfterPaymentCreation', 'onPaymentCreationFailure', 'onPaymentResponse'] as const) {
    if (typeof (client as Partial<X402HookedClient> | undefined)?.[hook] !== 'function') {
      throw new BudgetError(`guard() takes an x402Client from @x402/core 2.x; this client has no ${hook}()`);
    }
  }
  const marked = client as C & { [GUARDED]?: unknown };
  if (marked[GUARDED] !== undefined) throw new BudgetError('this x402 client already has a budget guard');
  if (hasCdpControls(client)) throw oneCounter();
  const table = assetTable(assets);
  const byPayload = new WeakMap<object, Reservation>();
  const byFingerprint = new Map<string, Reservation>();

  const priced = (requirements: PaymentRequirements): boolean => table.has(assetKey(requirements.network, requirements.asset));
  const price = (requirements: PaymentRequirements): bigint => {
    const decimals = table.get(assetKey(requirements.network, requirements.asset));
    if (decimals === undefined) {
      throw new BudgetRefused('asset', `the budget cannot price ${requirements.asset} on ${requirements.network}. `
        + `If it is a USD stablecoin, add it: budget.guard(client, { assets: [{ network: '${requirements.network}', asset: '${requirements.asset}', decimals: 6 }] })`);
    }
    return toMicros(atomicOf(requirements), decimals);
  };
  const remember = (payload: unknown, reservation: Reservation): void => {
    if (payload !== null && typeof payload === 'object') byPayload.set(payload, reservation);
    const print = fingerprint(payload);
    if (print === null) return;
    byFingerprint.set(print, reservation);
    if (byFingerprint.size > FINGERPRINTS_KEPT) {
      const oldest = byFingerprint.keys().next().value;
      if (oldest !== undefined) byFingerprint.delete(oldest);
    }
  };
  const recall = (payload: unknown): Reservation | undefined => {
    if (payload !== null && typeof payload === 'object' && byPayload.has(payload)) return byPayload.get(payload);
    const print = fingerprint(payload);
    return print === null ? undefined : byFingerprint.get(print);
  };
  const forget = (payload: unknown): void => {
    if (payload !== null && typeof payload === 'object') byPayload.delete(payload);
    const print = fingerprint(payload);
    if (print !== null) byFingerprint.delete(print);
  };

  // Pay only in assets the budget can count, on terms valid an hour or less, when the server
  // offers a choice: a payee that also offers longer terms is paid on the shorter ones.
  if (typeof client.registerPolicy === 'function') {
    client.registerPolicy((_version: number, requirements: PaymentRequirements[]) => {
      const kept = requirements.filter(requirement => priced(requirement) && timeoutRefusal(requirement) === null);
      if (kept.length === 0 && requirements.length > 0) {
        const countable = requirements.find(priced);
        if (countable === undefined) price(requirements[0] as PaymentRequirements); // throws the explanation
        throw timeoutRefusal(countable);
      }
      return kept;
    });
  }

  client.onBeforePaymentCreation(async (context: PaymentContext) => {
    if (hasCdpControls(client)) throw oneCounter();
    const amount = price(context.selectedRequirements);
    const slot: Slot = { amount, reservation: null, payload: null };
    context[SLOT] = slot;
    if (amount === 0n) return undefined;
    // An early refusal, before anything is signed. The reservation that binds comes after. The
    // agent is told why, not which holds its owner could release: that is for the owner's CLI.
    const check = await budget.check(amount);
    if (!check.ok) throw new BudgetRefused(check.reason ?? 'budget', check.brief ?? check.message ?? 'refused');
    // The policy above has already set aside longer terms; this holds for a client without one.
    const tooLong = timeoutRefusal(context.selectedRequirements);
    if (tooLong !== null) throw tooLong;
    return undefined;
  });

  client.onAfterPaymentCreation(async (context: PaymentContext) => {
    if (hasCdpControls(client)) throw oneCounter();
    const slot = context[SLOT] as Slot | undefined;
    if (slot === undefined || slot.amount === 0n) return;
    const requirements = context.selectedRequirements;
    // If another process spent the budget since the check, this throws; the client then
    // discards the signed payload and nothing is sent.
    const url = context.paymentRequired?.resource?.url;
    const payload = context.paymentPayload as SignedPayload | undefined;
    try {
      const id = identityOf(payload);
      slot.reservation = await budget.reserve(slot.amount, {
        rail: 'x402',
        ...(requirements.payTo === undefined ? {} : { to: requirements.payTo }),
        ...(typeof url === 'string' ? { note: url.slice(0, 1024) } : {}),
        details: { network: requirements.network, asset: requirements.asset, scheme: requirements.scheme },
        ...settlesBy(payload, requirements),
        ...(id === undefined ? {} : { id }),
      });
    } catch (error) {
      throw forAgent(error);
    }
    slot.payload = context.paymentPayload;
    remember(context.paymentPayload, slot.reservation);
  });

  client.onPaymentCreationFailure(async (context: PaymentContext) => {
    // A later hook threw after this guard reserved: the payload is never returned, so never sent.
    const slot = context[SLOT] as Slot | undefined;
    if (slot?.reservation?.open) {
      forget(slot.payload);
      await slot.reservation.release();
    }
    return undefined;
  });

  client.onPaymentResponse(async (context: PaymentContext) => {
    const reservation = recall(context.paymentPayload);
    if (reservation === undefined) return undefined;
    forget(context.paymentPayload);
    if (!reservation.open) return undefined;
    if (context.settleResponse?.success === true) {
      try {
        await reservation.commit({ tx: context.settleResponse.transaction });
      } catch (error) {
        // Settled but not recorded: the reservation stays open and keeps counting.
        throw new PaymentNotRecorded(reservation.id, { cause: error });
      }
    } else {
      // No settlement confirmed. The payee still holds the signed authorization and could settle
      // it until it expires, so the payment keeps counting until then, plus one window, as if it
      // settled at the last possible moment.
      const refused = context.settleResponse !== undefined || context.paymentRequired !== undefined;
      try {
        await reservation.annotate({ outcome: refused ? 'refused' : 'unknown' });
      } catch (error) {
        // Not recorded either way: the reservation stays open and keeps counting.
        throw new PaymentNotRecorded(reservation.id, { cause: error, settled: false });
      }
    }
    return undefined;
  });

  Object.defineProperty(client, GUARDED, { value: budget, enumerable: false });
  return client;
}

const GUARDED_PROVIDER = Symbol.for('walletcap/agentkit-guard');

/**
 * Count every payment a Coinbase AgentKit X402ActionProvider makes in `budget`. AgentKit builds a
 * fresh x402 client for each action through createX402Client(), which its types declare private,
 * so a TypeScript subclass cannot override it. This wraps that method on the instance: every
 * client the provider builds is guarded before it can sign. Returns the provider.
 */
export function guardX402ActionProvider<P extends object>(provider: P, budget: Budget, options: { assets?: AssetEntry[] } = {}): P {
  const target = provider as P & { createX402Client?: unknown; [GUARDED_PROVIDER]?: unknown };
  const create = target?.createX402Client;
  if (typeof create !== 'function') {
    throw new BudgetError("guardAgentKit() takes AgentKit's X402ActionProvider; this provider has no createX402Client(), so walletcap can't count its payments");
  }
  if (target[GUARDED_PROVIDER] !== undefined) throw new BudgetError('this provider already has a budget guard');
  assetTable(options.assets ?? []); // a bad asset list fails here, not at the first payment
  Object.defineProperty(provider, 'createX402Client', {
    value: async (walletProvider: unknown) => guardX402Client(await (create as (wallet: unknown) => Promise<X402HookedClient>).call(provider, walletProvider), budget, options),
  });
  Object.defineProperty(provider, GUARDED_PROVIDER, { value: budget });
  return provider;
}
