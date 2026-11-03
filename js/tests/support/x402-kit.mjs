// SPDX-License-Identifier: Apache-2.0
// The real x402 client (the devDependencies), or null when it is not installed.
export const NETWORK = 'eip155:84532';
export const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const PAY_TO = '0x4165cb72De51A67aac32DC33197d779552205efD';
// Anvil's well-known second development key: a test signer that holds nothing.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

export async function x402() {
  let core;
  let evm;
  let accounts;
  try {
    core = await import('@x402/core/client');
    evm = await import('@x402/evm/exact/client');
    accounts = await import('viem/accounts');
  } catch {
    return null;
  }
  const account = accounts.privateKeyToAccount(KEY);
  return {
    account,
    client() {
      const client = new core.x402Client().register(NETWORK, new evm.ExactEvmScheme(account));
      client.setSpendControls(false); // x402's own default cap stays out of the measurement
      return client;
    },
    required(atomic, overrides = {}) {
      return {
        x402Version: 2,
        resource: { url: 'https://api.example/paid', description: 'owned test resource', mimeType: 'text/plain' },
        accepts: [{
          scheme: 'exact', network: NETWORK, asset: USDC, amount: String(atomic), payTo: PAY_TO, maxTimeoutSeconds: 300,
          extra: { name: 'USDC', version: '2' }, ...overrides,
        }],
      };
    },
  };
}
