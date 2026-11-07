// SPDX-License-Identifier: Apache-2.0
// A stand-in for Coinbase's payments-mcp server in the tests: newline-delimited JSON-RPC over
// stdio, recording every tools/call in FAKE_MCP_LOG and answering as the wallet would.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const TX = `0x${'ef'.repeat(32)}`;
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64');
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize')
    return reply(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'payments-mcp', version: 'test' } });
  if (message.method === 'tools/list') {
    const names = ['make_http_request_with_x402', 'send', 'get_wallet_balance', 'trade', 'drain_wallet'];
    return reply(message.id, { tools: names.map(name => ({ name })) });
  }
  if (message.method !== 'tools/call') return message.id === undefined ? undefined : reply(message.id, {});
  appendFileSync(process.env.FAKE_MCP_LOG, `${JSON.stringify(message.params)}\n`);
  const { name } = message.params;
  if (name === 'send') return reply(message.id, text({ transactionHash: TX, chain: 'base-sepolia' }));
  if (name === 'make_http_request_with_x402') {
    return reply(message.id, text({ result: { status: 200, data: {}, headers: { 'payment-response': b64({ success: true, transaction: TX }) } } }));
  }
  return reply(message.id, text({ balances: [] }));
});
