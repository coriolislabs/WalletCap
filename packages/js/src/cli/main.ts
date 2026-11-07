#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// npx walletcap: see, set and freeze an agent's spend budget.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Status } from '../core/budget.js';
import { BudgetUnavailable, isWalletcapError } from '../core/errors.js';
import type { LimitOptions } from '../core/money.js';
import {
  defaultBudgetPath, describeLimits, expandHome, formatAge, formatUsd, formatWindow, normalizeWallet, shortWallet, storedWalletName, toWindowMs, trimAscii,
} from '../core/money.js';
import { openOwner, type Owner } from '../core/owner.js';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

const HELP = `walletcap ${version}: one spend budget per wallet, for every agent that pays from it.

Usage: npx walletcap <command> [options]

Commands
  status               Every budget in the file, or one wallet's in detail (the default)
  set                  Create a wallet's budget or change its limits; what was spent keeps counting
  freeze               Refuse every payment from the wallet, in every process, until unfreeze
  unfreeze             Allow payments again
  history              The newest payments first
  holds                The held payments that still count, and why: in flight, refused or unknown
  void <id> [--evidence <what shows it>]
                       A held payment you know never left the wallet: it stops counting
  void --all-unknown --older-than <24h|7d|30m>
                       Every payment of unknown or refused outcome older than that, once you know
                       none of them left the wallet. One the payee could still settle stays; an
                       x402 payment with no settle-by time stays until it is an hour and a minute
                       old; any other with none, a transfer say, only goes by id
  settle <id> [--tx <hash>] [--evidence <what shows it>]
                       A payment you know paid: it counts through one window from now
  awal <command>       Coinbase's Agentic Wallet CLI, with send and x402 pay counted in the budget.
                       For its MCP server, use the walletcap-mcp package: npx walletcap-mcp --wallet <address>

Options
  --wallet <address>   The wallet the money leaves from (optional when the file holds one budget)
  --path <file>        The budget file (default: $WALLETCAP_PATH, else ${defaultBudgetPath()})
  --per-day <dollars>  Rolling limit; or --per-hour, --per-week, or --cap <dollars> --window <24h|7d|30m>
  --per-payment <dollars|none>   Most one payment may spend
  --max-payments <n|none>        Most payments in one window
  --limit <n>          How many payments history shows (default 20)
  --tx <hash>          With settle: the transaction that shows it paid
  --json               Machine-readable output
  --version            The version

Amounts are dollars: --per-day 150. Leave out the $ sign, which your shell would expand.`;

const OPTIONS = {
  wallet: { type: 'string' },
  path: { type: 'string' },
  'per-payment': { type: 'string' },
  'per-hour': { type: 'string' },
  'per-day': { type: 'string' },
  'per-week': { type: 'string' },
  cap: { type: 'string' },
  window: { type: 'string' },
  'max-payments': { type: 'string' },
  limit: { type: 'string' },
  'all-unknown': { type: 'boolean' },
  'older-than': { type: 'string' },
  tx: { type: 'string' },
  evidence: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

interface Values {
  wallet?: string;
  path?: string;
  'per-payment'?: string;
  'per-hour'?: string;
  'per-day'?: string;
  'per-week'?: string;
  cap?: string;
  window?: string;
  'max-payments'?: string;
  limit?: string;
  'all-unknown'?: boolean;
  'older-than'?: string;
  tx?: string;
  evidence?: string;
  json?: boolean;
  help?: boolean;
  version?: boolean;
}

class Usage extends Error {}

const json = (value: unknown): string => JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);

const pathOf = (values: Values): string => resolve(expandHome(values.path ?? defaultBudgetPath()));

const iso = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

