// SPDX-License-Identifier: Apache-2.0
// Internal to the adapters: x402's terms (pricing, validity, a payment's identity) and the guard
// that walletcap/x402 and walletcap/agentkit export. It puts a budget in front of any x402 v2
// client from @x402/core, through the client's public payment hooks, so it works under
// @x402/fetch, @x402/axios and Coinbase's CDP spend controls alike: whatever else is configured,
// every payment the client creates is counted in the shared budget before it is sent.
import { alreadyReported, ledgerTimeOf, reportRefusal, stampLedgerTime } from '../core/_decisions.js';
import type { Budget, Hold } from '../core/budget.js';
import { BudgetRefused, forAgent, PaymentNotRecorded, UsageError } from '../core/errors.js';

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
}

/** What @x402/core hands a hook before it signs: the fields the guard reads. */
export interface PaymentCreationContext {
  selectedRequirements: PaymentRequirements;
  paymentRequired?: unknown;
}

/** What @x402/core hands a hook once it has signed. */
export interface PaymentCreatedContext extends PaymentCreationContext {
  paymentPayload: unknown;
}

/** What @x402/core hands a hook when a later hook failed. */
export interface PaymentCreationFailureContext extends PaymentCreationContext {
  error?: unknown;
}

/** What @x402/core hands a hook once the paid request is answered, or failed. */
export interface PaymentResponseContext {
  paymentPayload: unknown;
  requirements?: PaymentRequirements;
  settleResponse?: { success?: boolean; transaction?: string };
  paymentRequired?: unknown;
  error?: unknown;
}

/**
 * An x402 client from @x402/core 2.x: the hooks the guard registers. @x402/core's own contexts
 * carry more than the ones above, so its x402Client is one as it is, and guard() returns its
 * type. The guard also uses the client's registerPolicy() when it has one.
 */
export interface X402HookedClient {
  onBeforePaymentCreation(hook: (context: PaymentCreationContext) => Promise<void>): unknown;
  onAfterPaymentCreation(hook: (context: PaymentCreatedContext) => Promise<void>): unknown;
  onPaymentCreationFailure(hook: (context: PaymentCreationFailureContext) => Promise<void>): unknown;
  onPaymentResponse(hook: (context: PaymentResponseContext) => Promise<void>): unknown;
}

type PaymentPolicy = (x402Version: number, paymentRequirements: PaymentRequirements[]) => PaymentRequirements[];

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

/**
 * The x402 schemes the guard counts by default: under each, the wallet signs for at most the
 * terms' amount, good for at most the terms' maxTimeoutSeconds. Another scheme is refused, with
 * the code `terms`, unless `schemes` lists it: under batch-settlement, say, the wallet signs a
 * deposit into a payment channel, several times the request's amount or whatever minimum the
 * payee announces.
 */
export const COUNTED_SCHEMES: readonly string[] = Object.freeze(['exact', 'upto', 'auth-capture']);

/** What guard() and guardAgentKit() take besides the client and the budget. */
export interface GuardOptions {
  /** More USD-pegged stablecoins to count at $1 a token. */
  assets?: AssetEntry[];
  /**
   * More x402 schemes to count, by name. List one only if a payment under it moves at most its
   * terms' amount out of the wallet, or walletcap reads what it moves from the signed payload: on
   * EVM it reads a batch-settlement deposit, and counts that.
   */
  schemes?: string[];
}

/** The schemes a guard counts: the built-in ones plus `extra`. */
export function schemeSet(extra: unknown): Set<string> {
  if (!Array.isArray(extra) || extra.some(name => typeof name !== 'string' || name.length === 0)) {
    throw new UsageError("schemes must be a list of x402 scheme names, like ['batch-settlement']");
  }
  return new Set([...COUNTED_SCHEMES, ...(extra as string[])]);
}

const GUARDED = Symbol.for('walletcap/x402-guard');
// Set by @coinbase/cdp-sdk/x402's applySpendControls. The CDP store and this guard both count
// one payment, so a client may have one counter, not both.
const CDP_APPLIED = '@coinbase/cdp-sdk/x402/spend-controls/applied';
const hasCdpControls = (client: object): boolean => Object.getOwnPropertySymbols(client).some(symbol => symbol.description === CDP_APPLIED);
const oneCounter = (): UsageError =>
  new UsageError(
    'this x402 client already has Coinbase CDP spend controls; the CDP store and the budget guard both count the payment. Use one: guard(client, budget), or applySpendControls with cdpStore(budget), not both.',
  );
