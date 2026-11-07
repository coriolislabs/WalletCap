// SPDX-License-Identifier: Apache-2.0
// Dollars in, micro-dollars out: amounts, rolling windows, wallet names and the
// default budget file. A budget counts in micro-dollars, so one USDC base unit
// is one budget unit. The Python package parses and formats the same way, and
// spec/vectors/money.json holds the cases both test suites check.
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { BudgetError } from './errors.mjs';
import { keccak256Hex } from './_keccak.mjs';

export const MICROS = 1_000_000n;
/**
 * The most a budget, a limit or one payment can be, in the budget's own unit:
 * 10^15, a billion dollars in micro-dollars. Kept far below 2^63 so that no sum
 * of payments can overflow SQLite's 64-bit integers.
 */
export const MAX_AMOUNT = 10n ** 15n;
/** Times and counts only have to fit in SQLite's 64-bit integers. */
export const MAX_INTEGER = (1n << 63n) - 1n;
export const DOLLAR_UNITS = new Set(['usd', 'usdc']);

// ASCII only, in both languages: no other digits or spaces, so "١٢" and "12\u0085" are refused.
const DOLLARS = /^\$?[ \t\n\v\f\r]*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]+))?[ \t\n\v\f\r]*(?:[Uu][Ss][Dd][Cc]?)?$/;
const DURATION = /^([0-9]+)[ \t\n\v\f\r]*(ms|s|m|h|d|w)$/;
const NUMBER = /^([0-9]+)(?:\.([0-9]*))?(?:e([+-]?[0-9]+))?$/;
const DURATION_MS = { ms: 1n, s: 1_000n, m: 60_000n, h: 3_600_000n, d: 86_400_000n, w: 604_800_000n };
const DURATION_WORDS = { hour: 3_600_000n, day: 86_400_000n, week: 604_800_000n };
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CAIP10_EVM = /^eip155:[0-9]+:(0x[0-9a-fA-F]{40})$/;
const CAIP10_SOLANA = /^solana:[1-9A-HJ-NP-Za-km-z]+:([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const IDENTIFIER = /^[A-Za-z0-9_.:@/-]{1,128}$/;

export const WINDOWS = { perHour: DURATION_WORDS.hour, perDay: DURATION_WORDS.day, perWeek: DURATION_WORDS.week };

const ASCII_SPACE = new Set([' ', '\t', '\n', '\v', '\f', '\r']);

/**
 * `text` without leading or trailing ASCII whitespace; the Python package trims the same set.
 * A scan, not a regex: /\s+$/ takes quadratic time on a long run of spaces inside the text.
 */
export const trimAscii = text => {
  let start = 0;
  let end = text.length;
  while (start < end && ASCII_SPACE.has(text[start])) start += 1;
  while (end > start && ASCII_SPACE.has(text[end - 1])) end -= 1;
  return text.slice(start, end);
};

// A number of dollars as micro-dollars: the shortest decimal that reads back as the number
// (String() here, repr() in Python: the same digits), rounded half up to a micro-dollar.
const numberMicros = value => {
  const [, whole, fraction = '', exponent = '0'] = NUMBER.exec(String(value));
  const coefficient = BigInt(whole + fraction);
  const shift = Number(exponent) - fraction.length + 6;
  if (shift >= 0) return coefficient * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  return coefficient / divisor + (2n * (coefficient % divisor) >= divisor ? 1n : 0n);
};

/**
 * An amount of dollars as integer micro-dollars. Strings are exact ("$12.50",
 * "12.50 USDC", "$1,000"); numbers are dollars, read as the shortest decimal
 * that gives the number back and rounded half up to the micro-dollar; a bigint
 * is already micro-dollars (1_000_000n is $1).
 */
export function toMicros(value, label = 'amount') {
  let micros;
  if (typeof value === 'bigint') {
    if (value < 0n) throw new BudgetError(`${label} must be a nonnegative bigint of micro-dollars`);
    micros = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new BudgetError(`${label} must be a nonnegative number of dollars`);
    micros = numberMicros(value);
  } else if (typeof value === 'string') {
    const match = DOLLARS.exec(trimAscii(value));
    if (match === null) throw new BudgetError(`${label} must be dollars, like "$12.50", 12.5 or "12.50 USDC"; got ${JSON.stringify(value)}`);
    const fraction = match[2] ?? '';
    if (/[^0]/.test(fraction.slice(6))) throw new BudgetError(`${label} is finer than a millionth of a dollar: ${JSON.stringify(value)}`);
    micros = BigInt(match[1].replaceAll(',', '')) * MICROS + BigInt(fraction.slice(0, 6).padEnd(6, '0'));
  } else {
    throw new BudgetError(`${label} must be dollars, like "$12.50", 12.5 or "12.50 USDC"`);
  }
  if (micros > MAX_AMOUNT) throw new BudgetError(tooLarge(label));
  return micros;
}

const tooLarge = label => `${label} is more than ${formatUsd(MAX_AMOUNT)}, the most a budget can hold`;

/** "$1,234.50" for 1_234_500_000n micro-dollars; sub-cent amounts keep their digits. */
export function formatUsd(micros) {
  const negative = micros < 0n;
  const magnitude = negative ? -micros : micros;
  let fraction = (magnitude % MICROS).toString().padStart(6, '0').replace(/0+$/, '');
  if (fraction.length < 2) fraction = fraction.padEnd(2, '0');
  const whole = (magnitude / MICROS).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${whole}.${fraction}`;
}

/** An amount in a budget's own unit: dollars for 'usd' and 'usdc', raw units otherwise. */
export const formatAmount = (amount, unit) => (DOLLAR_UNITS.has(unit) ? formatUsd(amount) : `${amount} ${unit}`);

/** A rolling window as milliseconds: "24h", "7d", "30m", "day", or a number of milliseconds. */
export function toWindowMs(value, label = 'window') {
  let ms;
  if (typeof value === 'bigint') ms = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) ms = BigInt(value);
  else if (typeof value === 'string') {
    const text = trimAscii(value).toLowerCase();
    const match = DURATION.exec(text);
    if (match) ms = BigInt(match[1]) * DURATION_MS[match[2]];
    else if (text in DURATION_WORDS) ms = DURATION_WORDS[text];
  }
  if (ms === undefined || ms <= 0n || ms > MAX_INTEGER) {
    throw new BudgetError(`${label} must be a duration like "24h", "7d" or "30m", or a positive number of milliseconds`);
  }
  return ms;
}

/** How long ago, roughly: "3d 4h", "4h 12m", "12m 5s" or "5s". */
export function formatAge(ms) {
  const units = [['d', 86_400_000n], ['h', 3_600_000n], ['m', 60_000n], ['s', 1_000n]];
  const parts = [];
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
export function formatWindow(ms) {
  if (ms === DURATION_MS.d) return '24h';
  for (const suffix of ['d', 'h', 'm', 's']) {
    if (ms % DURATION_MS[suffix] === 0n) return `${ms / DURATION_MS[suffix]}${suffix}`;
  }
  return `${ms}ms`;
}

/**
 * The name a wallet's budget is kept under. An EVM address (bare or CAIP-10)
 * is lowercased, so a checksummed and a lowercase address, or the same address
 * on two chains, share one budget instead of splitting it. A mixed-case EVM
 * address is checked against EIP-55 first. A Solana CAIP-10 is reduced to its
 * address, so it and the bare address share one budget.
 */
const checksumOk = address => {
  const hex = address.slice(2);
  const digest = keccak256Hex(hex.toLowerCase());
  for (let i = 0; i < hex.length; i += 1) {
    const char = hex[i];
    if (/\d/.test(char)) continue;
    if ((parseInt(digest[i], 16) >= 8) !== (char === char.toUpperCase())) return false;
  }
  return true;
};

export function normalizeWallet(wallet) {
  if (typeof wallet !== 'string' || trimAscii(wallet).length === 0) {
    throw new BudgetError('wallet is required: the address or account the money leaves from');
  }
  let name = trimAscii(wallet);
  let caip = CAIP10_EVM.exec(name);
  if (caip) name = caip[1];
  else {
    caip = CAIP10_SOLANA.exec(name);
    if (caip) name = caip[1];
  }
  if (EVM_ADDRESS.test(name)) {
    const hex = name.slice(2);
    if (hex !== hex.toLowerCase() && hex !== hex.toUpperCase() && !checksumOk(name)) {
      throw new BudgetError(`wallet ${JSON.stringify(name)} has an invalid EIP-55 checksum; copy the address or use all lowercase`);
    }
    return name.toLowerCase();
  }
  // A mistyped address must not quietly open a second budget.
  if (/^0x/i.test(name)) throw new BudgetError(`wallet ${JSON.stringify(name)} looks like an EVM address but is not 40 hex digits`);
  if (!IDENTIFIER.test(name)) {
    throw new BudgetError('wallet must be an address or a plain name (letters, digits and _ . : @ / -, at most 128)');
  }
  return name;
}

/**
 * The canonical name for a budget a 0.2.x file holds under some other spelling:
 * normalizeWallet's rule without its checks. A checksummed, uppercase or CAIP-10
 * EVM address becomes the lowercase address, even with a bad checksum, and a
 * Solana CAIP-10 becomes its address, so every spelling merges into one budget.
 */
export function storedWalletName(name) {
  const solana = CAIP10_SOLANA.exec(name);
  if (solana) return solana[1];
  const evm = CAIP10_EVM.exec(name);
  const address = evm ? evm[1] : name;
  return EVM_ADDRESS.test(address) ? address.toLowerCase() : name;
}

/** 0xd797…ca02 for an EVM address; anything else as it is. */
export const shortWallet = wallet => (/^0x[0-9a-f]{40}$/.test(wallet) ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet);

/**
 * The budget file every process on this machine shares unless told otherwise:
 * $WALLETCAP_PATH, else the per-user state directory. The Python
 * package computes the same path, so both languages find one budget.
 */
export function defaultBudgetPath(env = process.env, platform = process.platform, home = homedir()) {
  if (env.WALLETCAP_PATH) return expandHome(env.WALLETCAP_PATH, home);
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'walletcap', 'budget.sqlite');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'walletcap', 'budget.sqlite');
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, '.local', 'state');
  return join(state, 'walletcap', 'budget.sqlite');
}

export const expandHome = (path, home = homedir()) => (path === '~' || path.startsWith('~/') ? join(home, path.slice(1)) : path);

const positiveCount = (value, label) => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'bigint' && value >= 0n && value <= MAX_INTEGER) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(trimAscii(value)) && BigInt(trimAscii(value)) <= MAX_INTEGER) return BigInt(trimAscii(value));
  throw new BudgetError(`${label} must be a whole number of payments`);
};

/**
 * The limits named in `source`, in budget units. A field left out has no
 * opinion; `null` means no limit (perPayment and maxPayments only). One rolling
 * limit at most: perHour, perDay, perWeek, or cap with window.
 */
export function parseLimits(source) {
  const limits = {};
  const shorthands = Object.keys(WINDOWS).filter(key => source[key] !== undefined);
  const explicit = source.cap !== undefined || source.window !== undefined;
  if (shorthands.length + (explicit ? 1 : 0) > 1) {
    throw new BudgetError('give one rolling limit: perHour, perDay, perWeek, or cap with window');
  }
  if (shorthands.length === 1) {
    const [key] = shorthands;
    limits.cap = toMicros(source[key], key);
    limits.windowMs = WINDOWS[key];
  } else if (explicit) {
    if (source.cap === undefined || source.window === undefined) {
      throw new BudgetError('cap and window go together, like { cap: "$150", window: "24h" }');
    }
    limits.cap = toMicros(source.cap, 'cap');
    limits.windowMs = toWindowMs(source.window);
  }
  if (source.perPayment !== undefined) {
    limits.perPayment = source.perPayment === null ? null : toMicros(source.perPayment, 'perPayment');
    if (limits.perPayment === 0n) throw new BudgetError('perPayment must be more than $0; to stop every payment, freeze the budget');
  }
  if (source.maxPayments !== undefined) {
    limits.maxUses = source.maxPayments === null ? null : positiveCount(source.maxPayments, 'maxPayments');
  }
  return limits;
}

/**
 * "$150.00 per 24h, at most $50.00 a payment, 20 payments per 24h" for the
 * fields that are set. With `nulls`, a field set to null reads as "no limit".
 */
export function describeLimits({ cap, windowMs, perPayment, maxUses }, { window = windowMs, nulls = false } = {}) {
  const parts = [];
  if (cap !== undefined) parts.push(`${formatUsd(cap)} per ${formatWindow(windowMs)}`);
  if (perPayment !== undefined && perPayment !== null) parts.push(`at most ${formatUsd(perPayment)} a payment`);
  else if (perPayment === null && nulls) parts.push('no limit per payment');
  if (maxUses !== undefined && maxUses !== null) parts.push(`${maxUses} payments per ${formatWindow(windowMs ?? window)}`);
  else if (maxUses === null && nulls) parts.push('no limit on the number of payments');
  return parts.join(', ');
}

/** The CLI flags that would set these limits, for messages that tell an owner what to run. */
export function limitFlags({ cap, windowMs, perPayment, maxUses }) {
  const flags = [];
  const dollars = micros => formatUsd(micros).slice(1).replaceAll(',', '').replace(/\.00$/, '');
  if (cap !== undefined) {
    const shorthand = Object.entries(WINDOWS).find(([, ms]) => ms === windowMs);
    if (shorthand) flags.push(`--${shorthand[0].replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} ${dollars(cap)}`);
    else flags.push(`--cap ${dollars(cap)} --window ${formatWindow(windowMs)}`);
  }
  if (perPayment !== undefined && perPayment !== null) flags.push(`--per-payment ${dollars(perPayment)}`);
  if (maxUses !== undefined && maxUses !== null) flags.push(`--max-payments ${maxUses}`);
  return flags.join(' ');
}
