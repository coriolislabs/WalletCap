// SPDX-License-Identifier: Apache-2.0
// npx walletcap awal …: Coinbase's Agentic Wallet CLI (awal), with every send and x402 payment
// counted in the wallet's budget through walletcap/agentic.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { type GuardedWallet, guardAgenticWallet, type RequestData, usdcAtomic, type WalletRequest } from '../adapters/agentic.js';
import { openBudget } from '../core/budget.js';
import { BudgetRefused, BudgetUnavailable, UsageError } from '../core/errors.js';
import { formatUsd, normalizeWallet } from '../core/money.js';

const messageOf = (error: unknown): string => String((error as Error | undefined)?.message ?? error);

/**
 * awal's commands that move no money, passed through as they are: the command-line forms of the
 * MCP server's tools walletcap-mcp passes through. Any other command, `trade` or one awal adds
 * later, is refused unless the wallet's owner names it in WALLETCAP_AWAL_ALLOW: a command
 * walletcap does not know may move money it cannot count.
 */
export const AWAL_PASS_THROUGH_COMMANDS: readonly string[] = Object.freeze([
  'status',
  'address',
  'balance',
  'show',
  'auth login',
  'auth verify',
  'x402 bazaar list',
  'x402 bazaar search',
  'x402 details',
]);
const COUNTED_COMMANDS = ['send', 'x402 pay'];
// What awal itself answers with no command at all.
const TOP_LEVEL = new Set(['--help', '-h', 'help', '--version', '-V']);

// The command an argv starts with: the longest of `known` whose words are its first words. An
// option before the command, another spelling of it ("Send"), or a command not in the list is
// none of them.
const commandOf = (argv: string[], known: string[]): string | undefined =>
  known
    .filter(command => {
      const words = command.split(' ');
      return words.every((word, index) => argv[index] === word);
    })
    .sort((a, b) => b.length - a.length)[0];

const HELP = `walletcap awal: Coinbase's Agentic Wallet CLI (awal), with every payment counted in the wallet's budget.

Usage: npx walletcap awal <awal command> [awal options]

  send and x402 pay are checked and counted by walletcap. The commands that move no money pass
  through to awal: ${AWAL_PASS_THROUGH_COMMANDS.join(', ')}.
  Any other command, trade included, is refused: walletcap can't count it.

Environment
  WALLETCAP_AWAL_ALLOW   More awal commands to pass through, uncounted, separated by commas:
                         set by the wallet's owner, like WALLETCAP_AWAL_ALLOW="trade,auth logout"
  WALLETCAP_WALLET   The wallet's EVM address (default: asked from the wallet)
  WALLETCAP_PATH     The budget file; create it first: npx walletcap set --wallet <address> --per-day <dollars>
  WALLETCAP_AWAL     The awal package directory (default: awal resolved from the current directory)`;

/** The installed awal package's directory. */
export function locateAwal(env: NodeJS.ProcessEnv = process.env, from: string = process.cwd()): string {
  const candidates: string[] = [];
  if (env.WALLETCAP_AWAL) candidates.push(resolve(env.WALLETCAP_AWAL));
  try {
    candidates.push(dirname(createRequire(join(from, 'noop.js')).resolve('awal/package.json')));
  } catch {
    /* not installed here */
  }
  const found = candidates.find(dir => existsSync(join(dir, 'dist', 'ipcClient.js')));
  if (found === undefined) throw new BudgetUnavailable('walletcap awal needs the awal CLI: npm install awal, or set WALLETCAP_AWAL to its package directory');
  return found;
}

const walletRequest = async (awalDir: string): Promise<WalletRequest> =>
  ((await import(pathToFileURL(join(awalDir, 'dist', 'ipcClient.js')).href)) as { sendIpcRequest: WalletRequest }).sendIpcRequest;

const addressOf = (value: unknown): string | undefined => {
  const match = JSON.stringify(value ?? null).match(/0x[0-9a-fA-F]{40}/);
  return match === null ? undefined : match[0];
};

async function openGuard(env: NodeJS.ProcessEnv, request: WalletRequest, options: { wallet?: string; path?: string } = {}): Promise<GuardedWallet> {
  let wallet = env.WALLETCAP_WALLET ?? options.wallet;
  if (wallet === undefined) wallet = addressOf(await request('get-wallet-address', {}));
  if (wallet === undefined) throw new BudgetUnavailable('walletcap could not learn the wallet address; set WALLETCAP_WALLET');
  const path = env.WALLETCAP_PATH ?? options.path;
  const budget = await openBudget({ wallet: normalizeWallet(wallet), ...(path === undefined ? {} : { path }), create: false });
  return guardAgenticWallet(budget, { request });
}

const PAY_OPTIONS = {
  method: { type: 'string', short: 'X', default: 'GET' },
  data: { type: 'string', short: 'd' },
  query: { type: 'string', short: 'q' },
  headers: { type: 'string', short: 'h' },
  'max-amount': { type: 'string' },
  scheme: { type: 'string' },
  'correlation-id': { type: 'string' },
  json: { type: 'boolean' },
} as const;
const SEND_OPTIONS = { chain: { type: 'string', default: 'base' }, asset: { type: 'string', default: 'USDC' }, json: { type: 'boolean' } } as const;

type Values = Record<string, string | boolean | undefined>;

