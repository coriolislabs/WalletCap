// SPDX-License-Identifier: Apache-2.0
// Dollars in, micro-dollars out: amounts, rolling windows, wallet names and the default budget
// file. A budget counts in micro-dollars, so one USDC base unit is one budget unit. The Python
// package parses and formats the same way, and spec/vectors/money.json holds the cases both test
// suites check.
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { keccak256Hex } from './_keccak.js';
import { UsageError } from './errors.js';

declare const microsBrand: unique symbol;
/**
 * An amount of money in micro-dollars: 1_000_000n is $1, and one USDC base unit is one. Every
 * amount walletcap returns has this type; pass one back and it is read as micro-dollars.
 */
export type Micros = bigint & { readonly [microsBrand]: true };

/** Dollars: a string ("$12.50", "12.50 USDC", "$1,000") read exactly, a number of dollars, or a bigint of micro-dollars. */
export type Dollars = string | number | bigint;

/** A rolling window: "24h", "7d", "30m", "day", or milliseconds. */
export type Window = string | number | bigint;

/** Internal: a bigint known to be micro-dollars. */
export const asMicros = (value: bigint): Micros => value as Micros;

export const MICROS = 1_000_000n;
/**
 * The most a budget, a limit or one payment can be, in the budget's own unit: 10^15, a billion
 * dollars in micro-dollars. Kept far below 2^63 so that no sum of payments can overflow
 * SQLite's 64-bit integers.
 */
export const MAX_AMOUNT: Micros = asMicros(10n ** 15n);
/** Times and counts only have to fit in SQLite's 64-bit integers. */
export const MAX_INTEGER = (1n << 63n) - 1n;
export const DOLLAR_UNITS: ReadonlySet<string> = new Set(['usd', 'usdc']);

