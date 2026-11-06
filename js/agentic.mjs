// SPDX-License-Identifier: Apache-2.0
// Put the budget in front of Coinbase's Agentic Wallet: the awal CLI and the payments-mcp server.
//
// Every send and every x402 payment that goes through here is counted in the wallet's budget,
// whichever process or session on this host makes it. An x402 payment is priced before the wallet
// signs it, and the wallet is handed the terms walletcap priced and capped at that amount. Once
// the wallet answers, the payment counts until one window past the time its authorization
// expires, whatever the payee says; if the wallet never answers, until its owner releases it. A
// send counts for one window, or, if its outcome is unknown, until its owner releases it.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { now } from './_clock.mjs';
import { BudgetError, BudgetRefused, PaymentNotRecorded } from './errors.mjs';
import { openBudget } from './index.mjs';
import { SETTLES_BY } from './ledger.mjs';
import { formatUsd, normalizeWallet, trimAscii } from './money.mjs';
import { assetKey, assetTable, atomicOf, settlesWithinSeconds, timeoutRefusal, toMicros as atomicToMicros } from './x402.mjs';

/** The wallet's chain names, as CAIP-2 networks. */
export const AWAL_CHAINS = Object.freeze({
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  polygon: 'eip155:137',
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
});

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
// Room for the wallet's clock, or the chain's, to run ahead of this one.
const CLOCK_SKEW_MS = 60_000n;

// The wallet's own refusals, raised before it signs anything. Only these give the amount back:
// any other failure may come after the signature left, so it keeps counting.
const NOT_SIGNED = [
  /^(?:UI bridge error: )?x402 request failed: Required payment \$[0-9.,]+ exceeds /,
  /^(?:UI bridge error: )?Failed to discover payment requirements/,
  /^Failed to start wallet/,
  /^(?:UI bridge error: )?(?:Not authenticated|Authentication required|Please sign in)/i,
];
const notSigned = error => NOT_SIGNED.some(pattern => pattern.test(String(error?.message ?? error)));

// The payment settled; record it, or say it went through but couldn't be recorded (not a BudgetError).
const settled = (reservation, tx) => {
  try {
    reservation.commit({ tx });
  } catch (error) {
    throw new PaymentNotRecorded(reservation.id, { cause: error });
  }
};

// Record what the wallet answered. If the ledger can't (a busy timeout, say), the payment still
// counts as in flight, and the caller gets PaymentNotRecorded, not a BudgetError it might retry on.
const recorded = (reservation, write) => {
  try {
    write();
  } catch (error) {
    throw new PaymentNotRecorded(reservation.id, { cause: error, settled: false });
  }
};

// The amount the wallet sends is the amount counted: a whole number of atomic units in ASCII
// digits, passed on to the wallet as walletcap read it ("0x10" or " 5" could read differently there).
const sendAmount = value => {
  const text = typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)) ? String(value) : value;
  if (typeof text !== 'string' || !/^[0-9]+$/.test(text)) {
    throw new BudgetError(`the send amount ${String(value)} is not a whole number of atomic units`);
  }
  return BigInt(text);
};

const decodeHeader = value => {
  try {
    return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
  } catch {
    return null;
  }
};

const headerOf = (headers, name) => {
  if (headers === null || typeof headers !== 'object') return undefined;
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
};

/** The PAYMENT-RESPONSE a payee sent back with a wallet result, decoded, or null. */
const paymentResponseOf = result => {
  const header = headerOf(result?.headers, 'payment-response') ?? headerOf(result?.headers, 'x-payment-response');
  return header === undefined ? null : decodeHeader(header);
};

const requestUrl = data => {
  const url = new URL(data.path ?? '', data.baseURL);
  for (const [key, value] of Object.entries(data.queryParams ?? {})) url.searchParams.set(key, String(value));
  return url;
};

/**
 * Ask the endpoint what it charges: its 402 answer, with the payment requirements it accepts
 * (`accepts`) and any `extensions`, or null if it asks for none.
 */
