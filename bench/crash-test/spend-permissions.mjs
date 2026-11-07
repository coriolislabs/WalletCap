// SPDX-License-Identifier: Apache-2.0
// The Spend Permissions rows. Coinbase's SpendPermissionManager, Smart Wallet factory and Smart
// Wallet run on an in-process EVM from the exact runtime code deployed on Base mainnet
// (contracts/coinbase-base-mainnet.json). A Smart Wallet grants the agent $150-a-day permissions and
// the agent pulls from them; a test token stands in for USDC. The same events then run through
// walletcap's AccountCapSpender. Nothing leaves this machine.
import { readFileSync } from 'node:fs';
import { createBlock } from '@ethereumjs/block';
import { createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { createLegacyTx } from '@ethereumjs/tx';
import { bytesToHex, createAccount, createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { createVM, runTx } from '@ethereumjs/vm';
import { decodeErrorResult, decodeFunctionResult, encodeAbiParameters, encodeDeployData, encodeFunctionData, getAddress, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const read = name => JSON.parse(readFileSync(new URL(`./contracts/${name}`, import.meta.url), 'utf8'));
const COINBASE = read('coinbase-base-mainnet.json');
const WALLETCAP = read('walletcap.json');
const MANAGER = COINBASE.contracts.SpendPermissionManager.address;
const FACTORY = COINBASE.contracts.CoinbaseSmartWalletFactory.address;

const MANAGER_ABI = parseAbi([
  'struct SpendPermission { address account; address spender; address token; uint160 allowance; uint48 period; uint48 start; uint48 end; uint256 salt; bytes extraData; }',
  'function approve(SpendPermission spendPermission) returns (bool)',
  'function spend(SpendPermission spendPermission, uint160 value)',
]);
const FACTORY_ABI = parseAbi([
  'function createAccount(bytes[] owners, uint256 nonce) payable returns (address)',
  'function getAddress(bytes[] owners, uint256 nonce) view returns (address)',
]);
const WALLET_ABI = parseAbi([
  'function addOwnerAddress(address owner)',
  'function execute(address target, uint256 value, bytes data) payable',
]);
const SPENDER_ABI = WALLETCAP.AccountCapSpender.abi;
const TOKEN_ABI = WALLETCAP.MockToken.abi;
const ERROR_ABIS = [SPENDER_ABI, parseAbi([
  'error ExceededSpendPermission(uint256 value, uint256 allowance)',
  'error UnauthorizedSpendPermission()',
  'error InvalidSender(address sender, address expected)',
])];

const DAY = 86_400n;
const CAP = 150_000_000n; // $150 of a 6-decimal stablecoin
const PAYMENT = 50_000_000n;
const START = 1_767_225_600n; // 1 Jan 2026, 00:00 UTC

/** One fresh chain with Coinbase's deployed code at its Base addresses. */
async function chain() {
  const common = createCustomCommon({ chainId: 8453, name: 'base-crash-test' }, Mainnet, { hardfork: Hardfork.Cancun });
  const vm = await createVM({ common });
  for (const { address, code } of Object.values(COINBASE.contracts)) {
    const at = createAddressFromString(address);
    await vm.stateManager.putAccount(at, createAccount({ nonce: 1n, balance: 0n }));
    await vm.stateManager.putCode(at, hexToBytes(code));
  }
  const keys = { owner: generatePrivateKey(), agent: generatePrivateKey() };
  const who = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, privateKeyToAccount(key).address]));
  for (const address of Object.values(who)) {
    await vm.stateManager.putAccount(createAddressFromString(address), createAccount({ nonce: 0n, balance: 10n ** 20n }));
  }
  let height = 0n;
  let now = START;

  const send = async (key, to, data) => {
    const from = createAddressFromString(privateKeyToAccount(key).address);
    const { nonce } = await vm.stateManager.getAccount(from);
    const tx = createLegacyTx({ nonce, gasPrice: 1_000_000_000n, gasLimit: 10_000_000n, ...(to ? { to } : {}), data }, { common }).sign(hexToBytes(key));
    height += 1n;
    const block = createBlock({ header: { number: height, timestamp: now, gasLimit: 30_000_000n, baseFeePerGas: 7n } }, { common });
    const result = await runTx(vm, { tx, block, skipBlockGasLimitValidation: true });
    const failure = result.execResult.exceptionError;
    if (!failure) return { ok: true, created: result.createdAddress?.toString() };
    let reason = failure.error;
    for (const abi of ERROR_ABIS) {
      try { reason = decodeErrorResult({ abi, data: bytesToHex(result.execResult.returnValue) }).errorName; break; } catch { /* next */ }
    }
    return { ok: false, reason };
  };
  const call = (key, to, abi, functionName, args) => send(key, to, encodeFunctionData({ abi, functionName, args }));
  const read = async (to, abi, functionName, args) => {
    const result = await vm.evm.runCall({
      to: createAddressFromString(to), caller: createAddressFromString(who.owner),
      data: hexToBytes(encodeFunctionData({ abi, functionName, args })),
      block: createBlock({ header: { number: height, timestamp: now } }, { common }),
    });
    return decodeFunctionResult({ abi, functionName, data: bytesToHex(result.execResult.returnValue) });
  };
  const deploy = async (artifact, args = []) => {
    const r = await send(keys.owner, undefined, encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args }));
    if (!r.ok) throw new Error(`deploy failed: ${r.reason}`);
    return getAddress(r.created);
  };
  const must = async promise => {
    const r = await promise;
    if (!r.ok) throw new Error(`setup step failed: ${r.reason}`);
    return r;
  };

  // The account: a Coinbase Smart Wallet owned by the owner, with the manager added as an owner
  // (as granting a first Spend Permission does), holding $1,000 of the test token.
  const owners = [encodeAbiParameters([{ type: 'address' }], [who.owner])];
  const wallet = await read(FACTORY, FACTORY_ABI, 'getAddress', [owners, 0n]);
  await must(call(keys.owner, FACTORY, FACTORY_ABI, 'createAccount', [owners, 0n]));
  await must(call(keys.owner, wallet, WALLET_ABI, 'addOwnerAddress', [MANAGER]));
  const token = await deploy(WALLETCAP.MockToken);
  await must(call(keys.owner, token, TOKEN_ABI, 'mint', [wallet, 1_000_000_000n]));

  const permission = (spender, salt) => ({
    account: wallet, spender, token, allowance: CAP, period: Number(DAY),
    start: Number(START), end: Number(START + 30n * DAY), salt, extraData: '0x',
  });
  const grant = perm => must(call(keys.owner, wallet, WALLET_ABI, 'execute', [MANAGER, 0n, encodeFunctionData({ abi: MANAGER_ABI, functionName: 'approve', args: [perm] })]));
  const balance = async address => read(token, TOKEN_ABI, 'balanceOf', [address]);
  return { keys, who, wallet, token, permission, grant, balance, call, deploy, at: t => { now = t; } };
}