// ASCII only, in both languages: no other digits or spaces, so "١٢" and "12\u0085" are refused.
const DOLLARS = /^\$?[ \t\n\v\f\r]*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]+))?[ \t\n\v\f\r]*(?:[Uu][Ss][Dd][Cc]?)?$/;
const DURATION = /^([0-9]+)[ \t\n\v\f\r]*(ms|s|m|h|d|w)$/;
const NUMBER = /^([0-9]+)(?:\.([0-9]*))?(?:e([+-]?[0-9]+))?$/;
const DURATION_MS: Readonly<Record<string, bigint>> = { ms: 1n, s: 1_000n, m: 60_000n, h: 3_600_000n, d: 86_400_000n, w: 604_800_000n };
const DURATION_WORDS: Readonly<Record<string, bigint>> = { hour: 3_600_000n, day: 86_400_000n, week: 604_800_000n };
const DAY_MS = 86_400_000n;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CAIP10_EVM = /^eip155:[0-9]+:(0x[0-9a-fA-F]{40})$/;
const CAIP10_SOLANA = /^solana:[1-9A-HJ-NP-Za-km-z]+:([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const IDENTIFIER = /^[A-Za-z0-9_.:@/-]{1,128}$/;

/** The rolling-limit shorthands, as windows in milliseconds. */
export const WINDOWS = { perHour: 3_600_000n, perDay: DAY_MS, perWeek: 604_800_000n } as const;

const ASCII_SPACE = new Set([' ', '\t', '\n', '\v', '\f', '\r']);

/**
 * `text` without leading or trailing ASCII whitespace; the Python package trims the same set.
 * A scan, not a regex: /\s+$/ takes quadratic time on a long run of spaces inside the text.
 */
export const trimAscii = (text: string): string => {
  let start = 0;
  let end = text.length;
  while (start < end && ASCII_SPACE.has(text.charAt(start))) start += 1;
  while (end > start && ASCII_SPACE.has(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
};

// A number of dollars as micro-dollars: the shortest decimal that reads back as the number
// (String() here, repr() in Python: the same digits), rounded half up to a micro-dollar.
const numberMicros = (value: number): bigint => {
  const match = NUMBER.exec(String(value));
  if (match === null) throw new UsageError(`${value} is not a number of dollars`);
  const [, whole = '0', fraction = '', exponent = '0'] = match;
  const coefficient = BigInt(whole + fraction);
  const shift = Number(exponent) - fraction.length + 6;
  if (shift >= 0) return coefficient * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  return coefficient / divisor + (2n * (coefficient % divisor) >= divisor ? 1n : 0n);
};

const tooLarge = (label: string): string => `${label} is more than ${formatUsd(MAX_AMOUNT)}, the most a budget can hold`;

/**
 * An amount of dollars as integer micro-dollars. Strings are exact ("$12.50", "12.50 USDC",
 * "$1,000"); numbers are dollars, read as the shortest decimal that gives the number back and
 * rounded half up to the micro-dollar; a bigint is already micro-dollars (1_000_000n is $1).
 */
export function toMicros(value: unknown, label = 'amount'): Micros {
  let micros: bigint;
  if (typeof value === 'bigint') {
    if (value < 0n) throw new UsageError(`${label} must be a nonnegative bigint of micro-dollars`);
    micros = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new UsageError(`${label} must be a nonnegative number of dollars`);
    micros = numberMicros(value);
  } else if (typeof value === 'string') {
    const match = DOLLARS.exec(trimAscii(value));
    if (match === null) throw new UsageError(`${label} must be dollars, like "$12.50", 12.5 or "12.50 USDC"; got ${JSON.stringify(value)}`);
    const [, whole = '0', fraction = ''] = match;
    if (/[^0]/.test(fraction.slice(6))) throw new UsageError(`${label} is finer than a millionth of a dollar: ${JSON.stringify(value)}`);
    micros = BigInt(whole.replaceAll(',', '')) * MICROS + BigInt(fraction.slice(0, 6).padEnd(6, '0'));
  } else {
    throw new UsageError(`${label} must be dollars, like "$12.50", 12.5 or "12.50 USDC"`);
  }
  if (micros > MAX_AMOUNT) throw new UsageError(tooLarge(label));
  return asMicros(micros);
}

/** "$1,234.50" for 1_234_500_000n micro-dollars; sub-cent amounts keep their digits. */
export function formatUsd(micros: bigint): string {
  const negative = micros < 0n;
  const magnitude = negative ? -micros : micros;
  let fraction = (magnitude % MICROS).toString().padStart(6, '0').replace(/0+$/, '');
  if (fraction.length < 2) fraction = fraction.padEnd(2, '0');
  const whole = (magnitude / MICROS).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${whole}.${fraction}`;
}

/** An amount in a budget's own unit: dollars for 'usd' and 'usdc', raw units otherwise. */
export const formatAmount = (amount: bigint, unit: string): string => (DOLLAR_UNITS.has(unit) ? formatUsd(amount) : `${amount} ${unit}`);

/** A rolling window as milliseconds: "24h", "7d", "30m", "day", or a number of milliseconds. */
export function toWindowMs(value: unknown, label = 'window'): bigint {
  let ms: bigint | undefined;
  if (typeof value === 'bigint') ms = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) ms = BigInt(value);
  else if (typeof value === 'string') {
    const text = trimAscii(value).toLowerCase();
    const match = DURATION.exec(text);
    if (match) ms = BigInt(match[1] ?? '0') * (DURATION_MS[match[2] ?? ''] ?? 0n);
    else ms = DURATION_WORDS[text];
  }
  if (ms === undefined || ms <= 0n || ms > MAX_INTEGER) {
    throw new UsageError(`${label} must be a duration like "24h", "7d" or "30m", or a positive number of milliseconds`);
  }
  return ms;
}

/** How long ago, roughly: "3d 4h", "4h 12m", "12m 5s" or "5s". */
export function formatAge(ms: bigint): string {
  const units: [string, bigint][] = [['d', 86_400_000n], ['h', 3_600_000n], ['m', 60_000n], ['s', 1_000n]];
  const parts: string[] = [];
  let left = ms < 0n ? 0n : ms;
  for (const [suffix, size] of units) {
    if (parts.length === 0 && left < size && suffix !== 's') continue;
    parts.push(`${left / size}${suffix}`);
    left %= size;
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

/** "24h" for a day (it rolls), then "7d", "30m", "90s" or "1500ms". */
export function formatWindow(ms: bigint): string {
  if (ms === DAY_MS) return '24h';
  for (const suffix of ['d', 'h', 'm', 's']) {
    const size = DURATION_MS[suffix] ?? 1n;
    if (ms % size === 0n) return `${ms / size}${suffix}`;
  }
  return `${ms}ms`;
}

// Whether a mixed-case EVM address has a valid EIP-55 checksum.
const checksumOk = (address: string): boolean => {
  const hex = address.slice(2);
  const digest = keccak256Hex(hex.toLowerCase());
  for (let i = 0; i < hex.length; i += 1) {
    const char = hex.charAt(i);
    if (/\d/.test(char)) continue;
    if ((parseInt(digest.charAt(i), 16) >= 8) !== (char === char.toUpperCase())) return false;
  }
  return true;
};

/**
 * The name a wallet's budget is kept under. An EVM address (bare or CAIP-10) is lowercased, so a
 * checksummed and a lowercase address, or the same address on two chains, share one budget
 * instead of splitting it. A mixed-case EVM address is checked against EIP-55 first. A Solana
 * CAIP-10 is reduced to its address, so it and the bare address share one budget.
 */
export function normalizeWallet(wallet: unknown): string {
  if (typeof wallet !== 'string' || trimAscii(wallet).length === 0) {
    throw new UsageError('wallet is required: the address or account the money leaves from');
  }
  let name = trimAscii(wallet);
  const caip = CAIP10_EVM.exec(name) ?? CAIP10_SOLANA.exec(name);
  if (caip?.[1] !== undefined) name = caip[1];
  if (EVM_ADDRESS.test(name)) {
    const hex = name.slice(2);
    if (hex !== hex.toLowerCase() && hex !== hex.toUpperCase() && !checksumOk(name)) {
      throw new UsageError(`wallet ${JSON.stringify(name)} has an invalid EIP-55 checksum; copy the address or use all lowercase`);
    }
    return name.toLowerCase();
  }
  // A mistyped address must not quietly open a second budget.
  if (/^0x/i.test(name)) throw new UsageError(`wallet ${JSON.stringify(name)} looks like an EVM address but is not 40 hex digits`);
  if (!IDENTIFIER.test(name)) {
    throw new UsageError('wallet must be an address or a plain name (letters, digits and _ . : @ / -, at most 128)');
  }
  return name;
}

/**
 * The canonical name for a budget a 0.2.x file holds under some other spelling:
 * normalizeWallet's rule without its checks. spec/upgrade.sql does the same in SQL; the CLI uses
 * this to list each wallet once.
 */
export function storedWalletName(name: string): string {
  const solana = CAIP10_SOLANA.exec(name);
  if (solana?.[1] !== undefined) return solana[1];
  const evm = CAIP10_EVM.exec(name);
  const address = evm?.[1] ?? name;
  return EVM_ADDRESS.test(address) ? address.toLowerCase() : name;
}

/** 0xd797…ca02 for an EVM address; anything else as it is. */
export const shortWallet = (wallet: string): string => (/^0x[0-9a-f]{40}$/.test(wallet) ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet);

export const expandHome = (path: string, home = homedir()): string => (path === '~' || path.startsWith('~/') ? join(home, path.slice(1)) : path);

/**
 * The budget file every process on this machine shares unless told otherwise: $WALLETCAP_PATH,
 * else the per-user state directory. The Python package computes the same path, so both
 * languages find one budget.
 */
export function defaultBudgetPath(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home: string = homedir()): string {
  const path = platform === 'win32' ? win32 : posix;
  const set = env.WALLETCAP_PATH;
  if (set) return set === '~' || set.startsWith('~/') ? path.join(home, set.slice(1)) : set;
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'walletcap', 'budget.sqlite');
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'walletcap', 'budget.sqlite');
  const state = env.XDG_STATE_HOME && posix.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : posix.join(home, '.local', 'state');
  return posix.join(state, 'walletcap', 'budget.sqlite');
}

/** Refuse an option `what` doesn't take, naming the one that was probably meant. */
export const checkKeys = (source: unknown, known: ReadonlySet<string>, what: string): void => {
  if (source === null || typeof source !== 'object') throw new UsageError(`${what} takes an options object`);
  for (const key of Object.keys(source)) {
    if (known.has(key)) continue;
    const plain = key.toLowerCase().replaceAll(/[-_]/g, '');
    const match = [...known].find(candidate => candidate.toLowerCase() === plain);
    throw new UsageError(`unknown option ${key}${match ? `; did you mean ${match}?` : ''}`);
  }
};

const positiveCount = (value: unknown, label: string): bigint => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'bigint' && value >= 0n && value <= MAX_INTEGER) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(trimAscii(value)) && BigInt(trimAscii(value)) <= MAX_INTEGER) return BigInt(trimAscii(value));
  throw new UsageError(`${label} must be a whole number of payments`);
};

/** Limits as a caller writes them: dollars, windows and counts. */
export interface LimitOptions {
  /** Most one payment may spend; null for no per-payment limit. */
  perPayment?: Dollars | null;
  /** One rolling limit: perHour, perDay, perWeek, or cap with window. */
  perHour?: Dollars;
  perDay?: Dollars;
  perWeek?: Dollars;
  cap?: Dollars;
  window?: Window;
  /** Most payments in one window; null for no limit. */
  maxPayments?: number | bigint | string | null;
}

/** Limits in budget units. A field left out has no opinion; null means no limit. */
export interface Limits {
  cap?: Micros;
  windowMs?: bigint;
  perPayment?: Micros | null;
  maxPayments?: bigint | null;
}

/**
 * The limits named in `source`, in budget units. A field left out has no opinion; `null` means
 * no limit (perPayment and maxPayments only). One rolling limit at most: perHour, perDay,
 * perWeek, or cap with window.
 */
export function parseLimits(source: LimitOptions): Limits {
  const limits: Limits = {};
  const shorthands = (Object.keys(WINDOWS) as (keyof typeof WINDOWS)[]).filter(key => source[key] !== undefined);
  const explicit = source.cap !== undefined || source.window !== undefined;
  if (shorthands.length + (explicit ? 1 : 0) > 1) {
    throw new UsageError('give one rolling limit: perHour, perDay, perWeek, or cap with window');
  }
  const [shorthand] = shorthands;
  if (shorthand !== undefined) {
    limits.cap = toMicros(source[shorthand], shorthand);
    limits.windowMs = WINDOWS[shorthand];
  } else if (explicit) {
    if (source.cap === undefined || source.window === undefined) {
      throw new UsageError('cap and window go together, like { cap: "$150", window: "24h" }');
    }
    limits.cap = toMicros(source.cap, 'cap');
    limits.windowMs = toWindowMs(source.window);
  }
  if (source.perPayment !== undefined) {
    limits.perPayment = source.perPayment === null ? null : toMicros(source.perPayment, 'perPayment');
    if (limits.perPayment === 0n) throw new UsageError('perPayment must be more than $0; to stop every payment, freeze the budget');
  }
  if (source.maxPayments !== undefined) {
    limits.maxPayments = source.maxPayments === null ? null : positiveCount(source.maxPayments, 'maxPayments');
  }
  return limits;
}

/**
 * "$150.00 per 24h, at most $50.00 a payment, 20 payments per 24h" for the fields that are set.
 * With `nulls`, a field set to null reads as "no limit".
 */
export function describeLimits(
  { cap, windowMs, perPayment, maxPayments }: { cap?: bigint | undefined; windowMs?: bigint | undefined; perPayment?: bigint | null | undefined; maxPayments?: bigint | null | undefined },
  { window = windowMs, nulls = false }: { window?: bigint | undefined; nulls?: boolean } = {},
): string {
  const parts: string[] = [];
  if (cap !== undefined && windowMs !== undefined) parts.push(`${formatUsd(cap)} per ${formatWindow(windowMs)}`);
  if (perPayment !== undefined && perPayment !== null) parts.push(`at most ${formatUsd(perPayment)} a payment`);
  else if (perPayment === null && nulls) parts.push('no limit per payment');
  const countWindow = windowMs ?? window;
  if (maxPayments !== undefined && maxPayments !== null && countWindow !== undefined) parts.push(`${maxPayments} payments per ${formatWindow(countWindow)}`);
  else if (maxPayments === null && nulls) parts.push('no limit on the number of payments');
  return parts.join(', ');
}

/** The CLI flags that would set these limits, for messages that tell an owner what to run. */
export function limitFlags({ cap, windowMs, perPayment, maxPayments }: Limits): string {
  const flags: string[] = [];
  const dollars = (micros: bigint): string => formatUsd(micros).slice(1).replaceAll(',', '').replace(/\.00$/, '');
  if (cap !== undefined && windowMs !== undefined) {
    const shorthand = Object.entries(WINDOWS).find(([, ms]) => ms === windowMs);
    if (shorthand) flags.push(`--${shorthand[0].replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} ${dollars(cap)}`);
    else flags.push(`--cap ${dollars(cap)} --window ${formatWindow(windowMs)}`);
  }
  if (perPayment !== undefined && perPayment !== null) flags.push(`--per-payment ${dollars(perPayment)}`);
  if (maxPayments !== undefined && maxPayments !== null) flags.push(`--max-payments ${maxPayments}`);
  return flags.join(' ');
}