export async function discoverRequirements(data, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const method = String(data.method ?? 'GET').toUpperCase();
  const init = { method, headers: { Accept: 'application/json', ...(data.headers ?? {}) }, redirect: 'follow' };
  if (data.body !== undefined && method !== 'GET') {
    init.body = typeof data.body === 'string' ? data.body : JSON.stringify(data.body);
    init.headers['Content-Type'] ??= 'application/json';
  }
  const response = await fetchImpl(requestUrl(data), init);
  if (response.status !== 402) return null;
  const header = response.headers.get('payment-required');
  const required = header ? decodeHeader(header) : await response.json().catch(() => null);
  if (!Array.isArray(required?.accepts) || required.accepts.length === 0) {
    throw new BudgetError(`${requestUrl(data).origin} answered 402 without payment requirements walletcap can read`);
  }
  return required;
}

/**
 * Count every send and x402 payment made through `request(channel, data)`, the wallet's own
 * request channel, in `budget`. Returns a `request` with the same shape that applies the budget.
 */
export function guardAgenticWallet(budget, { request, assets = [], fetch: fetchImpl, discover } = {}) {
  if (typeof request !== 'function') throw new BudgetError('guardAgenticWallet needs request(channel, data): the wallet\'s request channel');
  const table = assetTable(assets);
  const findRequirements = discover ?? (data => discoverRequirements(data, { fetch: fetchImpl }));
  const networkOf = requirement => assetKey(requirement.network, requirement.asset).split(' ')[0];

  // A failure the wallet reports before signing gives the amount back. Anything else may come after
  // the payment left, so it stays in flight, marked unknown, and keeps counting: an error never
  // settles a payment.
  const failed = (reservation, error) => {
    if (!reservation.open) return;
    recorded(reservation, () => {
      if (notSigned(error)) reservation.release();
      else reservation.annotate({ outcome: 'unknown', error: String(error?.message ?? error).slice(0, 200) });
    });
  };

  // How long after the wallet signs its payment can settle, in milliseconds. The wallet may pay any
  // of the terms, whatever walletcap would pick, so the longest of them counts, whatever the
  // scheme (settlesWithinSeconds), plus a minute of clock skew. If any term doesn't say, or asks
  // for more than an hour, the payment is refused before the wallet is asked: walletcap would
  // otherwise have only the payee's word that it settled.
  const settlesWithinMs = requirements => {
    let longest = 0;
    for (const requirement of requirements) {
      const refusal = timeoutRefusal(requirement);
      if (refusal !== null) throw refusal;
      longest = Math.max(longest, settlesWithinSeconds(requirement));
    }
    return BigInt(longest) * 1000n + CLOCK_SKEW_MS;
  };

  async function send(data) {
    const asset = String(data?.asset ?? 'USDC').toUpperCase();
    const chain = String(data?.chain ?? 'base');
    const network = AWAL_CHAINS[chain];
    if (asset !== 'USDC' || network === undefined) {
      throw new BudgetRefused('asset', `walletcap counts USDC; it cannot price ${asset} on ${chain}, so it refuses this send`);
    }
    const atomic = sendAmount(data?.amountAtomic);
    if (atomic <= 0n) throw new BudgetError('the send amount must be more than $0');
    const recipient = data?.recipient;
    if (typeof recipient !== 'string' || recipient.length === 0) throw new BudgetError('the send needs a recipient');
    const reservation = budget.reserve(atomic, {
      rail: 'awal', to: recipient, note: `send on ${chain}`, details: { network, asset },
    });
    let result;
    try {
      // Only the fields the wallet's send takes, as walletcap read them: nothing else reaches the wallet.
      result = await request('send-transaction', { recipient, amountAtomic: atomic.toString(), asset, chain });
    } catch (error) {
      failed(reservation, error);
      throw error;
    }
    // A transaction the wallet reports as failed may still be mined: it keeps counting.
    if (result?.error) failed(reservation, new Error(String(result.error)));
    else settled(reservation, TX_HASH.test(result?.transactionHash ?? '') ? result.transactionHash : undefined);
    return result;
  }

  async function x402(data) {
    // The wallet is handed the terms walletcap checks: the caller's, as they are, or the ones
    // walletcap discovers. Handed terms, awal skips its own 402 discovery and signs only a term
    // equal to one of them, maxTimeoutSeconds included, so the payee can't show it others.
    const handed = Array.isArray(data.paymentRequirements) && data.paymentRequirements.length > 0;
    const required = handed ? null : await findRequirements(data);
    const url = requestUrl(data).href.slice(0, 1024);
    if (!handed && required === null) {
      // The endpoint asked for nothing. Let the request through with the wallet's smallest
      // possible payment cap, one atomic unit, counted, in case the payee asks for money after
      // all. Nothing was signed for value, so unless the payee confirms a payment the hold is
      // given back: a free endpoint that fails can't leave holds that use up maxPayments.
      const reservation = budget.reserve(1n, { rail: 'awal-x402', note: url });
      let result;
      try {
        result = await request('make-x402-request', { ...data, maxAmountPerRequest: 1 });
      } catch (error) {
        recorded(reservation, () => reservation.release());
        throw error;
      }
      const answer = paymentResponseOf(result);
      if (answer?.success === true && TX_HASH.test(answer.transaction ?? '')) settled(reservation, answer.transaction);
      else recorded(reservation, () => reservation.release());
      return result;
    }
    const offered = handed ? data.paymentRequirements : required.accepts;
    const extensions = required?.extensions;
    const terms = handed ? {} : {
      paymentRequirements: offered,
      // The wallet uses the 402's extensions only when it discovers the terms itself.
      ...(data.extensions === undefined && extensions !== null && typeof extensions === 'object' && !Array.isArray(extensions) ? { extensions } : {}),
    };
    const settlesWithin = settlesWithinMs(offered);
    const preferred = data.preferredNetwork === undefined ? undefined : AWAL_CHAINS[data.preferredNetwork];
    const candidates = offered.filter(requirement => (preferred === undefined || networkOf(requirement) === preferred)
      && (data.preferredScheme === undefined || requirement.scheme === data.preferredScheme));
    const priced = candidates.filter(requirement => table.has(assetKey(requirement.network, requirement.asset)));
    if (priced.length === 0) {
      const first = candidates[0] ?? offered[0];
      throw new BudgetRefused('asset', `walletcap cannot price ${first?.asset} on ${first?.network}; it pays only in the USD stablecoins it knows`);
    }
    // The wallet picks the terms itself when it pays, so reserve the most any offer asks
    // and cap the wallet at exactly that: it refuses to sign for more.
    const choice = priced.reduce((most, requirement) => (atomicOf(requirement) > atomicOf(most) ? requirement : most));
    const micros = atomicToMicros(atomicOf(choice), table.get(assetKey(choice.network, choice.asset)));
    if (data.maxAmountPerRequest !== undefined && micros > BigInt(data.maxAmountPerRequest)) {
      throw new BudgetRefused('per_payment', `the endpoint asks ${formatUsd(micros)}, more than the request's own maximum`);
    }
    // A payment counts until its owner releases it (npx walletcap release), or, once the wallet
    // has answered, until one window past the time it can no longer settle.
    const reservation = budget.reserve(micros, {
      rail: 'awal-x402', to: choice.payTo, note: url,
      details: { network: choice.network, asset: choice.asset, scheme: choice.scheme, maxTimeoutSeconds: choice.maxTimeoutSeconds },
    });
    let result;
    try {
      result = await request('make-x402-request', { ...data, ...terms, maxAmountPerRequest: Number(atomicOf(choice)) });
    } catch (error) {
      // The wallet may not have answered yet, and may still sign: it counts until released.
      failed(reservation, error);
      throw error;
    }
    // The wallet has answered, so it has signed if it ever will. The hold learns when that
    // authorization expires before anything else: a commit never shortens a hold, so the payee's
    // own word that the payment settled can't free the budget early.
    recorded(reservation, () => reservation[SETTLES_BY](BigInt(now()) + settlesWithin));
    const answer = paymentResponseOf(result);
    if (answer?.success === true && TX_HASH.test(answer.transaction ?? '')) settled(reservation, answer.transaction);
    else recorded(reservation, () => reservation.annotate({ outcome: answer?.success === false || result?.status === 402 ? 'refused' : 'unknown' }));
    return result;
  }

  // The agent is told why a payment was refused, not which holds its owner could release: that
  // is for the owner's CLI (walletcap holds) and budget.check().
  const toAgent = async pay => {
    try {
      return await pay();
    } catch (error) {
      if (error instanceof BudgetRefused && error.brief !== error.message) throw new BudgetRefused(error.reason, error.brief);
      throw error;
    }
  };

  return {
    budget,
    async request(channel, data) {
      if (channel === 'send-transaction') return toAgent(() => send(data ?? {}));
      if (channel === 'make-x402-request') return toAgent(() => x402(data ?? {}));
      return request(channel, data);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// npx walletcap awal …: the awal CLI, with every send and x402 payment counted in the budget.

const HELP = `walletcap awal: Coinbase's Agentic Wallet CLI (awal), with every payment counted in the wallet's budget.

Usage: npx walletcap awal <awal command> [awal options]

  send and x402 pay are checked and counted by walletcap; every other command is awal's own.

Environment
  WALLETCAP_WALLET   The wallet's EVM address (default: asked from the wallet)
  WALLETCAP_PATH     The budget file; create it first: npx walletcap set --wallet <address> --per-day <dollars>
  WALLETCAP_AWAL     The awal package directory (default: awal resolved from the current directory)`;

/** The installed awal package's directory. */
export function locateAwal(env = process.env, from = process.cwd()) {
  const candidates = [];
  if (env.WALLETCAP_AWAL) candidates.push(resolve(env.WALLETCAP_AWAL));
  try {
    candidates.push(dirname(createRequire(join(from, 'noop.js')).resolve('awal/package.json')));
  } catch { /* not installed here */ }
  const found = candidates.find(dir => existsSync(join(dir, 'dist', 'ipcClient.js')));
  if (found === undefined) throw new BudgetError('walletcap awal needs the awal CLI: npm install awal, or set WALLETCAP_AWAL to its package directory');
  return found;
}

const walletRequest = async awalDir => (await import(pathToFileURL(join(awalDir, 'dist', 'ipcClient.js')).href)).sendIpcRequest;

const addressOf = value => {
  const match = JSON.stringify(value ?? null).match(/0x[0-9a-fA-F]{40}/);
  return match === null ? undefined : match[0];
};

async function openGuard(env, request, options = {}) {
  let wallet = env.WALLETCAP_WALLET ?? options.wallet;
  if (wallet === undefined) wallet = addressOf(await request('get-wallet-address', {}));
  if (wallet === undefined) throw new BudgetError('walletcap could not learn the wallet address; set WALLETCAP_WALLET');
  const budget = openBudget({ wallet: normalizeWallet(wallet), path: env.WALLETCAP_PATH ?? options.path, create: false });
  return guardAgenticWallet(budget, { request });
}

const AWAL_AMOUNT = /^\$?[ \t\n\v\f\r]*([0-9]+)(?:\.([0-9]+))?$/;

/**
 * awal's own amount rule for USDC, read exactly: "$0.05" and "0.05" are dollars, and a whole
 * number above 100 ("50000", "101.0") is atomic units. Anything else is refused: "100.5abc", "1e3",
 * "1,000", digits other than 0-9, and amounts finer than one atomic unit (0.000001).
 */
export function usdcAtomic(amount) {
  const match = AWAL_AMOUNT.exec(trimAscii(String(amount)));
  if (match === null) {
    throw new BudgetError(`Invalid amount: ${amount}. Give USDC like 0.05 or $0.05, or a whole number of atomic units above 100.`);
  }
  const [, whole, fraction = ''] = match;
  if (/[^0]/.test(fraction.slice(6))) throw new BudgetError(`Invalid amount: ${amount} is finer than one atomic unit of USDC (0.000001).`);
  const atomic = !/[^0]/.test(fraction) && BigInt(whole) > 100n
    ? BigInt(whole)
    : BigInt(whole) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, '0'));
  if (atomic === 0n) throw new BudgetError(`Invalid amount: ${amount}. Must be a positive number.`);
  return atomic.toString();
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
};
const SEND_OPTIONS = { chain: { type: 'string', default: 'base' }, asset: { type: 'string', default: 'USDC' }, json: { type: 'boolean' } };

function payData(url, values) {
  const parsed = new URL(url);
  const data = { baseURL: `${parsed.protocol}//${parsed.host}`, path: parsed.pathname + parsed.search, method: values.method.toUpperCase() };
  const jsonOption = (name, key) => {
    if (values[name] === undefined) return;
    try { data[key] = JSON.parse(values[name]); } catch { throw new BudgetError(`The --${name} option must be valid JSON`); }
  };
  jsonOption('data', 'body');
  jsonOption('query', 'queryParams');
  jsonOption('headers', 'headers');
  if (values['max-amount'] !== undefined) {
    const max = Number.parseInt(values['max-amount'], 10);
    if (Number.isNaN(max) || max < 0) throw new BudgetError('--max-amount must be a non-negative integer (USDC atomic units)');
    data.maxAmountPerRequest = max;
  }
  if (values.scheme !== undefined) data.preferredScheme = values.scheme;
  if (values['correlation-id'] !== undefined) data.correlationId = values['correlation-id'];
  return data;
}

/** Run one awal command; send and x402 pay go through the budget. Returns the exit code. */
export async function awalMain(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, request } = {}) {
  if (argv.length === 0 || argv[0] === '--walletcap-help') {
    stdout.write(`${HELP}\n`);
    return 0;
  }
  const guarded = argv[0] === 'send' || (argv[0] === 'x402' && argv[1] === 'pay');
  const wantsHelp = argv.includes('--help');
  let awalDir;
  try {
    if (request === undefined || !guarded || wantsHelp) awalDir = locateAwal(env);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
  if (!guarded || wantsHelp) {
    const run = spawnSync(process.execPath, [join(awalDir, 'dist', 'index.js'), ...argv], { stdio: 'inherit', env });
    return run.status ?? 1;
  }
  const args = argv[0] === 'send' ? argv.slice(1) : argv.slice(2);
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({ args, options: argv[0] === 'send' ? SEND_OPTIONS : PAY_OPTIONS, allowPositionals: true, strict: true }));
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }
  const fail = (code, message) => {
    if (values.json) stdout.write(`${JSON.stringify({ success: false, error: { code, message } }, null, 2)}\n`);
    else stderr.write(`${message}\n`);
    return 1;
  };
  let guard;
  try {
    guard = await openGuard(env, request ?? await walletRequest(awalDir));
  } catch (error) {
    return fail('BUDGET_UNAVAILABLE', `walletcap: ${error.message}`);
  }
  try {
    if (argv[0] === 'send') {
      const [amount, recipient] = positionals;
      if (amount === undefined || recipient === undefined) return fail('INVALID_ARGUMENTS', 'usage: send <amount> <recipient> [--chain <chain>] [--asset USDC]');
      if (!/^0x[0-9a-fA-F]{40}$/.test(recipient) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(recipient)) {
        return fail('INVALID_RECIPIENT', 'walletcap awal send takes an address (0x… or Solana), not an ENS name');
      }
      const asset = values.asset.toUpperCase();
      if (asset !== 'USDC') throw new BudgetRefused('asset', `walletcap counts USDC; it cannot price ${asset}, so it refuses this send`);
      const result = await guard.request('send-transaction', { recipient, amountAtomic: usdcAtomic(amount), asset, chain: values.chain });
      if (result?.error) return fail('TRANSACTION_FAILED', `Transaction failed: ${result.error}`);
      stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : `Sent ${formatUsd(BigInt(usdcAtomic(amount)))} to ${recipient}${result?.transactionHash ? ` (${result.transactionHash})` : ''}\n`);
      return 0;
    }
    const [url] = positionals;
    if (url === undefined) return fail('INVALID_ARGUMENTS', 'usage: x402 pay <url> [options]');
    const result = await guard.request('make-x402-request', payData(url, values));
    stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : `Request completed (HTTP ${result?.status})\n${typeof result?.data === 'string' ? result.data : JSON.stringify(result?.data ?? null, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof BudgetRefused) return fail('BUDGET_REFUSED', `walletcap refused this payment: ${error.message}`);
    return fail('REQUEST_FAILED', String(error?.message ?? error));
  } finally {
    guard.budget.close();
  }
}

// ---------------------------------------------------------------------------------------------
// npx walletcap awal-mcp [--wallet <address>] [--path <file>] [--allow-tool <name>]... [-- <server command>]:
// Coinbase's Agentic Wallet MCP server behind a proxy that counts its send and
// make_http_request_with_x402 calls, and refuses every tool it does not know.

const MCP_PAYMENT_TOOLS = { make_http_request_with_x402: 'make-x402-request', send: 'send-transaction' };

/**
 * The server's tools that move no money (payments-mcp 2.12.2), passed through as they are. Any
 * other tool, `trade` included, is refused unless the wallet's owner names it with --allow-tool:
 * a tool walletcap does not know may move money it cannot count.
 */
export const MCP_PASS_THROUGH_TOOLS = Object.freeze([
  'bazaar_get_resource_details', 'bazaar_list', 'bazaar_search', 'check_session_status',
  'get_wallet_address', 'get_wallet_balance', 'show_wallet_app', 'sign_in_with_email',
  'verify_email_otp', 'x402_discover_payment_requirements',
]);

/**
 * Where Coinbase's server runs from. `npx @coinbase/payments-mcp` is its installer, not the
 * server: it downloads the server to ~/.payments-mcp, and MCP clients run bundle.js with node.
 */
export const paymentsMcpServer = (home = homedir()) => [process.execPath, join(home, '.payments-mcp', 'bundle.js')];

const toolResult = raw => {
  const text = raw?.content?.find(item => item?.type === 'text')?.text;
  if (raw?.isError) throw new Error(text ?? 'the wallet reported an error');
  if (text === undefined) return raw;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && 'result' in parsed ? parsed.result : parsed;
  } catch {
    return { text };
  }
};

/**
 * Proxy an MCP client (stdin/stdout) to Coinbase's Agentic Wallet MCP server. Payments are
 * counted, the tools in MCP_PASS_THROUGH_TOOLS and --allow-tool pass through, and every other
 * tool is refused and left out of tools/list. Resolves with the server's exit code.
 */
export async function awalMcpMain(argv, { env = process.env, input = process.stdin, output = process.stdout, stderr = process.stderr, home } = {}) {
  const split = argv.indexOf('--');
  const own = split < 0 ? argv : argv.slice(0, split);
  const { values } = parseArgs({
    args: own,
    options: { wallet: { type: 'string' }, path: { type: 'string' }, 'allow-tool': { type: 'string', multiple: true } },
    strict: true,
  });
  const server = split < 0 ? paymentsMcpServer(home) : argv.slice(split + 1);
  if (server.length === 0) {
    stderr.write('walletcap: give the MCP server command after --\n');
    return 2;
  }
  if (split < 0 && !existsSync(server[1])) {
    stderr.write(`walletcap: Coinbase's Agentic Wallet MCP server is not installed at ${server[1]}. `
      + 'Install it once with: npx @coinbase/payments-mcp install --client other --no-auto-config '
      + '(or give walletcap the server command after --)\n');
    return 1;
  }
  const passed = new Set([...MCP_PASS_THROUGH_TOOLS, ...(values['allow-tool'] ?? [])]);
  const offered = name => Object.hasOwn(MCP_PAYMENT_TOOLS, name) || passed.has(name);
  const child = spawn(server[0], server.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], env });
  const write = (stream, message) => stream.write(`${JSON.stringify(message)}\n`);
  const pending = new Map();
  const listing = new Set(); // the client's tools/list requests, whose answers are filtered
  const callTool = (name, args) => new Promise((resolveCall, rejectCall) => {
    const id = `walletcap-${randomUUID()}`;
    pending.set(id, { resolve: resolveCall, reject: rejectCall });
    write(child.stdin, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  });

  createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { output.write(`${line}\n`); return; }
    const waiting = pending.get(message?.id);
    if (waiting !== undefined) {
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else waiting.resolve(message.result);
      return;
    }
    const key = message?.id === undefined ? undefined : JSON.stringify(message.id);
    if (key !== undefined && listing.delete(key) && Array.isArray(message.result?.tools)) {
      write(output, { ...message, result: { ...message.result, tools: message.result.tools.filter(tool => offered(tool?.name)) } });
      return;
    }
    output.write(`${line}\n`);
  });

  // The guard talks to the wallet through the server's own tools, one guard per call so concurrent
  // calls keep their own answers; the agent gets the server's own answer back, or the refusal.
  const TOOL_OF = { ...Object.fromEntries(Object.entries(MCP_PAYMENT_TOOLS).map(([tool, channel]) => [channel, tool])), 'get-wallet-address': 'get_wallet_address' };
  let budget;
  const budgetOf = async () => {
    if (budget === undefined) {
      const opened = await openGuard({
        ...env,
        ...(values.wallet ? { WALLETCAP_WALLET: values.wallet } : {}),
        ...(values.path ? { WALLETCAP_PATH: values.path } : {}),
      }, async (channel, data) => toolResult(await callTool(TOOL_OF[channel], data)));
      budget = opened.budget;
    }
    return budget;
  };

  const handle = async message => {
    let raw;
    try {
      const guard = guardAgenticWallet(await budgetOf(), {
        request: async (channel, data) => {
          raw = await callTool(TOOL_OF[channel], data);
          return toolResult(raw);
        },
      });
      await guard.request(MCP_PAYMENT_TOOLS[message.params.name], message.params.arguments ?? {});
      write(output, { jsonrpc: '2.0', id: message.id, result: raw });
    } catch (error) {
      const result = raw === undefined
        ? { content: [{ type: 'text', text: `walletcap refused this payment: ${error.message}` }], isError: true }
        : raw;
      write(output, { jsonrpc: '2.0', id: message.id, result });
    }
  };

  createInterface({ input }).on('line', line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      stderr.write('walletcap: dropped a line from the MCP client that is not JSON\n');
      return;
    }
    if (Array.isArray(message)) {
      // A batch would carry calls past the checks below; MCP dropped batches in 2025-06-18.
      write(output, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'walletcap does not forward JSON-RPC batches' } });
      return;
    }
    if (message?.method === 'tools/call') {
      const name = String(message.params?.name);
      if (Object.hasOwn(MCP_PAYMENT_TOOLS, name)) {
        handle(message).catch(error => stderr.write(`walletcap: ${error.message}\n`));
        return;
      }
      if (!passed.has(name)) {
        write(output, {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: `walletcap refused ${name}: it can't tell whether this tool moves money, so it can't count it. `
              + `The wallet's owner can let it through, uncounted, with --allow-tool ${name}` }],
            isError: true,
          },
        });
        return;
      }
    }
    if (message?.method === 'tools/list' && message.id !== undefined && message.id !== null) listing.add(JSON.stringify(message.id));
    child.stdin.write(`${line}\n`);
  }).on('close', () => child.stdin.end());

  return new Promise(resolveExit => child.on('exit', code => {
    budget?.close();
    resolveExit(code ?? 1);
  }));
}
