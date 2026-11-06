// SPDX-License-Identifier: Apache-2.0
// The budget in front of Coinbase's Agentic Wallet. The wallet's request channel and its MCP
// server are stand-ins here; the payee is a local HTTP server that answers 402 like an x402 one.
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { BudgetRefused, openBudget } from '../index.mjs';
import { guardAgenticWallet, usdcAtomic } from '../agentic.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const FAKE_AWAL = fileURLToPath(new URL('./support/fake-awal', import.meta.url));
const FAKE_MCP = fileURLToPath(new URL('./support/fake-payments-mcp.mjs', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'walletcap-awal-'));
const WALLET = '0xd797ead28C38575FDf4fC523866287372340Ca02';
const PAY_TO = '0x0773A0A3ec5F88162EA52470B7973b2cfAaA846A';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TX = `0x${'cd'.repeat(32)}`;
const DAY = 86_400_000;
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64');
const requirement = (amount = '50000', ttl = 300, asset = USDC) => ({
  scheme: 'exact', network: 'eip155:84532', asset, amount, payTo: PAY_TO, maxTimeoutSeconds: ttl, extra: { name: 'USDC', version: '2' },
});

// A payee: GET /pay?amount=&ttl=&asset= answers 402 with those terms; /free answers 200.
let server;
let base;
before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/free') { res.end('{}'); return; }
    const offered = requirement(url.searchParams.get('amount') ?? '50000', Number(url.searchParams.get('ttl') ?? 300), url.searchParams.get('asset') ?? USDC);
    res.writeHead(402, { 'PAYMENT-REQUIRED': b64({ x402Version: 2, resource: { url: req.url }, accepts: [offered] }) });
    res.end('{}');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.closeAllConnections();
  server?.close();
  rmSync(DIR, { recursive: true, force: true });
});

let files = 0;
const newBudget = (clock = { now: Date.now() }, path = join(DIR, `b${files++}.sqlite`)) => {
  const budget = openBudget({ wallet: WALLET, path, clock: () => clock.now, perPayment: '$0.05', perDay: '$0.15', create: true });
  return { budget, clock, path };
};

// The wallet's request channel: records each request, answers per `answer`.
const wallet = (answer = () => ({ status: 200, headers: { 'PAYMENT-RESPONSE': b64({ success: true, transaction: TX }) } })) => {
  const calls = [];
  return { calls, request: async (channel, data) => { calls.push({ channel, data }); return answer(channel, data); } };
};
const x402 = (query = '') => ({ baseURL: base, path: `/pay${query}`, method: 'GET' });
const refused = reason => error => error instanceof BudgetRefused && error.reason === reason;

test("sends count in the wallet's budget, and the one past the cap never reaches the wallet", async () => {
  const { budget } = newBudget();
  const w = wallet(() => ({ transactionHash: TX }));
  const guard = guardAgenticWallet(budget, { request: w.request });
  for (let i = 0; i < 3; i += 1) await guard.request('send-transaction', { recipient: PAY_TO, amountAtomic: '50000', asset: 'USDC', chain: 'base-sepolia' });
  await assert.rejects(guard.request('send-transaction', { recipient: PAY_TO, amountAtomic: '50000', chain: 'base-sepolia' }), refused('budget'));
  await assert.rejects(guard.request('send-transaction', { recipient: PAY_TO, amountAtomic: '1000000', chain: 'base-sepolia' }), refused('per_payment'));
  await assert.rejects(guard.request('send-transaction', { recipient: PAY_TO, amountAtomic: '1', asset: 'ETH', chain: 'base' }), refused('asset'));
  assert.equal(w.calls.length, 3);
  assert.equal(budget.status().spent, 150_000n);
  assert.equal(budget.history()[0].tx, TX);
});

