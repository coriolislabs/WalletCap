#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// npx walletcap: see, set and freeze an agent's spend budget.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Budget, openBudget, type Status } from '../core/budget.js';
import { BudgetError } from '../core/errors.js';
import { Ledger } from '../core/ledger.js';
import {
  defaultBudgetPath, describeLimits, expandHome, formatAge, formatUsd, formatWindow, normalizeWallet, parseLimits, shortWallet,
  storedWalletName, toWindowMs, trimAscii,
} from '../core/money.js';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

const HELP = `walletcap ${version}: one spend budget per wallet, for every agent that pays from it.

Usage: npx walletcap <command> [options]

Commands
  status               Every budget in the file, or one wallet's in detail (the default)
  set                  Create a wallet's budget or change its limits; what was spent keeps counting
  freeze               Refuse every payment from the wallet, in every process, until unfreeze
  unfreeze             Allow payments again
  history              The newest payments first
  holds                The open payments that still count, and why: in flight, refused or unknown
  release <id>         Give back an in-flight payment you know never left the wallet
  release --all-unknown --older-than <24h|7d|30m>
                       Give back every payment of unknown or refused outcome older than that,
                       once you know none of them left the wallet. One the payee could still
                       settle stays, and one with no settle-by time stays until it is an hour
                       and a minute old
  awal <command>       Coinbase's Agentic Wallet CLI, with send and x402 pay counted in the budget.
                       For its MCP server, use the walletcap-mcp package: npx walletcap-mcp --wallet <address>

Options
  --wallet <address>   The wallet the money leaves from (optional when the file holds one budget)
  --path <file>        The budget file (default: $WALLETCAP_PATH, else ${defaultBudgetPath()})
  --per-day <dollars>  Rolling limit; or --per-hour, --per-week, or --cap <dollars> --window <24h|7d|30m>
  --per-payment <dollars|none>   Most one payment may spend
  --max-payments <n|none>        Most payments in one window
  --limit <n>          How many payments history shows (default 20)
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
  json?: boolean;
  help?: boolean;
  version?: boolean;
}

class Usage extends Error {}

const json = (value: unknown): string => JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);

const pathOf = (values: Values): string => resolve(expandHome(values.path ?? defaultBudgetPath()));

const limitsOf = (values: Values) => {
  const none = (value: string | undefined): string | null | undefined => (value !== undefined && trimAscii(value).toLowerCase() === 'none' ? null : value);
  return parseLimits({
    perPayment: none(values['per-payment']),
    perHour: values['per-hour'],
    perDay: values['per-day'],
    perWeek: values['per-week'],
    cap: values.cap,
    window: values.window,
    maxPayments: none(values['max-payments']),
  });
};

const withLedger = async <T>(path: string, work: (ledger: Ledger) => Promise<T>, create = false): Promise<T> => {
  const ledger = await Ledger.open(path, { create });
  try {
    return await work(ledger);
  } finally {
    ledger.close();
  }
};

const wallets = async (path: string): Promise<string[]> => {
  if (!existsSync(path)) return [];
  // A budget the 0.3.0 upgrade couldn't merge stays under its 0.2.x name: one wallet, listed once.
  return withLedger(path, async ledger => [...new Set((await ledger.budgets()).map(row => storedWalletName(row.wallet)))]);
};

const walletOf = async (values: Values, path: string): Promise<string> => {
  if (values.wallet !== undefined) return normalizeWallet(values.wallet);
  const known = await wallets(path);
  if (known.length === 1 && known[0] !== undefined) return known[0];
  if (known.length === 0) throw new BudgetError(`no budget in ${path} yet: npx walletcap set --wallet <address> --per-day <dollars>`);
  throw new Usage(`the file holds ${known.length} budgets; pick one with --wallet:\n  ${known.join('\n  ')}`);
};

const withBudget = async <T>(values: Values, path: string, work: (budget: Budget) => Promise<T>): Promise<T> => {
  const budget = await openBudget({ wallet: await walletOf(values, path), path, create: false });
  try {
    return await work(budget);
  } finally {
    budget.close();
  }
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
// settle (with no settle-by time, an hour and a minute old), for an owner who has checked the chain.
async function releaseUnknown(values: Values, path: string, id: string | undefined): Promise<string> {
  if (id !== undefined) throw new Usage('release takes an id or --all-unknown, not both');
  if (values['older-than'] === undefined) throw new Usage('release --all-unknown needs --older-than, like --older-than 24h');
  const olderThan = toWindowMs(values['older-than'], '--older-than');
  if (!existsSync(path)) throw new BudgetError(`no budget file at ${path}`);
  const wallet = await walletOf(values, path);
  const released = await withLedger(path, ledger => ledger.voidUnknown(wallet, olderThan));
  if (values.json) return json(released.map(row => ({ id: row.payment, amount: row.amount })));
  if (released.length === 0) {
    return `No payment of unknown or refused outcome from ${shortWallet(wallet)} can be released yet. One goes once it is older than `
      + `${formatWindow(olderThan)} and its payee can no longer settle it; one with no settle-by time, once it is also an hour and a minute old.`;
  }
  const total = released.reduce((sum, row) => sum + row.amount, 0n);
  return `Released ${released.length} payment${released.length === 1 ? '' : 's'} of unknown or refused outcome older than ${formatWindow(olderThan)} `
    + `(${formatUsd(total)} from ${shortWallet(wallet)}): they no longer count. Only do this for payments you know never left the wallet.`;
}

type Command = (values: Values, path: string, rest: string[]) => Promise<string>;

const commands: Record<string, Command> = {
  async status(values, path) {
    if (values.wallet === undefined) {
      const statuses: Status[] = [];
      for (const wallet of await wallets(path)) {
        const budget = await openBudget({ wallet, path, create: false });
        try { statuses.push(await budget.status()); } finally { budget.close(); }
      }
      if (values.json) return json({ path, budgets: statuses });
      if (statuses.length === 0) return `No budget in ${path} yet. Create one:\n  npx walletcap set --wallet <address> --per-day 150 --per-payment 50`;
      return [`Budget file ${path}`, '', ...statuses.map(status => status.summary)].join('\n');
    }
    return withBudget(values, path, async budget => {
      const status = await budget.status();
      return values.json ? json(status) : detail(status);
    });
  },

  async set(values, path) {
    const limits = limitsOf(values);
    if (Object.keys(limits).length === 0) throw new Usage('set needs a limit, like --per-day 150 or --per-payment 50');
    if (values.wallet === undefined && (await wallets(path)).length !== 1) throw new Usage('set needs --wallet <address>');
    const wallet = await walletOf(values, path);
    await withLedger(path, async ledger => {
      const { maxUses, ...rest } = limits;
      const owned = { ...rest, ...(maxUses === undefined ? {} : { maxPayments: maxUses }) };
      if (await ledger.budget(wallet) !== null) await ledger.setLimits(wallet, owned);
      else if (owned.cap === undefined || owned.windowMs === undefined) throw new BudgetError(`${shortWallet(wallet)} has no budget yet: give it a rolling limit too, like --per-day 150`);
      else await ledger.createBudget(wallet, { ...owned, cap: owned.cap, windowMs: owned.windowMs });
    }, true);
    return withBudget({ ...values, wallet }, path, async budget => {
      const status = await budget.status();
      if (values.json) return json(status);
      const now = describeLimits({ cap: status.cap, windowMs: status.window, perPayment: status.perPayment, maxUses: status.maxPayments });
      return `${shortWallet(wallet)}: ${now}.\nWhat was spent still counts: ${formatUsd(status.spent)} spent, ${formatUsd(status.inFlight)} in flight, ${formatUsd(status.remaining)} left.`;
    });
  },

  async freeze(values, path) {
    return withBudget(values, path, async budget => {
      await budget.freeze();
      return values.json ? json(await budget.status()) : `Frozen ${shortWallet(budget.wallet)}: every payment from it is refused, on every rail and in every process, until you run unfreeze.`;
    });
  },

  async unfreeze(values, path) {
    return withBudget(values, path, async budget => {
      await budget.unfreeze();
      return values.json ? json(await budget.status()) : `Unfrozen. ${(await budget.status()).summary}`;
    });
  },

  async history(values, path) {
    return withBudget(values, path, async budget => {
      const rows = await budget.history({ limit: values.limit === undefined ? 20 : trimAscii(values.limit) });
      if (values.json) return json(rows);
      if (rows.length === 0) return `No payments from ${shortWallet(budget.wallet)} yet.`;
      return rows.map(row => [
        row.at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        formatUsd(row.amount).padStart(10),
        row.status.padEnd(9),
        row.rail.padEnd(6),
        row.to ? `to ${shortWallet(row.to.toLowerCase())}` : '',
        row.tx ? `tx ${row.tx}` : row.note ?? '',
        row.status === 'in flight' || row.status === 'refused' || row.status === 'unknown' ? `(${row.id})` : '',
      ].filter(Boolean).join('  ')).join('\n');
    });
  },

  async holds(values, path) {
    return withBudget(values, path, async budget => {
      const holds = await budget.holds();
      if (values.json) return json(holds);
      if (holds.length === 0) return `No open payments from ${shortWallet(budget.wallet)}.`;
      return holds.map(hold => [
        hold.id,
        formatUsd(hold.amount).padStart(10),
        hold.reason.padEnd(9),
        `${formatAge(hold.ageMs)} old`.padEnd(12),
        hold.rail.padEnd(6),
        hold.to ? `to ${shortWallet(hold.to.toLowerCase())}` : hold.note ?? '',
        hold.until === null ? 'counts until released' : `counts until ${hold.until.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
      ].filter(Boolean).join('  ')).join('\n');
    });
  },

  async release(values, path, [id]) {
    if (values['all-unknown']) return releaseUnknown(values, path, id);
    if (id === undefined) throw new Usage('release needs the id of an in-flight payment; history shows it');
    if (!existsSync(path)) throw new BudgetError(`no budget file at ${path}`);
    return withLedger(path, async ledger => {
      const row = await ledger.payment(id);
      if (row === null) throw new BudgetError(`no payment ${id} in ${path}`);
      if (values.wallet !== undefined && row.wallet !== normalizeWallet(values.wallet)) {
        throw new BudgetError(`${id} is ${shortWallet(row.wallet)}'s payment, not ${shortWallet(normalizeWallet(values.wallet))}'s`);
      }
      if (row.state !== 'held') throw new BudgetError(`${id} is recorded as ${row.state}; only an in-flight payment can be released`);
      await ledger.void(id, { evidence: 'released by its owner' });
      return `Released ${id} (${formatUsd(row.amount)} from ${shortWallet(row.wallet)}): it no longer counts. Only do this for a payment you know never left the wallet.`;
    });
  },
};

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
    if (error instanceof BudgetError) {
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
