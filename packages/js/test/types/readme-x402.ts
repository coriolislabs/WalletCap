// SPDX-License-Identifier: Apache-2.0
// A README.md snippet, word for word between the markers, with what it assumes declared above
// them. test/types.test.mjs compiles it and checks it still matches the README.
import type { PrivateKeyAccount } from 'viem/accounts';

declare const account: PrivateKeyAccount;
// --- README ---
import { openBudget } from 'walletcap';
import { guard } from 'walletcap/x402';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';

const budget = await openBudget({ wallet: account.address });
const client = guard(new x402Client().register('eip155:8453', new ExactEvmScheme(account)), budget);
const fetchPaid = wrapFetchWithPayment(fetch, client);
// --- end ---

export {};