test('the wallet is capped at exactly the price walletcap checked', async () => {
  const { budget } = newBudget();
  const w = wallet();
  const guard = guardAgenticWallet(budget, { request: w.request });
  await guard.request('make-x402-request', x402('?ttl=300'));
  const [{ channel, data }] = w.calls;
  assert.equal(channel, 'make-x402-request');
  assert.equal(data.paymentRequirements, undefined);
  assert.equal(data.maxAmountPerRequest, 50_000);
  assert.equal(budget.status().spent, 50_000n);
  assert.deepEqual([budget.history()[0].status, budget.history()[0].tx, budget.history()[0].rail], ['settled', TX, 'awal-x402']);
});

test('a payee that holds 7-day authorizations collects at most the cap, restarts included', async () => {
  const clock = { now: Date.now() };
  const { path } = newBudget(clock);
  const hold = () => ({ status: 200, headers: { 'PAYMENT-RESPONSE': b64({ success: true, transaction: '' }) } });
  // Three wallet sessions, each a fresh process: the budget file is all they share.
  let signed = 0;
  for (let session = 0; session < 3; session += 1) {
    const { budget } = newBudget(clock, path);
    const guard = guardAgenticWallet(budget, { request: wallet(hold).request });
    for (let i = 0; i < 4; i += 1) {
      try { await guard.request('make-x402-request', x402('?ttl=604800')); signed += 1; } catch (error) { assert.ok(refused('budget')(error), error); }
    }
    budget.close();
  }
  assert.equal(signed, 3);
  const { budget } = newBudget(clock, path);
  assert.equal(budget.status().inFlight, 150_000n);
  // Unconfirmed, they count until the owner releases them, whatever validity the payee asked for.
  clock.now += 30 * DAY;
  assert.equal(budget.status().inFlight, 150_000n);
  assert.deepEqual(budget.history().map(row => row.status), ['unknown', 'unknown', 'unknown']);
});

test("the wallet's own refusal before signing gives the amount back; a payee's refusal after it does not", async () => {
  const { budget } = newBudget();
  const exceed = guardAgenticWallet(budget, { request: wallet(() => { throw new Error('x402 request failed: Required payment $0.05 exceeds remaining session limit of $0.00 (spent $0.00, pending $0.15 of $0.15).'); }).request });
  await assert.rejects(exceed.request('make-x402-request', x402()), /exceeds remaining session limit/);
  assert.equal(budget.status().inFlight, 0n);
  const reject = guardAgenticWallet(budget, { request: wallet(() => { throw new Error('X402 submission failed: Payment was authorized but rejected by server'); }).request });
  await assert.rejects(reject.request('make-x402-request', x402()), /rejected by server/);
  assert.equal(budget.status().inFlight, 50_000n);
  // A payee can't echo the wallet's wording to get its signature forgotten.
  const echo = guardAgenticWallet(budget, { request: wallet(() => { throw new Error('X402 submission failed: Required payment $0.05 exceeds remaining session limit'); }).request });
  await assert.rejects(echo.request('make-x402-request', x402()));
  assert.equal(budget.status().inFlight, 100_000n);
});

test('assets walletcap cannot price are refused before the wallet is asked', async () => {
  const { budget } = newBudget();
  const w = wallet();
  const guard = guardAgenticWallet(budget, { request: w.request });
  await assert.rejects(guard.request('make-x402-request', x402('?asset=0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf')), refused('asset'));
  await assert.rejects(guard.request('make-x402-request', x402('?amount=1000000')), refused('per_payment'));
  assert.equal(w.calls.length, 0);
});

test('two machines on one budget share one cap', async () => {
  const { path } = newBudget();
  const a = guardAgenticWallet(newBudget(undefined, path).budget, { request: wallet().request });
  const b = guardAgenticWallet(newBudget(undefined, path).budget, { request: wallet().request });
  let paid = 0;
  for (const machine of [a, b, a, b, a, b, a, b]) {
    try { await machine.request('make-x402-request', x402()); paid += 1; } catch (error) { assert.ok(refused('budget')(error)); }
  }
  assert.equal(paid, 3);
});