function payData(url: string, values: Values): RequestData {
  const parsed = new URL(url);
  const data: RequestData = {
    baseURL: `${parsed.protocol}//${parsed.host}`,
    path: parsed.pathname + parsed.search,
    method: String(values.method ?? 'GET').toUpperCase(),
  };
  const jsonOption = (name: string, key: string): void => {
    const value = values[name];
    if (value === undefined) return;
    try {
      data[key] = JSON.parse(String(value));
    } catch {
      throw new UsageError(`The --${name} option must be valid JSON`);
    }
  };
  jsonOption('data', 'body');
  jsonOption('query', 'queryParams');
  jsonOption('headers', 'headers');
  if (values['max-amount'] !== undefined) {
    const max = Number.parseInt(String(values['max-amount']), 10);
    if (Number.isNaN(max) || max < 0) throw new UsageError('--max-amount must be a non-negative integer (USDC atomic units)');
    data.maxAmountPerRequest = max;
  }
  if (values.scheme !== undefined) data.preferredScheme = String(values.scheme);
  if (values['correlation-id'] !== undefined) data.correlationId = values['correlation-id'];
  return data;
}

/** Run one awal command; send and x402 pay go through the budget. Returns the exit code. */
export async function awalMain(
  argv: string[],
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    request,
  }: {
    env?: NodeJS.ProcessEnv;
    stdout?: Writable;
    stderr?: Writable;
    request?: WalletRequest;
  } = {},
): Promise<number> {
  if (argv.length === 0 || argv[0] === '--walletcap-help') {
    stdout.write(`${HELP}\n`);
    return 0;
  }
  const allowed = (env.WALLETCAP_AWAL_ALLOW ?? '')
    .split(',')
    .map(command => command.trim().split(/\s+/).join(' '))
    .filter(Boolean);
  const command = commandOf(argv, [...COUNTED_COMMANDS, ...AWAL_PASS_THROUGH_COMMANDS, ...allowed]);
  const topLevel = argv.length === 1 && TOP_LEVEL.has(argv[0] ?? '');
  if (command === undefined && !topLevel) {
    // 0.4 handed awal every command but send and x402 pay, with all its arguments: trade, and a
    // send behind an option ("--json send …") or with --help as some option's value.
    const asked = argv
      .filter(word => /^[A-Za-z0-9-]{1,32}$/.test(word))
      .slice(0, 2)
      .join(' ');
    stderr.write(
      `walletcap refused awal ${asked || 'that command'}: it can't tell whether the command moves money, so it can't count it. ` +
        `Put the command first, before any option. The wallet's owner can let a command through, uncounted, with WALLETCAP_AWAL_ALLOW\n`,
    );
    return 1;
  }
  const guarded = command !== undefined && COUNTED_COMMANDS.includes(command);
  const wantsHelp = argv.includes('--help');
  let awalDir: string | undefined;
  try {
    if (request === undefined || !guarded || wantsHelp) awalDir = locateAwal(env);
  } catch (error) {
    stderr.write(`${messageOf(error)}\n`);
    return 1;
  }
  if (!guarded || wantsHelp) {
    // Help for a counted command is that command's words and --help, nothing else: awal never
    // gets a payment's arguments from here, whatever option --help was passed as the value of.
    const forwarded = guarded && command !== undefined ? [...command.split(' '), '--help'] : argv;
    const run = spawnSync(process.execPath, [join(awalDir ?? '', 'dist', 'index.js'), ...forwarded], { stdio: 'inherit', env });
    return run.status ?? 1;
  }
  const args = argv[0] === 'send' ? argv.slice(1) : argv.slice(2);
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args, options: argv[0] === 'send' ? SEND_OPTIONS : PAY_OPTIONS, allowPositionals: true, strict: true }) as {
      values: Values;
      positionals: string[];
    });
  } catch (error) {
    stderr.write(`${messageOf(error)}\n`);
    return 2;
  }
  const fail = (code: string, message: string): number => {
    if (values.json) stdout.write(`${JSON.stringify({ success: false, error: { code, message } }, null, 2)}\n`);
    else stderr.write(`${message}\n`);
    return 1;
  };
  let guard: GuardedWallet;
  try {
    guard = await openGuard(env, request ?? (await walletRequest(awalDir ?? '')));
  } catch (error) {
    return fail('BUDGET_UNAVAILABLE', `walletcap: ${messageOf(error)}`);
  }
  try {
    if (argv[0] === 'send') {
      const [amount, recipient] = positionals;
      if (amount === undefined || recipient === undefined)
        return fail('INVALID_ARGUMENTS', 'usage: send <amount> <recipient> [--chain <chain>] [--asset USDC]');
      if (!/^0x[0-9a-fA-F]{40}$/.test(recipient) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(recipient)) {
        return fail('INVALID_RECIPIENT', 'walletcap awal send takes an address (0x… or Solana), not an ENS name');
      }
      // An asset that isn't USDC is refused by the wrapper, which also tells the decision log.
      const asset = String(values.asset).toUpperCase();
      const result = (await guard.request('send-transaction', { recipient, amountAtomic: usdcAtomic(amount), asset, chain: values.chain })) as {
        error?: unknown;
        transactionHash?: unknown;
      } | null;
      if (result?.error) return fail('TRANSACTION_FAILED', `Transaction failed: ${result.error}`);
      stdout.write(
        values.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `Sent ${formatUsd(BigInt(usdcAtomic(amount)))} to ${recipient}${result?.transactionHash ? ` (${result.transactionHash})` : ''}\n`,
      );
      return 0;
    }
    const [url] = positionals;
    if (url === undefined) return fail('INVALID_ARGUMENTS', 'usage: x402 pay <url> [options]');
    const result = (await guard.request('make-x402-request', payData(url, values))) as { status?: unknown; data?: unknown } | null;
    stdout.write(
      values.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Request completed (HTTP ${result?.status})\n${typeof result?.data === 'string' ? result.data : JSON.stringify(result?.data ?? null, null, 2)}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof BudgetRefused) return fail('BUDGET_REFUSED', `walletcap refused this payment: ${error.message}`);
    return fail('REQUEST_FAILED', messageOf(error));
  } finally {
    guard.budget.close();
  }
}
