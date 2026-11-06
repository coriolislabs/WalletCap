// SPDX-License-Identifier: Apache-2.0
// One agent process. It builds an x402 client the way an app does, puts one spend control on it,
// tries its payments, and reports what it signed. Nothing is sent: each payment is an x402
// authorization signed offline, which a payee holding it could settle on Base until it expires.
import { existsSync, writeFileSync } from 'node:fs';
import { applySpendControls } from '@coinbase/cdp-sdk/x402';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { openBudget } from 'walletcap';
import { SharedSpendStore, withLatency } from './spend-store.mjs';

export const BASE = 'eip155:8453';
export const ASSETS = {
  USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', version: '2' },
  EURC: { address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', name: 'EURC', version: '2' },
};

// Coinbase's README example for spend controls, at this test's limits: $50 a payment and $150
// in any 24 hours, in USDC, on Base. Like the example, it sets no allowedAssets.
const cdpControls = () => ({
  maxAmountPerPayment: { atomic: 50_000_000n, asset: ASSETS.USDC.address },
  maxCumulativeSpend: { atomic: 150_000_000n, asset: ASSETS.USDC.address },
  maxCumulativeSpendWindow: '24h',
  allowedNetworks: [BASE],
});

// walletcap's README for CDP's controls, exactly: the same caps, USDC the only allowed asset, and
// CDP's ledger kept by budget.cdpStore() in the budget file every agent opens.
const cdpStoreControls = store => ({
  maxAmountPerPayment: { atomic: 50_000_000n, asset: ASSETS.USDC.address },
  maxCumulativeSpend: { atomic: 150_000_000n, asset: ASSETS.USDC.address },
  maxCumulativeSpendWindow: '24h',
  allowedAssets: [ASSETS.USDC.address],
  store,
});

const required = (payment, payTo) => {
  const asset = ASSETS[payment.asset];
  return {
    x402Version: 2,
    resource: { url: 'https://payee.example/report', description: 'crash-test resource', mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact', network: BASE, asset: asset.address, amount: payment.atomic, payTo,
      maxTimeoutSeconds: 300, extra: { name: asset.name, version: asset.version },
    }],
  };
};

const waitFor = async file => {
  const until = Date.now() + 60_000;
  while (!existsSync(file)) {
    if (Date.now() > until) throw new Error('the other replicas did not start');
    await new Promise(done => setTimeout(done, 2));
  }
};

const config = JSON.parse(process.argv[2]);
const account = privateKeyToAccount(config.key);
const client = new x402Client().register(BASE, new ExactEvmScheme(account));
// CdpX402Client turns x402's own default cap off when it applies CDP's controls; so does this agent.
client.setSpendControls(false);

let close = () => {};
if (config.control === 'walletcap') {
  const budget = openBudget({ wallet: account.address, path: config.budgetPath });
  budget.guard(client);
  close = () => budget.close();
} else if (config.control === 'cdp-shared') {
  const store = new SharedSpendStore(config.storePath, { latencyMs: config.storeLatencyMs });
  applySpendControls(client, { ...cdpControls(), store });
  close = () => store.close();
} else if (config.control === 'cdp-store') {
  const budget = openBudget({ wallet: account.address, path: config.budgetPath });
  const store = budget.cdpStore({ asset: ASSETS.USDC.address });
  applySpendControls(client, cdpStoreControls(config.storeLatencyMs > 0 ? withLatency(store, config.storeLatencyMs) : store));
  close = () => {
    store.close();
    budget.close();
  };
} else {
  applySpendControls(client, cdpControls());
}

if (config.ready) {
  writeFileSync(config.ready, '');
  await waitFor(config.go);
}

const results = [];
for (const payment of config.payments) {
  try {
    await client.createPaymentPayload(required(payment, config.payTo));
    results.push({ ...payment, signed: true });
  } catch (error) {
    results.push({ ...payment, signed: false, reason: String(error?.code ?? error?.reason ?? error?.message ?? error).slice(0, 120) });
  }
}
close();
process.stdout.write(`RESULT ${JSON.stringify(results)}\n`);
