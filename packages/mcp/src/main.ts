#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// walletcap-mcp: Coinbase's Agentic Wallet MCP server behind the wallet's walletcap budget.
import { proxy } from './proxy.js';

const HELP = `walletcap-mcp: Coinbase's payments MCP server, with every payment counted in the wallet's walletcap budget.

Usage: npx walletcap-mcp --wallet <address> [--path <file>] [--allow-tool <name>]... [-- <server command>]

  --wallet <address>   The agent wallet. Its owner creates the budget first:
                       npx walletcap set --wallet <address> --per-payment 0.05 --per-day 0.15
  --path <file>        The budget file, when it isn't the default per-user file
  --allow-tool <name>  Let one more of the server's tools through, uncounted
  -- <server command>  Run this MCP server instead of ~/.payments-mcp/bundle.js

send and make_http_request_with_x402 are checked against the budget before the wallet signs, and
counted. Tools that move no money pass through. Every other tool is refused and left out of
tools/list, and a request whose method isn't one of MCP's own never reaches the server.`;

const argv = process.argv.slice(2);
const own = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
if (own.includes('--help') || own.includes('-h')) {
  process.stdout.write(`${HELP}\n`);
} else {
  process.exitCode = await proxy(argv);
}
