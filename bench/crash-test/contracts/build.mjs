// SPDX-License-Identifier: Apache-2.0
// Builds the contracts the Spend Permissions row runs, so the crash test itself needs no network
// and no compiler.
//
//   node contracts/build.mjs            compile walletcap's AccountCapSpender and a test token
//   node contracts/build.mjs --check    fail if the compiled files differ from the shipped ones
//   node contracts/build.mjs --fetch    also re-read Coinbase's deployed code from Base mainnet
//
// Coinbase's contracts are not rebuilt from source: the crash test runs the exact runtime code
// deployed on Base mainnet, read once with eth_getCode and kept, with each code hash, in
// coinbase-base-mainnet.json. (Source: github.com/coinbase/spend-permissions v1.0.0 and
// github.com/coinbase/smart-wallet, MIT.)
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem';

const HERE = new URL('./', import.meta.url);
const SOLIDITY = new URL('../../../contracts/', import.meta.url);
const WALLETCAP = fileURLToPath(new URL('walletcap.json', HERE));
const COINBASE = fileURLToPath(new URL('coinbase-base-mainnet.json', HERE));
const RPC = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';

export const COINBASE_ADDRESSES = {
  SpendPermissionManager: '0xf85210B21cC50302F477BA56686d2019dC9b67Ad',
  CoinbaseSmartWalletFactory: '0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a',
};

function compileWalletcap() {
  const solc = createRequire(import.meta.url)('solc');
  const read = path => readFileSync(new URL(path, SOLIDITY), 'utf8');
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
      'src/AccountCapSpender.sol': { content: read('src/AccountCapSpender.sol') },
      'test/Mocks.sol': { content: read('test/Mocks.sol') },
    },
    // The same settings as contracts/foundry.toml and contracts/evm/check.mjs.
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const errors = (out.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  const pick = (file, name) => ({ abi: out.contracts[file][name].abi, bytecode: `0x${out.contracts[file][name].evm.bytecode.object}` });
  return {
    compiler: `solc ${solc.version()}, optimizer 200 runs, cancun`,
    AccountCapSpender: pick('src/AccountCapSpender.sol', 'AccountCapSpender'),
    MockToken: pick('test/Mocks.sol', 'MockToken'),
  };
}

async function rpc(method, params) {
  const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function fetchCoinbase() {
  const block = await rpc('eth_blockNumber', []);
  const call = async (to, abi, functionName) => decodeFunctionResult({ abi, functionName, data: await rpc('eth_call', [{ to, data: encodeFunctionData({ abi, functionName }) }, block]) });
  const manager = COINBASE_ADDRESSES.SpendPermissionManager;
  const factory = COINBASE_ADDRESSES.CoinbaseSmartWalletFactory;
  const addresses = {
    SpendPermissionManager: manager,
    PublicERC6492Validator: await call(manager, parseAbi(['function PUBLIC_ERC6492_VALIDATOR() view returns (address)']), 'PUBLIC_ERC6492_VALIDATOR'),
    CoinbaseSmartWalletFactory: factory,
    CoinbaseSmartWallet: await call(factory, parseAbi(['function implementation() view returns (address)']), 'implementation'),
  };
  const contracts = {};
  for (const [name, address] of Object.entries(addresses)) {
    const code = await rpc('eth_getCode', [address, block]);
    if (code === '0x') throw new Error(`no code at ${name} ${address}`);
    contracts[name] = { address, codeHash: keccak256(code), code };
  }
  return { chain: 'Base mainnet (8453)', block: Number(BigInt(block)), source: RPC, contracts };
}

const args = new Set(process.argv.slice(2));
const walletcap = compileWalletcap();
if (args.has('--check')) {
  const shipped = JSON.parse(readFileSync(WALLETCAP, 'utf8'));
  for (const name of ['AccountCapSpender', 'MockToken']) {
    if (shipped[name].bytecode !== walletcap[name].bytecode) throw new Error(`contracts/walletcap.json is stale: ${name} no longer matches contracts/; run node contracts/build.mjs`);
  }
  const coinbase = JSON.parse(readFileSync(COINBASE, 'utf8'));
  for (const [name, entry] of Object.entries(coinbase.contracts)) {
    if (keccak256(entry.code) !== entry.codeHash) throw new Error(`${name}'s code does not match its recorded hash`);
  }
  console.log('contracts are current: AccountCapSpender and MockToken match contracts/, Coinbase code matches its hashes');
} else {
  writeFileSync(WALLETCAP, `${JSON.stringify(walletcap, null, 1)}\n`);
  if (args.has('--fetch')) writeFileSync(COINBASE, `${JSON.stringify(await fetchCoinbase(), null, 1)}\n`);
  console.log(`wrote contracts/walletcap.json${args.has('--fetch') ? ' and contracts/coinbase-base-mainnet.json' : ''}`);
}
