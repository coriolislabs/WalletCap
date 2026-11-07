// SPDX-License-Identifier: Apache-2.0
// walletcap/agentic: the budget in front of Coinbase's Agentic Wallet, through the wallet's own
// request channel (awal's sendIpcRequest, or the payments-mcp server's tools).
//
// Every send and every x402 payment that goes through here is counted in the wallet's budget,
// whichever process or session on this host makes it. An x402 payment is priced before the
// wallet signs it, and the wallet is handed the terms walletcap priced and capped at that amount.
// Once the wallet answers, the payment counts until one window past the time its authorization
// expires, whatever the payee says; if the wallet never answers, until its owner voids it. A
// send counts for one window, or, if its outcome is unknown, until its owner voids it.
import type { Budget, Reservation } from '../core/budget.js';
import { BudgetError, BudgetRefused, forAgent, PaymentNotRecorded } from '../core/errors.js';
import { SETTLES_BY } from '../core/ledger.js';
import { formatUsd, trimAscii } from '../core/money.js';
import {
  type AssetEntry, assetKey, assetTable, atomicOf, type PaymentRequirements, settlesWithinSeconds, timeoutRefusal, toMicros as atomicToMicros,
} from './_x402.js';

/** The wallet's request channel: awal's sendIpcRequest(channel, data). */
export type WalletRequest = (channel: string, data: Record<string, unknown>) => Promise<unknown>;

/** The endpoint's 402 answer: the payment requirements it accepts, and any extensions. */
export interface PaymentRequired {
  accepts?: unknown;
  extensions?: unknown;
  [key: string]: unknown;
}

/** The wallet's chain names, as CAIP-2 networks. */
export const AWAL_CHAINS: Readonly<Record<string, string>> = Object.freeze({
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  polygon: 'eip155:137',
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
});

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
// Room for the wallet's clock, or the chain's, to run ahead of this one.
const CLOCK_SKEW_MS = 60_000n;


const messageOf = (error: unknown): string => String((error as Error | undefined)?.message ?? error);

// The payment settled; record it, or say it went through but couldn't be recorded (not a BudgetError).
const settled = async (reservation: Reservation, tx: string | undefined): Promise<void> => {
  try {
    await reservation.commit({ tx });
  } catch (error) {
    throw new PaymentNotRecorded(reservation.id, { cause: error });
  }
};

// Record what the wallet answered. If the ledger can't (a busy timeout, say), the payment still
// counts as in flight, and the caller gets PaymentNotRecorded, not a BudgetError it might retry on.
const recorded = async (reservation: Reservation, write: () => Promise<void>): Promise<void> => {
  try {
    await write();
  } catch (error) {
    throw new PaymentNotRecorded(reservation.id, { cause: error, settled: false });
  }
};

// The amount the wallet sends is the amount counted: a whole number of atomic units in ASCII
// digits, passed on to the wallet as walletcap read it ("0x10" or " 5" could read differently there).
const sendAmount = (value: unknown): bigint => {
  const text = typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)) ? String(value) : value;
  if (typeof text !== 'string' || !/^[0-9]+$/.test(text)) {
    throw new BudgetError(`the send amount ${String(value)} is not a whole number of atomic units`);
  }
  return BigInt(text);
};

