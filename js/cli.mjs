#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// npx walletcap: see, set and freeze an agent's spend budget.
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BudgetError } from './errors.mjs';
import { openBudget } from './index.mjs';
import { Ledger } from './ledger.mjs';
import {
  defaultBudgetPath, describeLimits, expandHome, formatAge, formatUsd, formatWindow, normalizeWallet, parseLimits, shortWallet,
  toWindowMs, trimAscii,
} from './money.mjs';

const { version } = createRequire(import.meta.url)('./package.json');

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
                       Give back every payment of unknown outcome older than that, once you
                       know none of them left the wallet
  awal <command>       Coinbase's Agentic Wallet CLI, with send and x402 pay counted in the budget
  awal-mcp [-- <cmd>]  Coinbase's Agentic Wallet MCP server (~/.payments-mcp) behind a proxy that
                       counts its payments and refuses tools it can't count (--allow-tool <name>)

Options
  --wallet <address>   The wallet the money leaves from (optional when the file holds one budget)
  --path <file>        The budget file (default: $WALLETCAP_PATH, else ${defaultBudgetPath()})
  --per-day <dollars>  Rolling limit; or --per-hour, --per-week, or --cap <dollars> --window <24h|7d|30m>
  --per-payment <dollars|none>   Most one payment may spend
  --max-payments <n|none>        Most payments in one window
  --limit <n>          How many payments history shows (default 20)
  --json               Machine-readable output

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
};

class Usage extends Error {}

const json = value => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

const pathOf = values => resolve(expandHome(values.path ?? defaultBudgetPath()));

