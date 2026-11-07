// SPDX-License-Identifier: Apache-2.0
// The README's CDP snippet as a node16 or nodenext project writes it: the cast its note gives.
// test/types.test.mjs compiles it under both.
import { applySpendControls } from '@coinbase/cdp-sdk/x402';
import { x402Client } from '@x402/core/client';
import type { Budget } from 'walletcap';
import { cdpStore } from 'walletcap/cdp';

const client = new x402Client();
declare const budget: Budget;
declare const USDC: string;

applySpendControls(client as unknown as Parameters<typeof applySpendControls>[0], {
  maxAmountPerPayment: { atomic: 50_000_000n, asset: USDC },
  maxCumulativeSpend: { atomic: 150_000_000n, asset: USDC },
  maxCumulativeSpendWindow: '24h',
  allowedAssets: [USDC],
  store: cdpStore(budget, { asset: USDC }),
});