const decodeHeader = (value: unknown): Record<string, unknown> | null => {
  try {
    return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const headerOf = (headers: unknown, name: string): unknown => {
  if (headers === null || typeof headers !== 'object') return undefined;
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name);
  return key === undefined ? undefined : (headers as Record<string, unknown>)[key];
};

/** The PAYMENT-RESPONSE a payee sent back with a wallet result, decoded, or null. */
const paymentResponseOf = (result: unknown): Record<string, unknown> | null => {
  const headers = (result as { headers?: unknown } | null | undefined)?.headers;
  const header = headerOf(headers, 'payment-response') ?? headerOf(headers, 'x-payment-response');
  return header === undefined ? null : decodeHeader(header);
};

export interface RequestData {
  baseURL?: string;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  queryParams?: Record<string, unknown>;
  paymentRequirements?: unknown;
  extensions?: unknown;
  maxAmountPerRequest?: number | string;
  preferredNetwork?: string;
  preferredScheme?: string;
  [key: string]: unknown;
}

const requestUrl = (data: RequestData): URL => {
  const url = new URL(data.path ?? '', data.baseURL);
  for (const [key, value] of Object.entries(data.queryParams ?? {})) url.searchParams.set(key, String(value));
  return url;
};

/**
 * Ask the endpoint what it charges: its 402 answer, with the payment requirements it accepts
 * (`accepts`) and any `extensions`, or null if it asks for none.
 */
export async function discoverRequirements(data: RequestData, { fetch: fetchImpl = globalThis.fetch }: { fetch?: typeof fetch } = {}): Promise<PaymentRequired | null> {
  const method = String(data.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { Accept: 'application/json', ...(data.headers ?? {}) };
  const init: RequestInit = { method, headers, redirect: 'follow' };
  if (data.body !== undefined && method !== 'GET') {
    init.body = typeof data.body === 'string' ? data.body : JSON.stringify(data.body);
    headers['Content-Type'] ??= 'application/json';
  }
  const response = await fetchImpl(requestUrl(data), init);
  if (response.status !== 402) return null;
  const header = response.headers.get('payment-required');
  const required = (header ? decodeHeader(header) : await response.json().catch(() => null)) as PaymentRequired | null;
  if (!Array.isArray(required?.accepts) || required.accepts.length === 0) {
    throw new BudgetError(`${requestUrl(data).origin} answered 402 without payment requirements walletcap can read`);
  }
  return required;
}

/** What guardAgenticWallet() returns: the budget, and the wallet's request channel with the budget on it. */
export interface GuardedWallet {
  budget: Budget;
  request: WalletRequest;
}

/**
 * Count every send and x402 payment made through `request(channel, data)`, the wallet's own
 * request channel, in `budget`. Returns a `request` with the same shape that applies the budget.
 * `discover(data)`, if given, stands in for walletcap's own 402 discovery (discoverRequirements):
 * it returns the 402 answer (`{ accepts, extensions }`) or just its list of payment requirements,
 * or null when the endpoint asks for no payment.
 */
export function guardAgenticWallet(budget: Budget, { request, assets = [], fetch: fetchImpl, discover }: {
  request?: WalletRequest; assets?: AssetEntry[]; fetch?: typeof fetch; discover?: (data: RequestData) => Promise<unknown>;
} = {}): GuardedWallet {
  if (typeof request !== 'function') throw new BudgetError('guardAgenticWallet needs request(channel, data): the wallet\'s request channel');
  const wallet = request;
  const table = assetTable(assets);
  const findRequirements = discover ?? ((data: RequestData) => discoverRequirements(data, fetchImpl === undefined ? {} : { fetch: fetchImpl }));
  const networkOf = (requirement: PaymentRequirements): string => assetKey(requirement.network, requirement.asset).split(' ')[0] ?? '';

  // Any failure may come after the payment left, so it stays in flight, marked unknown, and keeps
  // counting: an error never settles a payment, and nothing in an error's text gives the amount
  // back. Its owner voids it once the chain shows it never left.
  const failed = async (reservation: Reservation, error: unknown): Promise<void> => {
    if (!reservation.open) return;
    await recorded(reservation, () => reservation.annotate({ outcome: 'unknown', error: messageOf(error).slice(0, 200) }));
  };

  // Terms the wallet may be handed: in an asset walletcap can price, valid an hour or less
  // (timeoutRefusal), so walletcap can tell how much it pays and how long it can settle.
  const isTerm = (requirement: unknown): requirement is PaymentRequirements => requirement !== null && typeof requirement === 'object';
  const priced = (requirement: PaymentRequirements): boolean => table.has(assetKey(requirement.network, requirement.asset));
  const payable = (requirement: unknown): requirement is PaymentRequirements => isTerm(requirement) && priced(requirement) && timeoutRefusal(requirement) === null;

  // How long after the wallet signs its payment can settle, in milliseconds. The wallet may pay
  // any of the terms it is handed, whatever walletcap would pick, so the longest of them counts,
  // whatever the scheme (settlesWithinSeconds), plus a minute of clock skew.
  const settlesWithinMs = (requirements: PaymentRequirements[]): bigint =>
    BigInt(Math.max(...requirements.map(requirement => settlesWithinSeconds(requirement) ?? 0))) * 1000n + CLOCK_SKEW_MS;

  async function send(data: RequestData): Promise<unknown> {
    const asset = String(data.asset ?? 'USDC').toUpperCase();
    const chain = String(data.chain ?? 'base');
    const network = AWAL_CHAINS[chain];
    if (asset !== 'USDC' || network === undefined) {
      throw new BudgetRefused('asset', `walletcap counts USDC; it cannot price ${asset} on ${chain}, so it refuses this send`);
    }
    const atomic = sendAmount(data.amountAtomic);
    if (atomic <= 0n) throw new BudgetError('the send amount must be more than $0');
    const recipient = data.recipient;
    if (typeof recipient !== 'string' || recipient.length === 0) throw new BudgetError('the send needs a recipient');
    const reservation = await budget.reserve(atomic, {
      rail: 'awal', to: recipient, note: `send on ${chain}`, details: { network, asset },
    });
    let result: { error?: unknown; transactionHash?: unknown } | null;
    try {
      // Only the fields the wallet's send takes, as walletcap read them: nothing else reaches the wallet.
      result = await wallet('send-transaction', { recipient, amountAtomic: atomic.toString(), asset, chain }) as typeof result;
    } catch (error) {
      await failed(reservation, error);
      throw error;
    }
    // A transaction the wallet reports as failed may still be mined: it keeps counting.
    if (result?.error) await failed(reservation, new Error(String(result.error)));
    else await settled(reservation, typeof result?.transactionHash === 'string' && TX_HASH.test(result.transactionHash) ? result.transactionHash : undefined);
    return result;
  }

  async function x402(data: RequestData): Promise<unknown> {
    // The wallet is handed the terms walletcap checks, the caller's or the ones walletcap
    // discovers, less any it can't price or bound. Handed terms, awal skips its own 402 discovery
    // and signs only a term equal to one of them, maxTimeoutSeconds included, so the payee can't
    // show it others.
    const handed = Array.isArray(data.paymentRequirements) && data.paymentRequirements.length > 0;
    const found = handed ? null : await findRequirements(data);
    const required = (Array.isArray(found) ? { accepts: found } : found ?? null) as PaymentRequired | null;
    const url = requestUrl(data).href.slice(0, 1024);
    if (!handed && required !== null && (!Array.isArray(required.accepts) || required.accepts.length === 0)) {
      throw new BudgetError(`${requestUrl(data).origin} answered 402 without payment requirements walletcap can read`);
    }
    if (!handed && required === null) {
      // The endpoint asked for nothing. Let the request through with the wallet's smallest
      // possible payment cap, one atomic unit, counted, in case the payee asks for money after
      // all. Nothing was signed for value, so unless the payee confirms a payment the hold is
      // given back: a free endpoint that fails can't leave holds that use up maxPayments.
      const reservation = await budget.reserve(1n, { rail: 'awal-x402', note: url });
      let result: unknown;
      try {
        result = await wallet('make-x402-request', { ...data, maxAmountPerRequest: 1 });
      } catch (error) {
        await recorded(reservation, () => reservation.release());
        throw error;
      }
      const answer = paymentResponseOf(result);
      if (answer?.success === true && typeof answer.transaction === 'string' && TX_HASH.test(answer.transaction)) await settled(reservation, answer.transaction);
      else await recorded(reservation, () => reservation.release());
      return result;
    }
    const offered = (handed ? data.paymentRequirements : required?.accepts) as unknown[];
    const usable = offered.filter(payable);
    const preferred = data.preferredNetwork === undefined ? undefined : AWAL_CHAINS[data.preferredNetwork];
    const wanted = (requirement: PaymentRequirements): boolean => (preferred === undefined || networkOf(requirement) === preferred)
      && (data.preferredScheme === undefined || requirement.scheme === data.preferredScheme);
    const candidates = usable.filter(wanted);
    if (candidates.length === 0) {
      // Nothing left the wallet could pay: say why for the terms it would have picked from.
      const asked = offered.filter((requirement): requirement is PaymentRequirements => isTerm(requirement) && wanted(requirement));
      const countable = asked.find(priced);
      if (countable !== undefined) throw timeoutRefusal(countable);
      const first = asked[0] ?? offered.find(isTerm);
      throw new BudgetRefused('asset', `walletcap cannot price ${first?.asset} on ${first?.network}; it pays only in the USD stablecoins it knows`);
    }
    const extensions = required?.extensions;
    const terms = {
      paymentRequirements: usable,
      // The wallet uses the 402's extensions only when it discovers the terms itself.
      ...(!handed && data.extensions === undefined && extensions !== null && typeof extensions === 'object' && !Array.isArray(extensions) ? { extensions } : {}),
    };
    const settlesWithin = settlesWithinMs(usable);
    // The wallet picks the terms itself when it pays, so reserve the most any offer asks and cap
    // the wallet at exactly that: it refuses to sign for more.
    const choice = candidates.reduce((most, requirement) => (atomicOf(requirement) > atomicOf(most) ? requirement : most));
    const micros = atomicToMicros(atomicOf(choice), table.get(assetKey(choice.network, choice.asset)) ?? 6);
    if (data.maxAmountPerRequest !== undefined && micros > BigInt(data.maxAmountPerRequest)) {
      throw new BudgetRefused('per_payment', `the endpoint asks ${formatUsd(micros)}, more than the request's own maximum`);
    }
    // A payment counts until its owner releases it (npx walletcap release), or, once the wallet
    // has answered, until one window past the time it can no longer settle.
    const reservation = await budget.reserve(micros, {
      rail: 'awal-x402',
      ...(choice.payTo === undefined ? {} : { to: choice.payTo }),
      note: url,
      details: { network: choice.network, asset: choice.asset, scheme: choice.scheme, maxTimeoutSeconds: choice.maxTimeoutSeconds },
    });
    let result: { status?: unknown } | null;
    try {
      result = await wallet('make-x402-request', { ...data, ...terms, maxAmountPerRequest: Number(atomicOf(choice)) }) as typeof result;
    } catch (error) {
      // The wallet may not have answered yet, and may still sign: it counts until released.
      await failed(reservation, error);
      throw error;
    }
    // The wallet has answered, so it has signed if it ever will. The hold learns when that
    // authorization expires before anything else: a commit never shortens a hold, so the
    // payee's own word that the payment settled can't free the budget early.
    await recorded(reservation, () => reservation[SETTLES_BY]({ withinMs: settlesWithin }));
    const answer = paymentResponseOf(result);
    if (answer?.success === true && typeof answer.transaction === 'string' && TX_HASH.test(answer.transaction)) await settled(reservation, answer.transaction);
    else await recorded(reservation, () => reservation.annotate({ outcome: answer?.success === false || result?.status === 402 ? 'refused' : 'unknown' }));
    return result;
  }

  // The agent is told why a payment was refused, not which holds its owner could release: that
  // is for the owner's CLI (walletcap holds) and budget.check().
  const toAgent = async (pay: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await pay();
    } catch (error) {
      throw forAgent(error);
    }
  };

  return {
    budget,
    async request(channel, data) {
      if (channel === 'send-transaction') return toAgent(() => send((data ?? {}) as RequestData));
      if (channel === 'make-x402-request') return toAgent(() => x402((data ?? {}) as RequestData));
      return wallet(channel, data);
    },
  };
}

const AWAL_AMOUNT = /^\$?[ \t\n\v\f\r]*([0-9]+)(?:\.([0-9]+))?$/;

/**
 * awal's own amount rule for USDC, read exactly: "$0.05" and "0.05" are dollars, and a whole
 * number above 100 ("50000", "101.0") is atomic units. Anything else is refused: "100.5abc",
 * "1e3", "1,000", digits other than 0-9, and amounts finer than one atomic unit (0.000001).
 */
export function usdcAtomic(amount: unknown): string {
  const match = AWAL_AMOUNT.exec(trimAscii(String(amount)));
  if (match === null) {
    throw new BudgetError(`Invalid amount: ${amount}. Give USDC like 0.05 or $0.05, or a whole number of atomic units above 100.`);
  }
  const [, whole = '0', fraction = ''] = match;
  if (/[^0]/.test(fraction.slice(6))) throw new BudgetError(`Invalid amount: ${amount} is finer than one atomic unit of USDC (0.000001).`);
  const atomic = !/[^0]/.test(fraction) && BigInt(whole) > 100n
    ? BigInt(whole)
    : BigInt(whole) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, '0'));
  if (atomic === 0n) throw new BudgetError(`Invalid amount: ${amount}. Must be a positive number.`);
  return atomic.toString();
}
