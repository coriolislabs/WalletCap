// SPDX-License-Identifier: Apache-2.0
// Exercise AccountCapSpender on an EVM, without Foundry.
//
// The package's canonical tests are Foundry's (contracts/test/AccountCapSpender.t.sol) and
// need forge. This covers the same behaviour with solc-js and @ethereumjs/vm, so the
// on-chain fix is checked anywhere Node runs.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBlock } from '@ethereumjs/block';
import { createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { createLegacyTx } from '@ethereumjs/tx';
import { bytesToHex, createAccount, createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { createVM, runTx } from '@ethereumjs/vm';
import { decodeErrorResult, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const solc = createRequire(import.meta.url)('solc');
// The Foundry project root: the directory above this one unless told otherwise.
const SRC = process.argv[2] ?? new URL('..', import.meta.url).pathname;
const CAP = 150_000_000n; // $150 of a 6-decimal stablecoin
const PER_PAYMENT = 50_000_000n; // $50
const WINDOW = 86_400n;
const START = 1_000_000n;

const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  agent: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  account: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  outsider: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
};
const ADDR = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v).address]));
const PAYEE = '0x000000000000000000000000000000000000beef';
const OTHER_PAYEE = '0x000000000000000000000000000000000000cafe';

// --- compile ---------------------------------------------------------------------------
const sources = {
  'src/AccountCapSpender.sol': { content: readFileSync(join(SRC, 'src/AccountCapSpender.sol'), 'utf8') },
  'test/Mocks.sol': { content: readFileSync(join(SRC, 'test/Mocks.sol'), 'utf8') },
};
const out = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: 'Solidity',
      sources,
      settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
    }),
  ),
);
const errors = (out.errors ?? []).filter(e => e.severity === 'error');
if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
const warnings = (out.errors ?? []).filter(e => e.severity === 'warning');
const pick = (file, name) => out.contracts[file][name];
const SPENDER = pick('src/AccountCapSpender.sol', 'AccountCapSpender');
const TOKEN = pick('test/Mocks.sol', 'MockToken');
const MANAGER = pick('test/Mocks.sol', 'MockSpendPermissionManager');
console.log(`compiled with ${solc.version()} — ${warnings.length} warning(s)\n`);

// --- chain -----------------------------------------------------------------------------
const common = createCustomCommon({ chainId: 31337, name: 'owned' }, Mainnet, { hardfork: Hardfork.Cancun });
const vm = await createVM({ common });
for (const address of Object.values(ADDR)) {
  await vm.stateManager.putAccount(createAddressFromString(address), createAccount({ nonce: 0n, balance: 10n ** 20n }));
}
let height = 0n;
let now = START; // the chain's clock; advanced explicitly, as vm.warp does in Foundry
async function send(key, to, data) {
  const from = privateKeyToAccount(key).address;
  const nonce = (await vm.stateManager.getAccount(createAddressFromString(from))).nonce;
  const tx = createLegacyTx({ nonce, gasPrice: 1_000_000_000n, gasLimit: 6_000_000n, ...(to ? { to } : {}), data }, { common }).sign(hexToBytes(key));
  height += 1n;
  const block = createBlock({ header: { number: height, timestamp: now, gasLimit: 30_000_000n, baseFeePerGas: 7n } }, { common });
  const result = await runTx(vm, { tx, block, skipBlockGasLimitValidation: true });
  const failure = result.execResult.exceptionError;
  if (failure) {
    let reason = failure.error;
    const raw = bytesToHex(result.execResult.returnValue);
    for (const abi of [SPENDER.abi, TOKEN.abi, MANAGER.abi]) {
      try {
        reason = decodeErrorResult({ abi, data: raw }).errorName ?? reason;
        break;
      } catch {
        /* next */
      }
    }
    if (reason === 'Error' || reason === failure.error) {
      // A plain require(..., "reason") is Error(string): report the string itself.
      try {
        reason = decodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string' }] }], data: raw }).args[0];
      } catch {
        /* opaque */
      }
    }
    return { ok: false, reason, gas: result.totalGasSpent };
  }
  return { ok: true, created: result.createdAddress?.toString(), gas: result.totalGasSpent };
}
const deployWith = async (contract, args = []) => {
  const ctor = contract.abi.find(f => f.type === 'constructor');
  const encoded = ctor && args.length ? encodeAbiParameters(ctor.inputs, args).slice(2) : '';
  const r = await send(KEYS.deployer, undefined, `0x${contract.evm.bytecode.object}${encoded}`);
  if (!r.ok) throw new Error(`deploy failed: ${r.reason}`);
  return getAddress(r.created);
};
const call = async (key, to, abi, functionName, args) => send(key, to, encodeFunctionData({ abi, functionName, args }));
const read = async (to, abi, functionName, args) => {
  const result = await vm.evm.runCall({
    to: createAddressFromString(to),
    caller: createAddressFromString(ADDR.deployer),
    data: hexToBytes(encodeFunctionData({ abi, functionName, args })),
    block: createBlock({ header: { number: height, timestamp: now } }, { common }),
  });
  return decodeFunctionResult({ abi, functionName, data: bytesToHex(result.execResult.returnValue) });
};

// --- fixture ---------------------------------------------------------------------------
const token = await deployWith(TOKEN);
const manager = await deployWith(MANAGER);
const spender = await deployWith(SPENDER, [manager, ADDR.agent, CAP, WINDOW, PER_PAYMENT, [PAYEE]]);
await call(KEYS.deployer, token, TOKEN.abi, 'mint', [ADDR.account, 1_000_000_000n]);
await call(KEYS.account, token, TOKEN.abi, 'approve', [manager, 1_000_000_000n]);

