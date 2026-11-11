// SPDX-License-Identifier: Apache-2.0
// walletcap-mcp [--wallet <address>] [--path <file>] [--allow-tool <name>]... [-- <server command>]:
// Coinbase's Agentic Wallet MCP server behind a proxy that counts its send and
// make_http_request_with_x402 calls in the wallet's walletcap budget, and refuses every tool it
// does not know. It uses walletcap only through the package's public exports.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { type Budget, BudgetUnavailable, openBudget } from 'walletcap';
import { type GuardedWallet, guardAgenticWallet, type WalletRequest } from 'walletcap/agentic';

const messageOf = (error: unknown): string => String((error as Error | undefined)?.message ?? error);

const addressOf = (value: unknown): string | undefined => {
  const match = JSON.stringify(value ?? null).match(/0x[0-9a-fA-F]{40}/);
  return match === null ? undefined : match[0];
};

// The wallet's budget, opened by the address it was given, or the one the wallet reports.
async function openGuard(env: NodeJS.ProcessEnv, request: WalletRequest): Promise<GuardedWallet> {
  let wallet = env.WALLETCAP_WALLET;
  if (wallet === undefined) wallet = addressOf(await request('get-wallet-address', {}));
  if (wallet === undefined) throw new BudgetUnavailable('walletcap could not learn the wallet address; pass --wallet');
  const path = env.WALLETCAP_PATH;
  const budget: Budget = await openBudget({ wallet, ...(path === undefined ? {} : { path }), create: false });
  return guardAgenticWallet(budget, { request });
}

const MCP_PAYMENT_TOOLS: Readonly<Record<string, string>> = { make_http_request_with_x402: 'make-x402-request', send: 'send-transaction' };

/**
 * The server's tools that move no money (payments-mcp 2.12.2), passed through as they are. Any
 * other tool, `trade` included, is refused unless the wallet's owner names it with --allow-tool:
 * a tool walletcap does not know may move money it cannot count.
 */
export const MCP_PASS_THROUGH_TOOLS: readonly string[] = Object.freeze([
  'bazaar_get_resource_details',
  'bazaar_list',
  'bazaar_search',
  'check_session_status',
  'get_wallet_address',
  'get_wallet_balance',
  'show_wallet_app',
  'sign_in_with_email',
  'verify_email_otp',
  'x402_discover_payment_requirements',
]);

/**
 * The MCP methods a client's requests may name. `tools/call` is checked tool by tool; the rest
 * read. A request with any other method is answered "method not found" here and never reaches
 * the server: tools are refused unless known, and so are methods.
 */
export const MCP_METHODS: readonly string[] = Object.freeze([
  'initialize',
  'ping',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'resources/templates/list',
  'resources/subscribe',
  'resources/unsubscribe',
  'prompts/list',
  'prompts/get',
  'logging/setLevel',
  'completion/complete',
]);

/**
 * Where Coinbase's server runs from. `npx @coinbase/payments-mcp` is its installer, not the
 * server: it downloads the server to ~/.payments-mcp, and MCP clients run bundle.js with node.
 */
export const paymentsMcpServer = (home: string = homedir()): string[] => [process.execPath, join(home, '.payments-mcp', 'bundle.js')];