// The limits named on the command line, as the owner's handle takes them.
const limitsOf = (values: Values): LimitOptions => {
  const none = (value: string | undefined): string | null | undefined => (value !== undefined && trimAscii(value).toLowerCase() === 'none' ? null : value);
  const limits: LimitOptions = {};
  const perPayment = none(values['per-payment']);
  const maxPayments = none(values['max-payments']);
  if (perPayment !== undefined) limits.perPayment = perPayment;
  if (values['per-hour'] !== undefined) limits.perHour = values['per-hour'];
  if (values['per-day'] !== undefined) limits.perDay = values['per-day'];
  if (values['per-week'] !== undefined) limits.perWeek = values['per-week'];
  if (values.cap !== undefined) limits.cap = values.cap;
  if (values.window !== undefined) limits.window = values.window;
  if (maxPayments !== undefined) limits.maxPayments = maxPayments;
  return limits;
};

// The owner's handle on the file, for one command. `set` creates the file; nothing else does.
const withOwner = async <T>(path: string, work: (owner: Owner) => Promise<T>, create = false): Promise<T> => {
  const owner = await openOwner({ path, create });
  try {
    return await work(owner);
  } finally {
    owner.close();
  }
};

const wallets = async (path: string): Promise<string[]> => {
  if (!existsSync(path)) return [];
  // A budget the 0.3.0 upgrade couldn't merge stays under its 0.2.x name: one wallet, listed once.
  return withOwner(path, async owner => [...new Set((await owner.budgets()).map(row => storedWalletName(row.wallet)))]);
};

const walletOf = async (values: Values, path: string): Promise<string> => {
  if (values.wallet !== undefined) return normalizeWallet(values.wallet);
  const known = await wallets(path);
  if (known.length === 1 && known[0] !== undefined) return known[0];
  if (known.length === 0) throw new BudgetUnavailable(`no budget in ${path} yet: npx walletcap set --wallet <address> --per-day <dollars>`);
  throw new Usage(`the file holds ${known.length} budgets; pick one with --wallet:\n  ${known.join('\n  ')}`);
};

// One wallet's budget, for a command that reads or changes it.
const withWallet = async <T>(values: Values, path: string, work: (owner: Owner, wallet: string) => Promise<T>): Promise<T> => {
  const wallet = await walletOf(values, path);
  return withOwner(path, owner => work(owner, wallet));
};

const detail = (status: Status): string => [
  `Wallet       ${status.wallet}`,
  `Limit        ${formatUsd(status.cap)} per ${formatWindow(status.window)}, rolling`,
  `Per payment  ${status.perPayment === null ? 'no limit' : formatUsd(status.perPayment)}`,
  ...(status.maxPayments === null ? [] : [`Payments     at most ${status.maxPayments} per ${formatWindow(status.window)}`]),
  `Spent        ${formatUsd(status.spent)} in the last ${formatWindow(status.window)} (${status.payments} payment${status.payments === 1n ? '' : 's'})`,
  `In flight    ${formatUsd(status.inFlight)}`,
  `Left         ${formatUsd(status.remaining)}`,
  `State        ${status.frozen ? 'FROZEN: every payment is refused' : 'active'}`,
].join('\n');

// Every payment of unknown or refused outcome older than --older-than that the payee can no longer
// settle (an x402 payment with no settle-by time, once an hour and a minute old), for an owner
// who has checked the chain.
async function voidUnknown(values: Values, path: string, id: string | undefined): Promise<string> {
  if (id !== undefined) throw new Usage('void takes an id or --all-unknown, not both');
  if (values['older-than'] === undefined) throw new Usage('void --all-unknown needs --older-than, like --older-than 24h');
  const olderThan = toWindowMs(values['older-than'], '--older-than');
  return withWallet(values, path, async (owner, wallet) => {
    const voided = await owner.voidUnknown(wallet, { olderThan });
    if (values.json) return json(voided);
    if (voided.length === 0) {
      return `No payment of unknown or refused outcome from ${shortWallet(wallet)} can be voided yet. One goes once it is older than `
        + `${formatWindow(olderThan)} and its payee can no longer settle it; an x402 payment with no settle-by time, once it is also an hour and a minute old. `
        + 'Any other payment with no settle-by time, a transfer say, goes only by id, once the chain shows it never moved: walletcap void <id> --evidence <what shows it>.';
    }
    const total = voided.reduce((sum, row) => sum + row.amount, 0n);
    return `Voided ${voided.length} payment${voided.length === 1 ? '' : 's'} of unknown or refused outcome older than ${formatWindow(olderThan)} `
      + `(${formatUsd(total)} from ${shortWallet(wallet)}): they no longer count. Only do this for payments you know never left the wallet.`;
  });
}

