// SPDX-License-Identifier: Apache-2.0
// The AgentKit row. Coinbase AgentKit's x402 action pays a merchant whose 402 answer lists two
// offers: $1.00 on Base mainnet to another address first, then the 1¢ test offer on Base Sepolia.
// The agent approves the 1¢ offer and hands it to retry_http_request_with_x402, as AgentKit's own
// flow asks. The merchant runs on 127.0.0.1 and records what it is paid with; nothing else is reached.
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ViemWalletProvider, X402ActionProvider } from '@coinbase/agentkit';
import { createWalletClient, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { openBudget } from 'walletcap';
import { guardAgentKit } from 'walletcap/agentkit';

// Nothing leaves this machine: the only reachable address is the local merchant.
const localFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input?.url ?? input);
  if (!url.startsWith('http://127.0.0.1:')) throw new Error(`the crash test blocked a request to ${url}`);
  return localFetch(input, init);
};

// AgentKit's wallet providers send an analytics event with the wallet's address when they are
// created (dist/wallet-providers/walletProvider.js). It is turned off here so nothing is sent.
class OfflineViemWalletProvider extends ViemWalletProvider {
  trackInitialization() {}
}

const mode = process.argv[2];
const stranger = privateKeyToAccount(generatePrivateKey()).address;
const merchant = privateKeyToAccount(generatePrivateKey()).address;
const offers = [
  { scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '1000000', payTo: stranger, maxTimeoutSeconds: 345_600, extra: { name: 'USD Coin', version: '2' } },
  { scheme: 'exact', network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', amount: '10000', payTo: merchant, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } },
];
const approved = offers[1];
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const isApproved = accepted => accepted?.network === approved.network && same(accepted?.asset, approved.asset)
  && accepted?.amount === approved.amount && same(accepted?.payTo, approved.payTo);

const received = [];
const server = createServer((req, res) => {
  const header = req.headers['payment-signature'] ?? req.headers['x-payment'];
  if (!header) {
    const required = { x402Version: 2, resource: { url: req.url, description: 'crash-test report', mimeType: 'application/json' }, accepts: offers };
    res.writeHead(402, { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64'), 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  const payload = JSON.parse(Buffer.from(String(header), 'base64').toString());
  received.push({
    network: payload.accepted?.network,
    amount: payload.accepted?.amount,
    toStranger: payload.accepted?.payTo === stranger,
    approved: isApproved(payload.accepted),
    validForSeconds: Number(payload.payload?.authorization?.validBefore) - Math.floor(Date.now() / 1000),
  });
  const settled = { success: true, transaction: `0x${'ab'.repeat(32)}`, network: payload.accepted?.network };
  res.writeHead(200, { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify(settled)).toString('base64'), 'content-type': 'application/json' });
  res.end('{"report":"delivered"}');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));

const account = privateKeyToAccount(generatePrivateKey());
// The wallet is on Base Sepolia, where the approved offer is. No RPC is reached: signing is local.
const walletProvider = new OfflineViemWalletProvider(createWalletClient({ account, chain: baseSepolia, transport: http('http://127.0.0.1:9') }));
let provider = new X402ActionProvider();
let dir;
if (mode === 'walletcap') {
  dir = mkdtempSync(join(tmpdir(), 'walletcap-crash-agentkit-'));
  const budget = await openBudget({ wallet: account.address, path: join(dir, 'budget.sqlite'), perPayment: '$0.02', perDay: '$1', create: true });
  provider = guardAgentKit(provider, budget);
}

const url = `http://127.0.0.1:${server.address().port}/report`;
const answer = JSON.parse(await provider.retryWithX402(walletProvider, { url, method: 'GET', selectedPaymentOption: approved }));
server.close();
if (dir) rmSync(dir, { recursive: true, force: true });

process.stdout.write(`RESULT ${JSON.stringify({
  mode,
  approved: { network: approved.network, amount: approved.amount },
  reported: answer.details?.paymentUsed ?? null,
  refused: answer.error === true || answer.status === 'error',
  received,
})}\n`);