interface ToolResult {
  content?: { type?: string; text?: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

const toolResult = (raw: unknown): unknown => {
  const result = raw as ToolResult | null | undefined;
  const text = result?.content?.find(item => item?.type === 'text')?.text;
  if (result?.isError) throw new Error(text ?? 'the wallet reported an error');
  if (text === undefined) return raw;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && 'result' in parsed ? (parsed as { result: unknown }).result : parsed;
  } catch {
    return { text };
  }
};

interface JsonRpc {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: { name?: unknown; arguments?: Record<string, unknown> };
  result?: { tools?: { name?: unknown }[] } & Record<string, unknown>;
  error?: { message?: string };
}

/**
 * Proxy an MCP client (stdin/stdout) to Coinbase's Agentic Wallet MCP server. Payments are
 * counted, the tools in MCP_PASS_THROUGH_TOOLS and --allow-tool pass through, and every other
 * tool is refused and left out of tools/list. Resolves with the server's exit code.
 */
export async function proxy(
  argv: string[],
  {
    env = process.env,
    input = process.stdin,
    output = process.stdout,
    stderr = process.stderr,
    home,
  }: {
    env?: NodeJS.ProcessEnv;
    input?: Readable;
    output?: Writable;
    stderr?: Writable;
    home?: string;
  } = {},
): Promise<number> {
  const split = argv.indexOf('--');
  const own = split < 0 ? argv : argv.slice(0, split);
  const { values } = parseArgs({
    args: own,
    options: { wallet: { type: 'string' }, path: { type: 'string' }, 'allow-tool': { type: 'string', multiple: true } },
    strict: true,
  });
  const server = split < 0 ? paymentsMcpServer(home) : argv.slice(split + 1);
  const [command, ...commandArgs] = server;
  if (command === undefined) {
    stderr.write('walletcap: give the MCP server command after --\n');
    return 2;
  }
  if (split < 0 && !existsSync(server[1] ?? '')) {
    stderr.write(
      `walletcap: Coinbase's Agentic Wallet MCP server is not installed at ${server[1]}. ` +
        'Install it once with: npx @coinbase/payments-mcp install --client other --no-auto-config ' +
        '(or give walletcap the server command after --)\n',
    );
    return 1;
  }
  const passed = new Set([...MCP_PASS_THROUGH_TOOLS, ...(values['allow-tool'] ?? [])]);
  const offered = (name: unknown): boolean => (typeof name === 'string' && Object.hasOwn(MCP_PAYMENT_TOOLS, name)) || passed.has(String(name));
  const child = spawn(command, commandArgs, { stdio: ['pipe', 'pipe', 'inherit'], env });
  const write = (stream: Writable, message: unknown): void => {
    stream.write(`${JSON.stringify(message)}\n`);
  };
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const callTool = (name: string | undefined, args: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolveCall, rejectCall) => {
      const id = `walletcap-${randomUUID()}`;
      pending.set(id, { resolve: resolveCall, reject: rejectCall });
      write(child.stdin, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    });

  createInterface({ input: child.stdout }).on('line', line => {
    let message: JsonRpc;
    try {
      message = JSON.parse(line) as JsonRpc;
    } catch {
      output.write(`${line}\n`);
      return;
    }
    const waiting = typeof message?.id === 'string' ? pending.get(message.id) : undefined;
    if (waiting !== undefined && typeof message.id === 'string') {
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else waiting.resolve(message.result);
      return;
    }
    // Any answer that lists tools is filtered, whatever id it answers: matching a tools/list by
    // its id let a second request with the same id, or one with a null id, show every tool.
    if (Array.isArray(message?.result?.tools)) {
      write(output, { ...message, result: { ...message.result, tools: message.result.tools.filter(tool => offered(tool?.name)) } });
      return;
    }
    output.write(`${line}\n`);
  });

  // The guard talks to the wallet through the server's own tools, one guard per call so
  // concurrent calls keep their own answers; the agent gets the server's own answer back, or
  // the refusal.
  const TOOL_OF: Readonly<Record<string, string>> = {
    ...Object.fromEntries(Object.entries(MCP_PAYMENT_TOOLS).map(([tool, channel]) => [channel, tool])),
    'get-wallet-address': 'get_wallet_address',
  };
  let budget: Budget | undefined;
  const budgetOf = async (): Promise<Budget> => {
    if (budget === undefined) {
      const opened = await openGuard(
        {
          ...env,
          ...(values.wallet ? { WALLETCAP_WALLET: values.wallet } : {}),
          ...(values.path ? { WALLETCAP_PATH: values.path } : {}),
        },
        async (channel, data) => toolResult(await callTool(TOOL_OF[channel], data)),
      );
      budget = opened.budget;
    }
    return budget;
  };

  const handle = async (message: JsonRpc): Promise<void> => {
    let raw: unknown;
    try {
      const guard = guardAgenticWallet(await budgetOf(), {
        request: async (channel, data) => {
          raw = await callTool(TOOL_OF[channel], data);
          return toolResult(raw);
        },
      });
      await guard.request(MCP_PAYMENT_TOOLS[String(message.params?.name)] ?? '', message.params?.arguments ?? {});
      write(output, { jsonrpc: '2.0', id: message.id, result: raw });
    } catch (error) {
      const result = raw === undefined ? { content: [{ type: 'text', text: `walletcap refused this payment: ${messageOf(error)}` }], isError: true } : raw;
      write(output, { jsonrpc: '2.0', id: message.id, result });
    }
  };

  createInterface({ input })
    .on('line', line => {
      let message: unknown;
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
      const rpc = message as JsonRpc;
      if (rpc?.method === 'tools/call') {
        const name = String(rpc.params?.name);
        if (Object.hasOwn(MCP_PAYMENT_TOOLS, name)) {
          handle(rpc).catch(error => stderr.write(`walletcap: ${messageOf(error)}\n`));
          return;
        }
        if (!passed.has(name)) {
          write(output, {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              content: [
                {
                  type: 'text',
                  text:
                    `walletcap refused ${name}: it can't tell whether this tool moves money, so it can't count it. ` +
                    `The wallet's owner can let it through, uncounted, with --allow-tool ${name}`,
                },
              ],
              isError: true,
            },
          });
          return;
        }
      }
      if (rpc === null || typeof rpc !== 'object') {
        write(output, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'walletcap forwards JSON-RPC objects only' } });
        return;
      }
      // A request names a method walletcap knows, or it stops here. A notification, or the
      // client's answer to a request of the server's own, has nothing of the client's to refuse.
      if (typeof rpc.method === 'string' && !rpc.method.startsWith('notifications/') && !MCP_METHODS.includes(rpc.method)) {
        if (rpc.id !== undefined) {
          write(output, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'walletcap does not forward that method to the wallet' } });
        }
        return;
      }
      // What was parsed and checked is what is sent, not the client's own line: a second "method"
      // or "name" key in it would be read here one way and, by another parser, another.
      write(child.stdin, rpc);
    })
    .on('close', () => child.stdin.end());

  return new Promise(resolveExit =>
    child.on('exit', code => {
      budget?.close();
      resolveExit(code ?? 1);
    }),
  );
}