test("a free endpoint goes through with the wallet's smallest payment cap, and nothing is counted", async () => {
  const { budget } = newBudget();
  const w = wallet(() => ({ status: 200, headers: {} }));
  await guardAgenticWallet(budget, { request: w.request }).request('make-x402-request', { baseURL: base, path: '/free', method: 'GET' });
  assert.equal(w.calls[0].data.maxAmountPerRequest, 1);
  assert.deepEqual([budget.status().spent, budget.status().inFlight], [0n, 0n]);
});

test("awal's amount rule: dollars, or atomic units above 100", () => {
  assert.equal(usdcAtomic('$0.05'), '50000');
  assert.equal(usdcAtomic('0.05'), '50000');
  assert.equal(usdcAtomic('1'), '1000000');
  assert.equal(usdcAtomic('50000'), '50000');
});

// Async: the CLI asks this process's payee for its terms, so the test must keep serving meanwhile.
const awal = (path, log, mode, ...args) => new Promise(done => execFile(process.execPath, [CLI, 'awal', ...args], {
  env: { ...process.env, WALLETCAP_PATH: path, WALLETCAP_AWAL: FAKE_AWAL, FAKE_AWAL_LOG: log, FAKE_AWAL_MODE: mode },
  encoding: 'utf8',
}, (error, stdout, stderr) => done({ status: error ? error.code : 0, stdout, stderr })));

test('npx walletcap awal: payments are counted, everything else is awal', async () => {
  const path = join(DIR, 'cli.sqlite');
  const log = join(DIR, 'cli.log');
  writeFileSync(log, '');
  const set = spawnSync(process.execPath, [CLI, 'set', '--wallet', WALLET, '--per-day', '0.15', '--per-payment', '0.05'], { env: { ...process.env, WALLETCAP_PATH: path }, encoding: 'utf8' });
  assert.equal(set.status, 0, set.stderr);
  const results = [];
  for (let i = 0; i < 4; i += 1) results.push(await awal(path, log, 'settle', 'x402', 'pay', `${base}/pay?ttl=300`, '--json'));
  assert.deepEqual(results.map(r => r.status), [0, 0, 0, 1]);
  assert.equal(JSON.parse(results[3].stdout).error.code, 'BUDGET_REFUSED');
  const send = await awal(path, log, 'settle', 'send', '0.05', PAY_TO, '--chain', 'base-sepolia', '--json');
  assert.equal(send.status, 1);
  assert.match(JSON.parse(send.stdout).error.message, /walletcap refused/);
  const passthrough = await awal(path, log, 'settle', 'status', '--json');
  assert.equal(passthrough.stdout.trim(), 'awal status --json');
  const asked = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).channel);
  assert.deepEqual(asked, ['get-wallet-address', 'make-x402-request', 'get-wallet-address', 'make-x402-request', 'get-wallet-address', 'make-x402-request', 'get-wallet-address', 'get-wallet-address']);
});

test('npx walletcap awal-mcp: the MCP server answers, and payments past the cap never reach it', async () => {
  const path = join(DIR, 'mcp.sqlite');
  const log = join(DIR, 'mcp.log');
  writeFileSync(log, '');
  openBudget({ wallet: WALLET, path, perPayment: '$0.05', perDay: '$0.15', create: true }).close();
  const proxy = spawn(process.execPath, [CLI, 'awal-mcp', '--wallet', WALLET, '--path', path, '--', process.execPath, FAKE_MCP], {
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
  const budget = openBudget({ wallet: WALLET, path, create: false });
  assert.equal(budget.status().spent, 150_000n);
  budget.close();
});

// Drive `npx walletcap awal-mcp` over stdio: send lines, collect answers by id.
const mcpProxy = (args, env) => {
  const proxy = spawn(process.execPath, [CLI, 'awal-mcp', ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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

test('npx walletcap awal-mcp runs the server Coinbase installed, not its installer', async () => {
  const home = mkdtempSync(join(DIR, 'home-'));
  const path = join(DIR, 'mcp-default.sqlite');
  const log = join(DIR, 'mcp-default.log');
  writeFileSync(log, '');
  openBudget({ wallet: WALLET, path, perPayment: '$0.05', perDay: '$0.15', create: true }).close();
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