// The guard's state for one payment, on the context @x402/core passes from hook to hook.
const SLOT = Symbol('walletcap/x402-payment');
type Slotted = { [SLOT]?: Slot };
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
    return new BudgetRefused(
      'timeout',
      `the payee's terms give no whole number of seconds for how long the payment can be redeemed ` +
        `(maxTimeoutSeconds: ${JSON.stringify(seconds) ?? 'none'}), so walletcap can't tell when it stops counting`,
    );
  }
  return new BudgetRefused(
    'timeout',
    `the payee asks for an authorization it could redeem for ${seconds} seconds; ` +
      `walletcap signs for at most ${MAX_PAYMENT_TIMEOUT_SECONDS} seconds (an hour), as Coinbase's CDP spend controls do`,
  );
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
  return caip2Of(network).startsWith('solana:') ? Math.max(seconds, SOLANA_TRANSACTION_SECONDS) : seconds;
};

/**
 * USD stablecoins the budget counts at face value, by CAIP-2 network. The EVM entries are from
 * x402 2.28.0's own DEFAULT_ASSETS, plus Circle's native USDC on Optimism and Solana. Add other
 * USD-pegged stablecoins with guard(client, budget, { assets }); their decimals can't be changed.
 */
export const USD_ASSETS: readonly Readonly<AssetEntry>[] = Object.freeze(
  [
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
  ].map(entry => Object.freeze(entry)),
);

// A network as CAIP-2: x402 v1's names are mapped, anything else is taken as it is.
const caip2Of = (network: unknown): string =>
  typeof network === 'string' && Object.hasOwn(V1_NETWORKS, network) ? (V1_NETWORKS[network] as string) : String(network);

// A payee's string as a message may repeat it: an address or a network id, never a sentence.
const named = (value: unknown): string => (typeof value === 'string' && /^[A-Za-z0-9:_.-]{1,80}$/.test(value) ? value : 'one walletcap cannot read');

export const assetKey = (network: string, asset: string): string => {
  const caip2 = caip2Of(network);
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
  if (!Array.isArray(extra)) throw new UsageError('assets must be a list of { network, asset, decimals }');
  const table = new Map(BUILT_IN);
  for (const entry of extra as unknown[]) {
    const { network, asset, decimals } = (entry ?? {}) as Partial<AssetEntry>;
    if (typeof network !== 'string' || typeof asset !== 'string' || !Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 18) {
      throw new UsageError('each asset is { network, asset, decimals }: a USD-pegged stablecoin, counted at $1 a token, with decimals from 0 to 18');
    }
    const key = assetKey(network, asset);
    const builtIn = BUILT_IN.get(key);
    if (builtIn !== undefined && builtIn !== decimals) {
      throw new UsageError(`${asset} on ${network} is already priced with ${builtIn} decimals; an asset override can't change them`);
    }
    table.set(key, decimals as number);
  }
  return table;
}

// An amount as x402 writes one: a string of decimal digits. A whole number or a bigint is read
// too. Nothing else is: every parser a signer might use agrees on these, and on little besides
// ("0x10" is 16 to BigInt and 0 to parseInt(…, 10)).
const wholeAtomic = (raw: unknown): bigint | null => {
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) return BigInt(raw);
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw);
  if (typeof raw === 'bigint' && raw >= 0n) return raw;
  return null;
};

/**
 * The most a payment on these terms asks the wallet to sign for, in the asset's atomic units.
 * x402 v2 names it `amount` and v1 `maxAmountRequired`, and a client signs whichever its protocol
 * version reads, whatever else the payee put beside it. So terms that carry both are priced at
 * the larger: a payee can't have a small `amount` counted while a v1 scheme signs a large
 * `maxAmountRequired`.
 */
