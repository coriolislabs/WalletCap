// SPDX-License-Identifier: Apache-2.0
// walletcap-mcp: Coinbase's Agentic Wallet MCP server behind walletcap's budget. The MCP server
// is a stand-in (support/fake-payments-mcp.mjs); the payee is a local HTTP server that answers
// 402 like an x402 one.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { openBudget } from 'walletcap';

const MCP = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const FAKE_MCP = fileURLToPath(new URL('./support/fake-payments-mcp.mjs', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'walletcap-mcp-'));
const WALLET = '0xd797ead28C38575FDf4fC523866287372340Ca02';
const PAY_TO = '0x0773A0A3ec5F88162EA52470B7973b2cfAaA846A';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64');
const requirement = (amount = '50000', ttl = 300, asset = USDC) => ({
  scheme: 'exact', network: 'eip155:84532', asset, amount, payTo: PAY_TO, maxTimeoutSeconds: ttl, extra: { name: 'USDC', version: '2' },
});

const EXTENSIONS = { bazaar: { discoverable: true } };

// A payee: GET /pay?amount=&ttl=&asset= answers 402 with those terms; /free answers 200.
let server;
let base;
before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/free') { res.end('{}'); return; }
    const offered = requirement(url.searchParams.get('amount') ?? '50000', Number(url.searchParams.get('ttl') ?? 300), url.searchParams.get('asset') ?? USDC);
    res.writeHead(402, { 'PAYMENT-REQUIRED': b64({ x402Version: 2, resource: { url: req.url }, accepts: [offered], extensions: EXTENSIONS }) });
    res.end('{}');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.closeAllConnections();
  server?.close();
  // Windows keeps a budget file a test left open; its temp folder is cleared later.
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* open on Windows */ }
});


// The wallet's request channel: records each request, answers per `answer`.

test('walletcap-mcp: the MCP server answers, and payments past the cap never reach it', async () => {
  const path = join(DIR, 'mcp.sqlite');
  const log = join(DIR, 'mcp.log');
  writeFileSync(log, '');
  (await openBudget({ wallet: WALLET, path, perPayment: '$0.05', perDay: '$0.15', create: true })).close();
  const proxy = spawn(process.execPath, [MCP, '--wallet', WALLET, '--path', path, '--', process.execPath, FAKE_MCP], {
    env: { ...process.env, FAKE_MCP_LOG: log }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const replies = new Map();
  createInterface({ input: proxy.stdout }).on('line', line => { const m = JSON.parse(line); replies.set(m.id, m); });
  const ask = async (id, method, params) => {
    proxy.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (let i = 0; i < 200 && !replies.has(id); i += 1) await new Promise(done => setTimeout(done, 25));
    assert.ok(replies.has(id), `no reply to ${method}`);
    return replies.get(id).result;
  };
  try {
    assert.equal((await ask(1, 'initialize', {})).serverInfo.name, 'payments-mcp');
    // The server also offers trade and a tool walletcap has never seen: neither is listed.
    assert.deepEqual((await ask(2, 'tools/list', {})).tools.map(t => t.name), ['make_http_request_with_x402', 'send', 'get_wallet_balance']);
    const pay = { baseURL: base, path: '/pay?ttl=300', method: 'GET' };
    const results = [];
    for (let id = 3; id < 7; id += 1) results.push(await ask(id, 'tools/call', { name: 'make_http_request_with_x402', arguments: pay }));
    assert.deepEqual(results.map(r => r.isError === true), [false, false, false, true]);
    assert.match(results[3].content[0].text, /walletcap refused this payment/);
    const sent = await ask(7, 'tools/call', { name: 'send', arguments: { recipient: PAY_TO, amountAtomic: '50000', chain: 'base-sepolia' } });
    assert.equal(sent.isError, true);
    assert.equal((await ask(8, 'tools/call', { name: 'get_wallet_balance', arguments: {} })).content.length, 1);
    // A tool walletcap can't count is refused before it reaches the wallet.
    for (const [id, name] of [[9, 'trade'], [10, 'drain_wallet']]) {
      const refused = await ask(id, 'tools/call', { name, arguments: { amount: '1000' } });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, new RegExp(`walletcap refused ${name}.*--allow-tool ${name}`));
    }
  } finally {
    proxy.stdin.end();
    await new Promise(done => proxy.on('exit', done));
  }
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(c => c.name), ['make_http_request_with_x402', 'make_http_request_with_x402', 'make_http_request_with_x402', 'get_wallet_balance']);
  assert.equal(calls[0].arguments.maxAmountPerRequest, 50_000);
  assert.deepEqual(calls[0].arguments.paymentRequirements, [requirement('50000', 300)]);
  const budget = await openBudget({ wallet: WALLET, path, create: false });
  assert.equal((await budget.status()).spent, 150_000n);
  budget.close();
});

