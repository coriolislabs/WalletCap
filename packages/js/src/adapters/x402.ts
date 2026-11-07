// SPDX-License-Identifier: Apache-2.0
// walletcap/x402: count every payment an x402 v2 client (@x402/core 2.x) makes in a budget.
//
//   import { guard } from 'walletcap/x402';
//   const client = guard(new x402Client().register('eip155:8453', scheme), budget);
//
// Each payment is checked before it is signed and held once its payload exists, under the
// signed authorization's own identity. It counts until one window past the moment it can no
// longer settle, whatever the payee answers. Terms valid longer than an hour are passed over.
export { guard, MAX_PAYMENT_TIMEOUT_SECONDS, USD_ASSETS } from './_x402.js';
export type { AssetEntry, PaymentContext, PaymentRequirements, X402HookedClient } from './_x402.js';
