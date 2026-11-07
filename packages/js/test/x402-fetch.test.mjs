// SPDX-License-Identifier: Apache-2.0
// The whole x402 flow over HTTP: @x402/fetch with a guarded client against a
// loopback server that answers 402, then settles (or refuses) the payment.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openBudget } from 'walletcap';
import { guard } from 'walletcap/x402';
import { NETWORK, PAY_TO, USDC, x402 } from './support/x402-kit.mjs';

const kit = await x402();
let fetchKit = null;
try {
  fetchKit = { ...(await import('@x402/fetch')), ...(await import('@x402/core/http')) };
} catch {
  fetchKit = null;
}
const DIR = mkdtempSync(join(tmpdir(), 'walletcap-fetch-'));
// Windows keeps a budget file a test left open; its temp folder is cleared later.
after(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* open on Windows */ } });
const TX = `0x${'cd'.repeat(32)}`;

test('a guarded @x402/fetch pays, keeps counting what the payee refused, and stops at the cap', {
  skip: (kit === null || fetchKit === null) && '@x402/fetch and the x402 devDependencies are not installed',
}, async () => {
  let answer = 'settle';
  const server = createServer((request, response) => {
    const required = {
      x402Version: 2,
      resource: { url: `http://127.0.0.1${request.url}`, description: 'paid', mimeType: 'text/plain' },
      accepts: [{ scheme: 'exact', network: NETWORK, asset: USDC, amount: '50000', payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } }],
    };
    if (!request.headers['payment-signature'] || answer === 'refuse') {
      response.writeHead(402, { 'PAYMENT-REQUIRED': fetchKit.encodePaymentRequiredHeader(required) });
      response.end();
      return;
    }
    response.writeHead(200, { 'PAYMENT-RESPONSE': fetchKit.encodePaymentResponseHeader({ success: true, transaction: TX, network: NETWORK, payer: kit.account.address }) });
    response.end('paid content');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/weather`;
    const budget = await openBudget({ wallet: kit.account.address, path: join(DIR, 'fetch.sqlite'), perPayment: '$0.05', perDay: '$0.15', create: true });
    const fetchPaid = fetchKit.wrapFetchWithPayment(fetch, guard(kit.client(), budget));
    for (const expected of [200, 200]) assert.equal((await fetchPaid(url)).status, expected);
    answer = 'refuse';
    assert.equal((await fetchPaid(url)).status, 402);
    answer = 'settle';
    // @x402/fetch rewraps errors from payment creation; the budget's reason survives in the message.
    await assert.rejects(fetchPaid(url), /Failed to create payment payload: \$0\.05 would bring .* over its \$0\.15 limit/);
    const status = await budget.status();
    assert.deepEqual([status.spent, status.inFlight], [100_000n, 50_000n]);
    assert.deepEqual((await budget.history()).map(entry => entry.status), ['refused', 'settled', 'settled']);
  } finally {
    server.close();
  }
});
