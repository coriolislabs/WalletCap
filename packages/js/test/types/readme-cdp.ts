// SPDX-License-Identifier: Apache-2.0
// A README.md snippet, word for word between the markers, with what it assumes declared above
// them. test/types.test.mjs compiles it and checks it still matches the README.
// The client is a real x402Client. Under moduleResolution node16 and nodenext, @coinbase/cdp-sdk
// 1.60's declarations are read as CommonJS and name @x402/core's CommonJS x402Client, which
// TypeScript keeps apart from the ESM one this file imports: TS2345 at `client`, with or without
// walletcap. test/types.test.mjs compiles this file with bundler resolution, checks node16 and
// nodenext give that one error, and compiles the README's cast (cdp-nodenext.ts) under both.
import { applySpendControls } from '@coinbase/cdp-sdk/x402';
import { x402Client } from '@x402/core/client';
import type { Budget } from 'walletcap';

const client = new x402Client();
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