// A payment named by id, after checking it is --wallet's when one is given.
const paymentFor = async (owner: Owner, values: Values, id: string, path: string) => {
  const row = await owner.payment(id);
  if (row === null) throw new Usage(`no payment ${id} in ${path}`);
  if (values.wallet !== undefined && row.wallet !== normalizeWallet(values.wallet)) {
    throw new Usage(`${id} is ${shortWallet(row.wallet)}'s payment, not ${shortWallet(normalizeWallet(values.wallet))}'s`);
  }
  return row;
};

type Command = (values: Values, path: string, rest: string[]) => Promise<string>;

const commands: Record<string, Command> = {
  async status(values, path) {
    if (values.wallet === undefined) {
      const known = await wallets(path);
      const statuses = known.length === 0 ? [] : await withOwner(path, async owner => {
        const all: Status[] = [];
        for (const wallet of known) all.push(await owner.status(wallet));
        return all;
      });
      if (values.json) return json({ path, budgets: statuses });
      if (statuses.length === 0) return `No budget in ${path} yet. Create one:\n  npx walletcap set --wallet <address> --per-day 150 --per-payment 50`;
      return [`Budget file ${path}`, '', ...statuses.map(status => status.summary)].join('\n');
    }
    return withWallet(values, path, async (owner, wallet) => {
      const status = await owner.status(wallet);
      return values.json ? json(status) : detail(status);
    });
  },

  async set(values, path) {
    const limits = limitsOf(values);
    if (Object.keys(limits).length === 0) throw new Usage('set needs a limit, like --per-day 150 or --per-payment 50');
    if (values.wallet === undefined && (await wallets(path)).length !== 1) throw new Usage('set needs --wallet <address>');
    const wallet = await walletOf(values, path);
    const status = await withOwner(path, owner => owner.setLimits(wallet, limits), true);
    if (values.json) return json(status);
    const now = describeLimits({ cap: status.cap, windowMs: status.window, perPayment: status.perPayment, maxPayments: status.maxPayments });
    return `${shortWallet(wallet)}: ${now}.\nWhat was spent still counts: ${formatUsd(status.spent)} spent, ${formatUsd(status.inFlight)} in flight, ${formatUsd(status.remaining)} left.`;
  },

  async freeze(values, path) {
    return withWallet(values, path, async (owner, wallet) => {
      await owner.freeze(wallet);
      return values.json ? json(await owner.status(wallet)) : `Frozen ${shortWallet(wallet)}: every payment from it is refused, on every rail and in every process, until you run unfreeze.`;
    });
  },

  async unfreeze(values, path) {
    return withWallet(values, path, async (owner, wallet) => {
      await owner.unfreeze(wallet);
      const status = await owner.status(wallet);
      return values.json ? json(status) : `Unfrozen. ${status.summary}`;
    });
  },

  async history(values, path) {
    return withWallet(values, path, async (owner, wallet) => {
      const rows = await owner.history(wallet, { limit: values.limit === undefined ? 20 : trimAscii(values.limit) });
      if (values.json) return json(rows);
      if (rows.length === 0) return `No payments from ${shortWallet(wallet)} yet.`;
      return rows.map(row => [
        iso(row.at),
        formatUsd(row.amount).padStart(10),
        row.status.padEnd(9),
        row.rail.padEnd(6),
        row.to ? `to ${shortWallet(row.to.toLowerCase())}` : '',
        row.tx ? `tx ${row.tx}` : row.note ?? '',
        row.status === 'in flight' || row.status === 'refused' || row.status === 'unknown' ? `(${row.id})` : '',
        row.rail === 'cdp' && (row.status === 'in flight' || row.status === 'refused' || row.status === 'unknown') ? CDP_HISTORY : '',
      ].filter(Boolean).join('  ')).join('\n');
    });
  },

  async holds(values, path) {
    return withWallet(values, path, async (owner, wallet) => {
      const holds = await owner.holds(wallet);
      if (values.json) return json(holds);
      if (holds.length === 0) return `No open payments from ${shortWallet(wallet)}.`;
      return holds.map(hold => [
        hold.id,
        formatUsd(hold.amount).padStart(10),
        hold.reason.padEnd(9),
        `${formatAge(hold.ageMs)} old`.padEnd(12),
        hold.rail.padEnd(6),
        hold.to ? `to ${shortWallet(hold.to.toLowerCase())}` : hold.note ?? '',
        hold.countsUntil === null ? 'counts until voided or settled' : `counts until ${iso(hold.countsUntil)}`,
        hold.rail === 'cdp' ? cdpSigned(hold.settlesBy) : '',
      ].filter(Boolean).join('  ')).join('\n');
    });
  },

  async void(values, path, [id]) {
    if (values['all-unknown']) return voidUnknown(values, path, id);
    if (id === undefined) throw new Usage('void needs the id of a held payment; holds and history show it');
    if (!existsSync(path)) throw new Usage(`no budget file at ${path}`);
    return withOwner(path, async owner => {
      const row = await paymentFor(owner, values, id, path);
      if (row.state === 'void') return values.json ? json(row) : `${id} is void already: it counts nothing.`;
      const voided = await owner.void(id, { evidence: values.evidence ?? 'voided by its owner' });
      if (values.json) return json(voided);
      return `Voided ${id} (${formatUsd(row.amount)} from ${shortWallet(row.wallet)}): it no longer counts. Only do this for a payment you know never left the wallet.`;
    });
  },

  async settle(values, path, [id]) {
    if (id === undefined) throw new Usage('settle needs the id of a payment; holds and history show it');
    if (!existsSync(path)) throw new Usage(`no budget file at ${path}`);
    return withOwner(path, async owner => {
      const row = await paymentFor(owner, values, id, path);
      const settled = await owner.settle(id, { evidence: values.tx ?? values.evidence ?? 'settled by its owner' });
      if (values.json) return json(settled);
      const until = settled.countsUntil === null ? '' : `; it counts until ${iso(settled.countsUntil)}`;
      return `Settled ${id} (${formatUsd(row.amount)} from ${shortWallet(row.wallet)})${until}.`;
    });
  },
};