// Drive walletcap-mcp over stdio: send lines, collect answers by id.
const mcpProxy = (args, env) => {
  const proxy = spawn(process.execPath, [MCP, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  let stderr = '';
  proxy.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: proxy.stdout }).on('line', line => { const m = JSON.parse(line); replies.set(m.id, m); });
  const send = line => proxy.stdin.write(`${line}\n`);
  const reply = async id => {
    for (let i = 0; i < 200 && !replies.has(id); i += 1) await new Promise(done => setTimeout(done, 25));
    assert.ok(replies.has(id), `no reply to ${id}; stderr: ${stderr}`);
    return replies.get(id);
  };
  const ask = async (id, method, params) => {
    send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return (await reply(id)).result;
  };
  const close = async () => {
    proxy.stdin.end();
    return new Promise(done => proxy.on('exit', code => done({ code, stderr })));
  };
  return { ask, send, reply, close };
};

test("the agent is told why a payment was refused, not which holds its owner could void", async () => {
  const path = join(DIR, 'mcp-holds.sqlite');
  const log = join(DIR, 'mcp-holds.log');
  writeFileSync(log, '');
  const budget = await openBudget({ wallet: WALLET, path, perDay: '$0.15', create: true });
  for (let i = 0; i < 3; i += 1) await (await budget.hold('$0.05')).note('unknown');
  // The owner's own check names the holds and how to void them.
  assert.match((await budget.check('$0.05')).message, /3 open payments \(wc-\w+, wc-\w+, wc-\w+; walletcap holds lists them, and if one never left the wallet its owner can void it\)$/);
  budget.close();
  // 0.3.0 passed all of it to the agent through the MCP server.
  const { ask, close } = mcpProxy(['--wallet', WALLET, '--path', path, '--', process.execPath, FAKE_MCP], { FAKE_MCP_LOG: log });
  let refused;
  try {
    refused = await ask(1, 'tools/call', { name: 'make_http_request_with_x402', arguments: { baseURL: base, path: '/pay?ttl=300', method: 'GET' } });
  } finally {
    await close();
  }
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, 'walletcap refused this payment: $0.05 would bring 0xd797…ca02 to $0.20 in the last 24h, '
    + 'over its $0.15 limit ($0.00 left); $0.15 of it is 3 open payments');
});

test('walletcap-mcp runs the server Coinbase installed, not its installer', async () => {
  const home = mkdtempSync(join(DIR, 'home-'));
  const path = join(DIR, 'mcp-default.sqlite');
  const log = join(DIR, 'mcp-default.log');
  writeFileSync(log, '');
  (await openBudget({ wallet: WALLET, path, perPayment: '$0.05', perDay: '$0.15', create: true })).close();
  const env = { HOME: home, USERPROFILE: home, FAKE_MCP_LOG: log };

  // Before Coinbase's installer has run, there is no server to start: say so, start nothing.
  const missing = await mcpProxy(['--wallet', WALLET, '--path', path], env).close();
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /npx @coinbase\/payments-mcp install/);

  // The installer leaves ~/.payments-mcp/bundle.js, an ES module MCP clients run with node.
  mkdirSync(join(home, '.payments-mcp'));
  writeFileSync(join(home, '.payments-mcp', 'package.json'), '{"type":"module"}');
  writeFileSync(join(home, '.payments-mcp', 'bundle.js'), `import ${JSON.stringify(pathToFileURL(FAKE_MCP).href)};\n`);
  const mcp = mcpProxy(['--wallet', WALLET, '--path', path, '--allow-tool', 'trade'], env);
  try {
    assert.equal((await mcp.ask(1, 'initialize', {})).serverInfo.name, 'payments-mcp');
    // --allow-tool lets trade through, uncounted; a tool nobody named stays out.
    assert.deepEqual((await mcp.ask(2, 'tools/list', {})).tools.map(t => t.name), ['make_http_request_with_x402', 'send', 'get_wallet_balance', 'trade']);
    assert.notEqual((await mcp.ask(3, 'tools/call', { name: 'trade', arguments: {} })).isError, true);
    assert.equal((await mcp.ask(4, 'tools/call', { name: 'drain_wallet', arguments: {} })).isError, true);
    // A JSON-RPC batch could carry a call past those checks, so it is refused whole.
    mcp.send(JSON.stringify([{ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'drain_wallet', arguments: {} } }]));
    assert.equal((await mcp.reply(null)).error.code, -32600);
  } finally {
    await mcp.close();
  }
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).name), ['trade']);
});