export const atomicOf = (requirements: PaymentRequirements): bigint => {
  let most: bigint | null = null;
  for (const field of ['amount', 'maxAmountRequired'] as const) {
    const raw: unknown = requirements[field];
    if (raw === undefined || raw === null) continue;
    const atomic = wholeAtomic(raw);
    if (atomic === null) throw new BudgetRefused('terms', `the x402 ${field} ${JSON.stringify(String(raw))} is not a whole number of the asset's units`);
    if (most === null || atomic > most) most = atomic;
  }
  if (most === null) throw new BudgetRefused('terms', 'the x402 terms name no amount');
  return most;
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
    authorization?: { validBefore?: unknown; from?: unknown; nonce?: unknown; value?: unknown };
    permit2Authorization?: { deadline?: unknown; from?: unknown; nonce?: unknown; permitted?: { amount?: unknown } };
    deposit?: { amount?: unknown };
  };
  accepted?: PaymentRequirements;
}

// What the signed payload itself moves out of the wallet, where walletcap can read it: an
// EIP-3009 authorization's value, a Permit2 transfer's amount, a batch-settlement channel's
// deposit (which is several times the request's amount, or whatever minimum the payee announces).
// The larger of them, or null when the payload names none walletcap reads.
const signedAtomic = (payload: SignedPayload | undefined): bigint | null => {
  const signed = payload?.payload;
  let most: bigint | null = null;
  for (const raw of [signed?.authorization?.value, signed?.permit2Authorization?.permitted?.amount, signed?.deposit?.amount]) {
    let atomic: bigint | null = null;
    try {
      // Read as loosely as a signer would: whatever this parses to is what was signed for.
      if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'bigint') atomic = BigInt(raw);
    } catch {
      atomic = null;
    }
    if (atomic !== null && (most === null || atomic > most)) most = atomic;
  }
  return most;
};

