// SPDX-License-Identifier: Apache-2.0
// A README.md snippet, word for word between the markers, with what it assumes declared above
// them. test/types.test.mjs compiles it and checks it still matches the README.
// The client is typed as applySpendControls takes it. Under moduleResolution nodenext,
// @coinbase/cdp-sdk's CommonJS declarations name @x402/core's CommonJS x402Client, which
// TypeScript keeps apart from the ESM one an ESM project imports; that is upstream of walletcap.
import { applySpendControls } from '@coinbase/cdp-sdk/x402';
import type { Budget } from 'walletcap';

declare const client: Parameters<typeof applySpendControls>[0];
declare const budget: Budget;
declare const USDC: string;
// --- README ---
import { cdpStore } from 'walletcap/cdp';

applySpendControls(client, {
  maxAmountPerPayment: { atomic: 50_000_000n, asset: USDC },
  maxCumulativeSpend: { atomic: 150_000_000n, asset: USDC },
  maxCumulativeSpendWindow: '24h',
  allowedAssets: [USDC],
  store: cdpStore(budget, { asset: USDC }),
});
// --- end ---

export {};