const permission = (salt, overrides = {}) => ({
  account: ADDR.account,
  spender,
  token,
  allowance: CAP,
  period: Number(WINDOW),
  start: Number(START),
  end: Number(START + 365n * 86_400n),
  salt,
  extraData: '0x',
  ...overrides,
});
const pay = (perm, amount, payee = PAYEE, key = KEYS.agent) => call(key, spender, SPENDER.abi, 'pay', [perm, amount, payee]);

// --- the cases -------------------------------------------------------------------------
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

{
  // Two permissions, one budget: Coinbase counts each permission separately.
  const a = permission(1n);
  const b = permission(2n);
  for (const p of [a, a, b]) await pay(p, PER_PAYMENT);
  const refused = await pay(b, PER_PAYMENT);
  const spent = await read(spender, SPENDER.abi, 'spentInWindow', [ADDR.account, token]);
  check('two permissions share one budget', !refused.ok && refused.reason === 'OverBudget' && spent === CAP, `spent ${spent}, 4th refused: ${refused.reason}`);
}
{
  // A period boundary refills the permission's allowance, not the account's budget.
  now += WINDOW / 2n;
  const refused = await pay(permission(3n), 1_000_000n);
  check('a period boundary does not refill the budget', !refused.ok && refused.reason === 'OverBudget', refused.reason);
}
{
  // A payment counts as if made at its bucket's last second, for one window from there.
  const width = await read(spender, SPENDER.abi, 'bucketWidth', []);
  const bucketEnd = (START / width + 1n) * width - 1n;
  now = bucketEnd + WINDOW;
  const still = await pay(permission(4n), 1_000_000n);
  check('spend counts until its bucket ends plus one window', !still.ok && still.reason === 'OverBudget', still.reason);
  now = bucketEnd + WINDOW + 1n;
  const after = await pay(permission(4n), PER_PAYMENT);
  const spent = await read(spender, SPENDER.abi, 'spentInWindow', [ADDR.account, token]);
  check('spend ages out one second later', after.ok && spent === PER_PAYMENT, `spent ${spent}`);
}
{
  const outsider = await pay(permission(5n), 1_000_000n, PAYEE, KEYS.outsider);
  check('only the agent can pay', !outsider.ok && outsider.reason === 'NotAgent', outsider.reason);
}
{
  const wrongPayee = await pay(permission(6n), 1_000_000n, OTHER_PAYEE);
  check('only allowlisted payees are paid', !wrongPayee.ok && wrongPayee.reason === 'PayeeNotAllowed', wrongPayee.reason);
}
{
  const tooBig = await pay(permission(7n), PER_PAYMENT + 1n);
  check('a payment over the per-payment max is refused', !tooBig.ok && tooBig.reason === 'OverPerPayment', tooBig.reason);
}
{
  const elsewhere = await pay(permission(8n, { spender: ADDR.agent }), 1_000_000n);
  check('a permission for another spender is refused', !elsewhere.ok && elsewhere.reason === 'WrongSpender', elsewhere.reason);
}
{
  const perm = permission(9n);
  await call(KEYS.account, manager, MANAGER.abi, 'revoke', [perm]);
  const revoked = await pay(perm, 1_000_000n);
  check('a revoked permission cannot be drawn', !revoked.ok && revoked.reason === 'revoked', revoked.reason);
}
{
  // perPayment > cap, an empty payee list, and a window that isn't a multiple of BUCKETS
  // are configuration errors.
  const deploy = args =>
    send(
      KEYS.deployer,
      undefined,
      `0x${SPENDER.evm.bytecode.object}${encodeAbiParameters(SPENDER.abi.find(f => f.type === 'constructor').inputs, args).slice(2)}`,
    );
  const refused = [
    await deploy([manager, ADDR.agent, PER_PAYMENT, WINDOW, CAP, [PAYEE]]),
    await deploy([manager, ADDR.agent, CAP, WINDOW, PER_PAYMENT, []]),
    await deploy([manager, ADDR.agent, CAP, WINDOW + 1n, PER_PAYMENT, [PAYEE]]),
  ];
  check(
    'the constructor refuses a bad configuration',
    refused.every(r => !r.ok && r.reason === 'InvalidConfiguration'),
    refused.map(r => r.reason).join(' / '),
  );
}
{
  // The money actually moved to the payee, and only to the payee.
  const paid = await read(token, TOKEN.abi, 'balanceOf', [PAYEE]);
  const held = await read(token, TOKEN.abi, 'balanceOf', [spender]);
  check('every drawn payment reached the payee', paid === CAP + PER_PAYMENT && held === 0n, `payee ${paid}, spender holds ${held}`);
}
{
  // A burst of tiny payments, then a quiet window: the next payment still runs, at the
  // same cost. An unbounded log made it cost ~6M gas after 1,000 payments.
  const burst = await deployWith(SPENDER, [manager, ADDR.agent, CAP, WINDOW, PER_PAYMENT, [OTHER_PAYEE]]);
  const perm = { ...permission(10n), spender: burst, start: Number(now), end: Number(now + 365n * 86_400n) };
  let first;
  for (let i = 0; i < 1_000; i += 1) {
    const r = await call(KEYS.agent, burst, SPENDER.abi, 'pay', [perm, 1_000n, OTHER_PAYEE]);
    if (!r.ok) throw new Error(`burst payment ${i} failed: ${r.reason}`);
    first ??= r.gas;
  }
  now += WINDOW * 2n;
  const after = await call(KEYS.agent, burst, SPENDER.abi, 'pay', [perm, PER_PAYMENT, OTHER_PAYEE]);
  check(
    'a burst then a quiet window does not lock the account',
    after.ok && after.gas < 250_000n,
    `${after.ok ? 'paid' : after.reason}, ${after.gas} gas (first burst payment ${first})`,
  );
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