// When a payment just signed can no longer settle: the expiry it carries, an EIP-3009
// authorization's validBefore or a Permit2 deadline (x402's exact and upto schemes, and the
// escrow's), or else its terms' validity from now, the ledger's own time, which is after it was
// signed (settlesWithinSeconds).
const settlesBy = (payload: SignedPayload | undefined, requirements: PaymentRequirements): { settlesBy?: bigint; settlesWithin?: bigint } => {
  const signed = payload?.payload;
  const expiries = [unixMs(signed?.authorization?.validBefore), unixMs(signed?.permit2Authorization?.deadline)].filter((ms): ms is bigint => ms !== null);
  // biome-ignore lint/complexity/useMathMinMax: these are bigints, which Math.max refuses
  if (expiries.length > 0) return { settlesBy: expiries.reduce((latest, ms) => (ms > latest ? ms : latest)) };
  const within = settlesWithinSeconds(payload?.accepted ?? requirements);
  return within === null ? {} : { settlesWithin: BigInt(within) * 1000n };
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
  if (
    typeof permit2?.from === 'string' &&
    HEX.test(permit2.from) &&
    (typeof nonce === 'string' || typeof nonce === 'number' || typeof nonce === 'bigint') &&
    /^[0-9]+$/.test(String(nonce))
  ) {
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
  hold: Hold | null;
  payload: unknown;
}

/**
 * Count every payment `client` makes in `budget`. A payment is checked before it is signed,
 * held once its payload exists (after every other hook has passed), and stops counting only
 * when the server confirms settlement (it then counts for one window) or when it can no longer
 * settle.
 */
export function guard<C extends X402HookedClient>(client: C, budget: Budget, { assets = [], schemes = [] }: GuardOptions = {}): C {
  for (const hook of ['onBeforePaymentCreation', 'onAfterPaymentCreation', 'onPaymentCreationFailure', 'onPaymentResponse'] as const) {
    if (typeof (client as Partial<X402HookedClient> | undefined)?.[hook] !== 'function') {
      throw new UsageError(`guard() takes an x402Client from @x402/core 2.x; this client has no ${hook}()`);
    }
  }
  const marked = client as C & { [GUARDED]?: unknown };
  if (marked[GUARDED] !== undefined) throw new UsageError('this x402 client already has a budget guard');
  if (hasCdpControls(client)) throw oneCounter();
  const table = assetTable(assets);
  const counted = schemeSet(schemes);
  const byPayload = new WeakMap<object, Hold>();
  const byFingerprint = new Map<string, Hold>();

  const priced = (requirements: PaymentRequirements): boolean => table.has(assetKey(requirements.network, requirements.asset));
  const schemeRefusal = (requirements: PaymentRequirements): BudgetRefused | null => {
    const scheme = requirements.scheme ?? 'exact';
    if (typeof scheme === 'string' && counted.has(scheme)) {
      // A channel's deposit is read from an EVM payload. On another chain it is inside a signed
      // transaction walletcap doesn't decode, so the scheme can't be counted there, listed or not.
      if (scheme !== 'batch-settlement' || caip2Of(requirements.network).startsWith('eip155:')) return null;
      return new BudgetRefused(
        'terms',
        `the budget can't count a batch-settlement payment on ${named(requirements.network)}: it can't read the deposit the wallet signs there`,
      );
    }
    return new BudgetRefused(
      'terms',
      `the budget doesn't count the x402 scheme ${named(scheme)}: under it the wallet may sign for more than the terms' amount. ` +
        `If its payments move at most that amount, add it: guard(client, budget, { schemes: ['${named(scheme)}'] })`,
    );
  };
  const price = (requirements: PaymentRequirements): bigint => {
    const unknown = schemeRefusal(requirements);
    if (unknown !== null) throw unknown;
    const decimals = table.get(assetKey(requirements.network, requirements.asset));
    if (decimals === undefined) {
      throw new BudgetRefused(
        'asset',
        `the budget cannot price ${named(requirements.asset)} on ${named(requirements.network)}. ` +
          `If it is a USD stablecoin, add it: guard(client, budget, { assets: [{ network: '${named(requirements.network)}', asset: '${named(requirements.asset)}', decimals: 6 }] })`,
      );
    }
    return toMicros(atomicOf(requirements), decimals);
  };
  // What terms ask for, in micro-dollars, for the record of a refusal: null when the budget can't
  // price their asset or read their amount.
  const asked = (requirements: PaymentRequirements | null | undefined): bigint | null => {
    try {
      const decimals = requirements ? table.get(assetKey(requirements.network, requirements.asset)) : undefined;
      return decimals === undefined ? null : toMicros(atomicOf(requirements as PaymentRequirements), decimals);
    } catch {
      return null;
    }
  };
  // A refusal this guard is about to throw to the client, told to the budget's decision log first.
  // A refusal hold() made is passed over: hold() told the log itself (holdSigned).
  const refused = (error: unknown, requirements: PaymentRequirements | null | undefined, amount: bigint | null = asked(requirements)): unknown => {
    reportRefusal(budget, error, { rail: 'x402', amount, to: requirements?.payTo });
    return error;
  };
  const remember = (payload: unknown, hold: Hold): void => {
    if (payload !== null && typeof payload === 'object') byPayload.set(payload, hold);
    const print = fingerprint(payload);
    if (print === null) return;
    byFingerprint.set(print, hold);
    if (byFingerprint.size > FINGERPRINTS_KEPT) {
      const oldest = byFingerprint.keys().next().value;
      if (oldest !== undefined) byFingerprint.delete(oldest);
    }
  };
  const recall = (payload: unknown): Hold | undefined => {
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
  const registerPolicy = (client as { registerPolicy?: unknown }).registerPolicy;
  if (typeof registerPolicy === 'function') {
    (registerPolicy as (policy: PaymentPolicy) => unknown).call(client, (_version: number, requirements: PaymentRequirements[]) => {
      const countable = requirements.filter(requirement => schemeRefusal(requirement) === null && priced(requirement));
      const kept = countable.filter(requirement => timeoutRefusal(requirement) === null);
      if (kept.length === 0 && requirements.length > 0) {
        // Say why the first of the terms that came closest was passed over.
        const [close] = countable;
        const passedOver = close ?? requirements.find(requirement => schemeRefusal(requirement) === null) ?? (requirements[0] as PaymentRequirements);
        try {
          if (close !== undefined) throw timeoutRefusal(close);
          price(passedOver); // throws the explanation
        } catch (error) {
          throw refused(error, passedOver);
        }
      }
      return kept;
    });
  }

  client.onBeforePaymentCreation(async (context: PaymentCreationContext) => {
    if (hasCdpControls(client)) throw oneCounter();
    const requirements = context.selectedRequirements;
    let amount: bigint | undefined;
    try {
      amount = price(requirements);
      const slot: Slot = { amount, hold: null, payload: null };
      (context as Slotted)[SLOT] = slot;
      if (amount === 0n) return undefined;
      // An early refusal, before anything is signed. The hold that binds comes after. The
      // agent is told why, not which holds its owner could void: that is for the owner's CLI.
      const check = await budget.check(amount);
      if (!check.ok) {
        const refusal = new BudgetRefused(check.code ?? 'budget', check.brief ?? check.message ?? 'refused', { source: check.source ?? 'budget' });
        // The ledger refused, through check(): the refusal is dated as the ledger dated its answer.
        throw stampLedgerTime(refusal, ledgerTimeOf(check));
      }
      // The policy above has already set aside longer terms; this holds for a client without one.
      const tooLong = timeoutRefusal(requirements);
      if (tooLong !== null) throw tooLong;
      return undefined;
    } catch (error) {
      // check() logs nothing, so the refusals made here, before any hold, are reported here.
      throw refused(error, requirements, amount);
    }
  });

  // Every payload the guard has held, or priced as free: the ones the client may hand out.
  const seen = new WeakSet<object>();

  // Hold a signed payload, or throw: the one place a payment enters the budget. `slot.amount` is
  // what its terms were priced at before signing.
  const holdSigned = async (slot: Slot, requirements: PaymentRequirements, paymentPayload: unknown, url: unknown): Promise<void> => {
    const payload = paymentPayload as SignedPayload | undefined;
    // Count what the wallet signed, when that is more than its terms' amount: a deposit, or a
    // scheme that read another field than the one priced.
    const signed = signedAtomic(payload);
    if (signed !== null) {
      const moved = toMicros(signed, table.get(assetKey(requirements.network, requirements.asset)) ?? 6);
      if (moved > slot.amount) slot.amount = moved;
    }
    if (slot.amount > 0n) {
      // If another process spent the budget since the check, or the wallet signed for more than
      // the budget admits, this throws; the client then discards the signed payload and nothing
      // is sent.
      try {
        const id = identityOf(payload);
        slot.hold = await budget.hold(slot.amount, {
          rail: 'x402',
          ...(typeof requirements.payTo === 'string' ? { to: requirements.payTo.slice(0, 256) } : {}),
          ...(typeof url === 'string' ? { note: url.slice(0, 1024) } : {}),
          details: { network: named(requirements.network), asset: named(requirements.asset), scheme: named(requirements.scheme ?? 'exact') },
          ...settlesBy(payload, requirements),
          ...(id === undefined ? {} : { id }),
        });
      } catch (error) {
        // hold() told the decision log; the copy the agent is given says so too, since it shares
        // no identity with the refusal hold() threw.
        throw alreadyReported(forAgent(error));
      }
      slot.payload = paymentPayload;
      remember(paymentPayload, slot.hold);
    }
    if (paymentPayload !== null && typeof paymentPayload === 'object') seen.add(paymentPayload);
  };

  client.onAfterPaymentCreation(async (context: PaymentCreatedContext) => {
    if (hasCdpControls(client)) throw oneCounter();
    const requirements = context.selectedRequirements;
    // A client that hands this hook another context than the one the check ran on has no slot:
    // the payment is priced again here, never let through uncounted.
    let slot = (context as Slotted)[SLOT];
    try {
      if (slot === undefined) {
        slot = { amount: price(requirements), hold: null, payload: null };
        (context as Slotted)[SLOT] = slot;
      }
      const url = (context.paymentRequired as { resource?: { url?: unknown } } | undefined)?.resource?.url;
      await holdSigned(slot, requirements, context.paymentPayload, url);
    } catch (error) {
      throw refused(error, requirements, slot?.amount);
    }
  });

  // The backstop. @x402/core returns a payload that a scheme's own failure hook "recovered"
  // straight to the transport, past the hook above: @x402/svm's batch-settlement client signs a
  // second accept that way. So the client's createPaymentPayload is wrapped on the instance, and
  // a payload the guard hasn't seen is held here, on the terms it says it accepted, or is never
  // returned.
  const create = (client as { createPaymentPayload?: unknown }).createPaymentPayload;
  if (typeof create === 'function') {
    Object.defineProperty(client, 'createPaymentPayload', {
      configurable: true,
      writable: true,
      value: async function createGuarded(this: unknown, ...args: unknown[]): Promise<unknown> {
        const paymentPayload = await (create as (...args: unknown[]) => Promise<unknown>).apply(this, args);
        if (paymentPayload === null || typeof paymentPayload !== 'object' || seen.has(paymentPayload)) return paymentPayload;
        const accepted = (paymentPayload as SignedPayload).accepted;
        let amount: bigint | undefined;
        try {
          if (accepted === null || typeof accepted !== 'object') {
            throw new BudgetRefused('terms', "the x402 client made a payment outside the budget's check, and it names no terms the budget can price");
          }
          const tooLong = timeoutRefusal(accepted);
          if (tooLong !== null) throw tooLong;
          const url = (args[0] as { resource?: { url?: unknown } } | undefined)?.resource?.url;
          amount = price(accepted);
          await holdSigned({ amount, hold: null, payload: null }, accepted, paymentPayload, url);
        } catch (error) {
          throw refused(error, accepted, amount);
        }
        return paymentPayload;
      },
    });
  }

  client.onPaymentCreationFailure(async (context: PaymentCreationFailureContext) => {
    // A later hook threw after this guard held the payment: the payload is never returned, so
    // never sent. (A payload whose identity was already in the ledger was refused, not held.)
    const slot = (context as Slotted)[SLOT];
    if (slot?.hold?.state === 'held') {
      forget(slot.payload);
      await slot.hold.void({ evidence: 'not sent: a later x402 hook failed' });
    }
    return undefined;
  });

  client.onPaymentResponse(async (context: PaymentResponseContext) => {
    const hold = recall(context.paymentPayload);
    if (hold === undefined) return undefined;
    forget(context.paymentPayload);
    if (hold.state !== 'held') return undefined;
    if (context.settleResponse?.success === true) {
      // The payee's word. Kept as evidence only if it could be a transaction: an id of hex or
      // base58 digits, nothing a terminal would act on and nothing that fails the settle.
      const said: unknown = context.settleResponse.transaction;
      const tx = typeof said === 'string' && /^[A-Za-z0-9]{1,128}$/.test(said) ? said : undefined;
      try {
        await hold.settle({ tx });
      } catch (error) {
        // Settled but not recorded: the payment stays held and keeps counting.
        throw new PaymentNotRecorded(hold.id, { cause: error });
      }
    } else {
      // No settlement confirmed. The payee still holds the signed authorization and could settle
      // it until it expires, so the payment keeps counting until then, plus one window, as if it
      // settled at the last possible moment.
      const refused = context.settleResponse !== undefined || context.paymentRequired !== undefined;
      try {
        await hold.note(refused ? 'refused' : 'unknown');
      } catch (error) {
        // Not recorded either way: the payment stays held and keeps counting.
        throw new PaymentNotRecorded(hold.id, { cause: error, settled: false });
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
export function guardAgentKit<P extends object>(provider: P, budget: Budget, options: GuardOptions = {}): P {
  const target = provider as P & { createX402Client?: unknown; [GUARDED_PROVIDER]?: unknown };
  const create = target?.createX402Client;
  if (typeof create !== 'function') {
    throw new UsageError("guardAgentKit() takes AgentKit's X402ActionProvider; this provider has no createX402Client(), so walletcap can't count its payments");
  }
  if (target[GUARDED_PROVIDER] !== undefined) throw new UsageError('this provider already has a budget guard');
  assetTable(options.assets ?? []); // a bad asset list fails here, not at the first payment
  schemeSet(options.schemes ?? []);
  Object.defineProperty(provider, 'createX402Client', {
    value: async (walletProvider: unknown) =>
      guard(await (create as (wallet: unknown) => Promise<X402HookedClient>).call(provider, walletProvider), budget, options),
  });
  Object.defineProperty(provider, GUARDED_PROVIDER, { value: budget });
  return provider;
}