// A payment the CDP store holds isn't one that never left: CDP signed it, and its payee can
// redeem the authorization until an hour and a minute after CDP recorded it.
const cdpSigned = (until: Date | null): string => `CDP signed it: its authorization can be redeemed until ${until === null ? 'an hour and a minute after CDP recorded it' : iso(until)}, `
  + 'so void it only if the chain shows it was never redeemed';
const CDP_HISTORY = 'CDP signed it: void it only if the chain shows it was never redeemed';

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const hint = 'Run npx walletcap --help for the commands and options.';
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }) as { values: Values; positionals: string[] };
  } catch (error) {
    process.stderr.write(`${String((error as Error).message).split('. To specify')[0]}\n${hint}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  const [command = 'status', ...rest] = positionals;
  if (values.help || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const run = Object.hasOwn(commands, command) ? commands[command] : undefined;
  if (run === undefined) {
    process.stderr.write(`unknown command ${command}\n${hint}\n`);
    return 2;
  }
  try {
    process.stdout.write(`${await run(values, pathOf(values), rest)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Usage) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    if (isWalletcapError(error)) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

// Coinbase's Agentic Wallet CLI, with every payment counted.
const [first, ...after] = process.argv.slice(2);
if (first === 'awal') {
  const { awalMain } = await import('./awal.js');
  process.exitCode = await awalMain(after);
} else {
  process.exitCode = await main();
}