const limitsOf = values => {
  const none = value => (value !== undefined && trimAscii(value).toLowerCase() === 'none' ? null : value);
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

const wallets = path => {
  if (!existsSync(path)) return [];
  const ledger = new Ledger(path);
  try {
    return ledger.budgets().map(row => row.instrument);
  } finally {
    ledger.close();
  }
};

const walletOf = (values, path) => {
  if (values.wallet !== undefined) return normalizeWallet(values.wallet);
  const known = wallets(path);
  if (known.length === 1) return known[0];
  if (known.length === 0) throw new BudgetError(`no budget in ${path} yet: npx walletcap set --wallet <address> --per-day <dollars>`);
  throw new Usage(`the file holds ${known.length} budgets; pick one with --wallet:\n  ${known.join('\n  ')}`);
};

const open = (values, path) => openBudget({ wallet: walletOf(values, path), path, create: false });

const detail = status => [
  `Wallet       ${status.wallet}`,
  `Limit        ${formatUsd(status.cap)} per ${formatWindow(status.window)}, rolling`,
  `Per payment  ${status.perPayment === null ? 'no limit' : formatUsd(status.perPayment)}`,
  ...(status.maxPayments === null ? [] : [`Payments     at most ${status.maxPayments} per ${formatWindow(status.window)}`]),
  `Spent        ${formatUsd(status.spent)} in the last ${formatWindow(status.window)} (${status.payments} payment${status.payments === 1n ? '' : 's'})`,
  `In flight    ${formatUsd(status.inFlight)}`,
  `Left         ${formatUsd(status.remaining)}`,
  `State        ${status.frozen ? 'FROZEN: every payment is refused' : 'active'}`,
].join('\n');

// Every payment of unknown outcome older than --older-than, for an owner who has checked the chain.
function releaseUnknown(values, path, id) {
  if (id !== undefined) throw new Usage('release takes an id or --all-unknown, not both');
  if (values['older-than'] === undefined) throw new Usage('release --all-unknown needs --older-than, like --older-than 24h');
  const olderThan = toWindowMs(values['older-than'], '--older-than');
  if (!existsSync(path)) throw new BudgetError(`no budget file at ${path}`);
  const wallet = walletOf(values, path);
  const ledger = new Ledger(path);
  try {
    const released = ledger.releaseUnknown(wallet, olderThan);
    if (values.json) return json(released.map(row => ({ id: row.spend_id, amount: row.amount })));
    if (released.length === 0) return `No payment of unknown outcome from ${shortWallet(wallet)} is older than ${formatWindow(olderThan)}.`;
    const total = released.reduce((sum, row) => sum + row.amount, 0n);
    return `Released ${released.length} payment${released.length === 1 ? '' : 's'} of unknown outcome older than ${formatWindow(olderThan)} `
      + `(${formatUsd(total)} from ${shortWallet(wallet)}): they no longer count. Only do this for payments you know never left the wallet.`;
  } finally {
    ledger.close();
  }
}

const commands = {
  status(values, path) {
    if (values.wallet === undefined) {
      const statuses = wallets(path).map(wallet => {
        const budget = openBudget({ wallet, path, create: false });
        try { return budget.status(); } finally { budget.close(); }
      });
      if (values.json) return json({ path, budgets: statuses });
      if (statuses.length === 0) return `No budget in ${path} yet. Create one:\n  npx walletcap set --wallet <address> --per-day 150 --per-payment 50`;
      return [`Budget file ${path}`, '', ...statuses.map(status => status.summary)].join('\n');
    }
    const budget = open(values, path);
    try {
      const status = budget.status();
      return values.json ? json(status) : detail(status);
    } finally {
      budget.close();
    }
  },

  set(values, path) {
    const limits = limitsOf(values);
    if (Object.keys(limits).length === 0) throw new Usage('set needs a limit, like --per-day 150 or --per-payment 50');
    if (values.wallet === undefined && wallets(path).length !== 1) throw new Usage('set needs --wallet <address>');
    const wallet = walletOf(values, path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const ledger = new Ledger(path);
    try {
      ledger.setLimits(wallet, limits, { unit: 'usd', create: true });
    } finally {
      ledger.close();
    }
    const budget = openBudget({ wallet, path, create: false });
    try {
      const status = budget.status();
      if (values.json) return json(status);
      const now = describeLimits({ cap: status.cap, windowMs: status.window, perPayment: status.perPayment, maxUses: status.maxPayments });
      return `${shortWallet(wallet)}: ${now}.\nWhat was spent still counts: ${formatUsd(status.spent)} spent, ${formatUsd(status.inFlight)} in flight, ${formatUsd(status.remaining)} left.`;
    } finally {
      budget.close();
    }
  },

  freeze(values, path) {
    const budget = open(values, path);
    try {
      budget.freeze();
      return values.json ? json(budget.status()) : `Frozen ${shortWallet(budget.wallet)}: every payment from it is refused, on every rail and in every process, until you run unfreeze.`;
    } finally {
      budget.close();
    }
  },

  unfreeze(values, path) {
    const budget = open(values, path);
    try {
      budget.unfreeze();
      return values.json ? json(budget.status()) : `Unfrozen. ${budget.status().summary}`;
    } finally {
      budget.close();
    }
  },

  history(values, path) {
    const budget = open(values, path);
    try {
      const rows = budget.history({ limit: values.limit === undefined ? 20 : trimAscii(values.limit) });
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
    } finally {
      budget.close();
    }
  },

  holds(values, path) {
    const budget = open(values, path);
    try {
      const holds = budget.holds();
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
    } finally {
      budget.close();
    }
  },

  release(values, path, [id]) {
    if (values['all-unknown']) return releaseUnknown(values, path, id);
    if (id === undefined) throw new Usage('release needs the id of an in-flight payment; history shows it');
    if (!existsSync(path)) throw new BudgetError(`no budget file at ${path}`);
    const ledger = new Ledger(path);
    try {
      const row = ledger.payment(id);
      if (row === null) throw new BudgetError(`no payment ${id} in ${path}`);
      if (values.wallet !== undefined && row.instrument !== normalizeWallet(values.wallet)) {
        throw new BudgetError(`${id} is ${shortWallet(row.instrument)}'s payment, not ${shortWallet(normalizeWallet(values.wallet))}'s`);
      }
      if (row.status === 'committed') throw new BudgetError(`${id} is recorded as settled; only an in-flight payment can be released`);
      ledger.release(id);
      return `Released ${id} (${formatUsd(row.amount)} from ${shortWallet(row.instrument)}): it no longer counts. Only do this for a payment you know never left the wallet.`;
    } finally {
      ledger.close();
    }
  },
};

export function main(argv = process.argv.slice(2)) {
  const hint = 'Run npx walletcap --help for the commands and options.';
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    process.stderr.write(`${error.message.split('. To specify')[0]}\n${hint}\n`);
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
  if (!Object.hasOwn(commands, command)) {
    process.stderr.write(`unknown command ${command}\n${hint}\n`);
    return 2;
  }
  try {
    process.stdout.write(`${commands[command](values, pathOf(values), rest)}\n`);
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

// Coinbase's Agentic Wallet: its CLI and its MCP server, with every payment counted.
const [first, ...after] = process.argv.slice(2);
if (first === 'awal') {
  const { awalMain } = await import('./agentic.mjs');
  process.exitCode = await awalMain(after);
} else if (first === 'awal-mcp') {
  const { awalMcpMain } = await import('./agentic.mjs');
  process.exitCode = await awalMcpMain(after);
} else {
  process.exitCode = main();
}
