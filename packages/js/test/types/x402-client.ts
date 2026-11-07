// SPDX-License-Identifier: Apache-2.0
// guard() takes @x402/core's own x402Client, whichever 2.x release is installed, and gives it
// back with its own type. test/types.test.mjs compiles this against packages/js's x402 and the
// workspace's newer one.
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { Budget } from 'walletcap';
import { guard } from 'walletcap/x402';

declare const account: PrivateKeyAccount;
declare const budget: Budget;

export const client: x402Client = guard(new x402Client().register('eip155:8453', new ExactEvmScheme(account)), budget);