// The agent pulls from Spend Permissions granted to it directly.
export async function vendorRun(event) {
  const c = await chain();
  const perms = event.permissions.map(salt => c.permission(c.who.agent, salt));
  for (const perm of perms) await c.grant(perm);
  const refusals = [];
  for (const step of event.steps) {
    c.at(step.at);
    const r = await c.call(c.keys.agent, MANAGER, MANAGER_ABI, 'spend', [perms[step.permission], PAYMENT]);
    if (!r.ok) refusals.push(r.reason);
  }
  return { pulled: await c.balance(c.who.agent), refusals };
}

// The account grants the same permissions to AccountCapSpender, and the agent pays through it.
export async function walletcapRun(event) {
  const c = await chain();
  const merchant = privateKeyToAccount(generatePrivateKey()).address;
  const spender = await c.deploy(WALLETCAP.AccountCapSpender, [MANAGER, c.who.agent, CAP, DAY, PAYMENT, [merchant]]);
  const perms = event.permissions.map(salt => c.permission(spender, salt));
  for (const perm of perms) await c.grant(perm);
  const refusals = [];
  for (const step of event.steps) {
    c.at(step.at);
    const r = await c.call(c.keys.agent, spender, SPENDER_ABI, 'pay', [perms[step.permission], PAYMENT, merchant]);
    if (!r.ok) refusals.push(r.reason);
  }
  return { pulled: await c.balance(merchant), refusals };
}

export const at = seconds => START + seconds;
export const SPEND_PERMISSION_EVENTS = [
  {
    id: 'second-permission',
    label: 'a second permission',
    permissions: [1n, 2n],
    // Three $50 pulls from each permission, an hour into the first day.
    steps: [0, 0, 0, 1, 1, 1].map(permission => ({ permission, at: at(3_600n) })),
  },
  {
    id: 'period-boundary',
    label: 'across a period boundary, 1 second apart',
    permissions: [1n],
    // $150 in the last second of day one, $150 in the first second of day two.
    steps: [...Array(3).fill(at(DAY - 1n)), ...Array(3).fill(at(DAY))].map(when => ({ permission: 0, at: when })),
  },
];

export async function spendPermissionsRows() {
  const rows = [];
  for (const event of SPEND_PERMISSION_EVENTS) {
    const vendor = await vendorRun(event);
    const walletcap = await walletcapRun(event);
    const over = pulled => (pulled > CAP ? pulled - CAP : 0n);
    rows.push({
      id: event.id,
      label: event.label,
      vendor: { pulled: vendor.pulled, over: over(vendor.pulled), refusals: vendor.refusals },
      walletcap: { pulled: walletcap.pulled, over: over(walletcap.pulled), refusals: walletcap.refusals },
    });
  }
  return { block: COINBASE.block, rows };
}
