#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// walletcap-crash-test: put Coinbase's agent spend controls (CDP's x402 controls, Spend Permissions,
// and with --agentkit AgentKit) through the events that hand an agent a fresh budget, put walletcap
// through the same events, and print what got past the cap. Offline: nothing is sent.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openBudget } from 'walletcap';
import { spendPermissionsRows } from './spend-permissions.mjs';

const AGENT = fileURLToPath(new URL('./agent.mjs', import.meta.url));
const AGENTKIT_AGENT = fileURLToPath(new URL('./agentkit-agent.mjs', import.meta.url));
const AGENTKIT_INSTALL = 'npx -p walletcap-crash-test -p @coinbase/agentkit@0.10.4 walletcap-crash-test --agentkit';
// How long the shared store takes to answer each call: a network database a millisecond away.
const STORE_LATENCY_MS = 1;
const CAP = 150_000_000n; // $150, in USDC's six decimals
const FIFTY = { asset: 'USDC', atomic: '50000000' };
const EURC_1000 = { asset: 'EURC', atomic: '1000000000' };

/**
 * Each event runs three times, each from a fresh start: under CDP's controls as Coinbase's README
 * sets them, under walletcap's guard, and under CDP's controls on walletcap's cdpStore as
 * walletcap's README sets them. In the shared-store event, every SpendStore is a network hop away.
 */
export const SCENARIOS = [
  { id: 'restart', label: 'restart, then pay again', cdp: 'cdp', agents: 2, together: false, payments: Array(4).fill(FIFTY) },
  { id: 'replicas', label: '10 replicas', cdp: 'cdp', agents: 10, together: true, payments: Array(3).fill(FIFTY) },
  { id: 'shared-store', label: `10 replicas, shared store ${STORE_LATENCY_MS} ms away`, cdp: 'cdp-shared', storeLatencyMs: STORE_LATENCY_MS, agents: 10, together: true, payments: Array(3).fill(FIFTY) },
  { id: 'asset-switch', label: 'payee asks for EURC, not USDC', cdp: 'cdp', agents: 1, together: false, payments: [EURC_1000] },
];

const versionOf = name => {
  for (const dir of createRequire(import.meta.url).resolve.paths(name) ?? []) {
    const file = join(dir, name, 'package.json');
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).version;
  }
  return 'not installed';
};

const runScript = (script, args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', code => {
    const line = stdout.split('\n').find(l => l.startsWith('RESULT '));
    if (code === 0 && line) resolve(JSON.parse(line.slice('RESULT '.length)));
    else reject(new Error(`an agent exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
  });
});
const runAgent = config => runScript(AGENT, [JSON.stringify(config)]);

/** The AgentKit row, or null when @coinbase/agentkit is not installed next to the crash test. */
export async function agentkitRow() {
  const version = versionOf('@coinbase/agentkit');
  if (version === 'not installed') return null;
  return { version, agentkit: await runScript(AGENTKIT_AGENT, ['agentkit']), walletcap: await runScript(AGENTKIT_AGENT, ['walletcap']) };
}

// Replicas start together: each waits for the go file, so their payments overlap.
async function runAgents(configs, together, dir) {
  if (!together) {
    const results = [];
    for (const config of configs) results.push(await runAgent(config));
    return results;
  }
  const go = join(dir, 'go');
  const running = configs.map((config, i) => runAgent({ ...config, ready: join(dir, `ready-${i}`), go }));
  const until = Date.now() + 60_000;
  while (!configs.every((_, i) => existsSync(join(dir, `ready-${i}`)))) {
    if (Date.now() > until) throw new Error('the replicas did not start');
    await new Promise(done => setTimeout(done, 5));
  }
  writeFileSync(go, '');
  return Promise.all(running);
}

async function runControl(scenario, control, payTo) {
  const dir = mkdtempSync(join(tmpdir(), 'walletcap-crash-'));
  try {
    const key = generatePrivateKey();
    const budgetPath = join(dir, 'budget.sqlite');
    if (control === 'walletcap' || control === 'cdp-store') {
      // The owner sets the budget once, as `npx walletcap set` does; every agent opens it.
      (await openBudget({ wallet: privateKeyToAccount(key).address, path: budgetPath, perPayment: '$50', perDay: '$150', create: true })).close();
    }
    const base = { control, key, payTo, budgetPath, storePath: join(dir, 'cdp-store.sqlite'), storeLatencyMs: scenario.storeLatencyMs ?? 0, payments: scenario.payments };
    const results = (await runAgents(Array.from({ length: scenario.agents }, () => base), scenario.together, dir)).flat();
    const signed = asset => results.filter(r => r.signed && r.asset === asset).reduce((sum, r) => sum + BigInt(r.atomic), 0n);
    const usdc = signed('USDC');
    return {
      control,
      usdc,
      eurc: signed('EURC'),
      over: usdc > CAP ? usdc - CAP : 0n,
      refused: results.filter(r => !r.signed).length,
      reasons: [...new Set(results.filter(r => !r.signed).map(r => r.reason))],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function crashTest({ agentkit = false } = {}) {
  const started = Date.now();
  const payTo = privateKeyToAccount(generatePrivateKey()).address;
  const scenarios = [];
  for (const scenario of SCENARIOS) {
    scenarios.push({
      id: scenario.id,
      label: scenario.label,
      cdp: await runControl(scenario, scenario.cdp, payTo),
      walletcap: await runControl(scenario, 'walletcap', payTo),
      cdpStore: await runControl(scenario, 'cdp-store', payTo),
    });
  }
  const spendPermissions = await spendPermissionsRows();
  const agentkitResult = agentkit ? await agentkitRow() : undefined;
  return {
    versions: { '@coinbase/cdp-sdk': versionOf('@coinbase/cdp-sdk'), '@x402/core': versionOf('@x402/core'), walletcap: versionOf('walletcap') },
    policy: { perPayment: '$50', per24h: '$150', asset: 'USDC', network: 'Base' },
    scenarios,
    spendPermissions,
    ...(agentkit ? { agentkit: agentkitResult } : {}),
    seconds: (Date.now() - started) / 1000,
  };
}

const NETWORKS = { 'eip155:8453': 'Base mainnet', 'eip155:84532': 'Base Sepolia' };
const where = payment => `$${(Number(payment.amount) / 1e6).toFixed(2)} on ${NETWORKS[payment.network] ?? payment.network}`;

function agentkitReport(row) {
  if (row === null) {
    return ['AgentKit row skipped: @coinbase/agentkit is not installed next to the crash test. Run it with:', `  ${AGENTKIT_INSTALL}`];
  }
  const signed = row.agentkit.received.map(p => `signed ${where(p)} to ${p.toStranger ? 'the first-listed address' : 'the merchant'}, valid ${Math.round(p.validForSeconds / 86_400)} days`);
  const reported = row.agentkit.reported ? `; reported ${where(row.agentkit.reported)}` : '';
  const guarded = row.walletcap.received.length === 0
    ? 'refused before signing'
    : row.walletcap.received.map(p => `signed ${where(p)}, ${p.approved ? 'the offer the agent approved' : 'not the offer the agent approved'}`).join('; ');
  return [
    `Coinbase AgentKit ${row.version}: the agent approves the merchant's 1¢ offer on Base Sepolia; the merchant`,
    'lists $1.00 on Base mainnet, to another address, first.',
    '',
    `AgentKit                         ${signed.join(', ') || 'signed nothing'}${reported}`,
    `walletcap, 2¢ a payment          ${guarded}`,
    '',
    "AgentKit's wallet providers send an analytics event with the wallet's address when they start;",
    'the crash test turns that off, and blocks every request but the local merchant.',
  ];
}

const dollars = atomic => `$${(Number(atomic) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const eurc = atomic => `${(Number(atomic) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })} EURC`;

const cell = result => {
  if (result.eurc > 0n) return `${eurc(result.eurc)} signed, counted as $0`;
  if (result.usdc === 0n) return 'refused before signing';
  return `${dollars(result.usdc)} signed · ${dollars(result.over)} over`;
};

const pulledCell = result => `${dollars(result.pulled)} pulled · ${dollars(result.over)} over`;

export function report(run) {
  const sp = run.spendPermissions;
  const rows = [
    ['CDP x402 spend controls', "CDP's controls", 'walletcap guard', 'walletcap cdpStore'],
    ...run.scenarios.map(s => [`  ${s.label}`, cell(s.cdp), cell(s.walletcap), cell(s.cdpStore)]),
    ['', '', '', ''],
    ['Spend Permissions', 'SpendPermissionManager', 'AccountCapSpender', ''],
    ...sp.rows.map(r => [`  ${r.label}`, pulledCell(r.vendor), pulledCell(r.walletcap), '']),
  ];
  const widths = [0, 1, 2].map(col => Math.max(...rows.map(row => row[col].length)) + 3);
  const table = rows.map(row => row.map((text, col) => (col < widths.length ? text.padEnd(widths[col]) : text)).join('').trimEnd()).join('\n');
  const total = side => run.scenarios.reduce((sum, s) => sum + s[side].over, 0n);
  const totalEurc = side => run.scenarios.reduce((sum, s) => sum + s[side].eurc, 0n);
  const past = side => [total(side) > 0n || totalEurc(side) === 0n ? dollars(total(side)) : null, totalEurc(side) > 0n ? eurc(totalEurc(side)) : null].filter(Boolean).join(' and ');
  const spOver = side => sp.rows.reduce((sum, r) => sum + r[side].over, 0n);
  const walletcapOver = total('walletcap') + spOver('walletcap');
  const { versions } = run;
  return [
    "walletcap crash test: Coinbase's agent spend controls",
    `@coinbase/cdp-sdk ${versions['@coinbase/cdp-sdk']} · @x402/core ${versions['@x402/core']} · SpendPermissionManager 1.0.0 · walletcap ${versions.walletcap}`,
    'Every agent is held to $50 a payment and $150 in any 24 hours, in USDC on Base.',
    '',
    table,
    '',
    `Past the $150 cap: ${past('cdp')} with CDP's controls, ${dollars(spOver('vendor'))} with Spend Permissions;`,
    `${dollars(walletcapOver)} with walletcap's guard and AccountCapSpender; ${past('cdpStore')} with CDP's controls on walletcap's cdpStore.`,
    '',
    "CDP's controls: applySpendControls, set as Coinbase's README shows, with its default in-memory store,",
    `or with a shared store built to its SpendStore interface that answers each call after ${STORE_LATENCY_MS} ms, as Redis`,
    "or Postgres over the network does. CDP reads the total, then records the payment: replicas can read",
    'the same total before any of them records. walletcap guard: guard(client, budget) on the same x402 client,',
    'with one budget file every agent opens. walletcap cdpStore: the same applySpendControls, set as',
    "walletcap's README shows (USDC the only allowed asset), with store: cdpStore(budget) on that budget",
    'file. The store re-checks the cap inside its write transaction when CDP records a payment. In the',
    `shared-store row it too answers each call after ${STORE_LATENCY_MS} ms.`,
    'Each payment is an x402 authorization signed offline by a throwaway key that holds nothing; a payee',
    'holding one could settle it on Base until it expires.',
    '',
    "Spend Permissions: Coinbase's SpendPermissionManager and Smart Wallet run on a local EVM from the",
    `code deployed on Base mainnet (block ${sp.block}). A Smart Wallet grants the agent $150 a day per`,
    'permission; a test token stands in for USDC. walletcap: the wallet grants the same permissions to',
    'AccountCapSpender (unaudited), which holds them all to one rolling $150 cap.',
    'Nothing was sent.',
    ...(run.agentkit === undefined
      ? ['', `Add --agentkit for Coinbase AgentKit's row (it installs @coinbase/agentkit, about 1.3 GB):`, `  ${AGENTKIT_INSTALL}`]
      : ['', ...agentkitReport(run.agentkit)]),
    '',
    `Ran in ${run.seconds.toFixed(1)}s.`,
  ].join('\n');
}

/**
 * Whether walletcap held: its guard, CDP's controls on its cdpStore, AccountCapSpender and the
 * AgentKit guard, which may sign the offer the agent approved or nothing.
 */
export const held = run => run.scenarios.every(s => [s.walletcap, s.cdpStore].every(r => r.over === 0n && r.eurc === 0n))
  && run.spendPermissions.rows.every(r => r.walletcap.over === 0n)
  && (!run.agentkit || run.agentkit.walletcap.received.every(p => p.approved === true));

const HELP = `walletcap-crash-test: put Coinbase's agent spend controls and walletcap through the same events
and count what gets past the cap. CDP's x402 controls face a restart, replicas, a shared store and a
different asset, on their own store and on walletcap's; Spend Permissions face a second permission
and a period boundary; with --agentkit, AgentKit faces a merchant who lists a bigger offer first.
Offline: nothing is sent.

Usage: npx walletcap-crash-test [--json] [--agentkit]

  --json      Machine-readable results
  --agentkit  Add Coinbase AgentKit's row. It needs @coinbase/agentkit installed alongside:
              ${AGENTKIT_INSTALL}
  --version   Print the version

Exits 1 if walletcap's guard, CDP's controls on walletcap's cdpStore, or any other walletcap
control lets anything past the cap.`;

// npm runs a bin through a symlink, so compare real paths: argv[1] is the link, import.meta.url the file.
const isMain = () => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (process.argv[1] && isMain()) {
  const { values } = parseArgs({ options: { json: { type: 'boolean' }, agentkit: { type: 'boolean' }, version: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
  } else if (values.version) {
    process.stdout.write(`${JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version}\n`);
  } else {
    const run = await crashTest({ agentkit: values.agentkit === true });
    process.stdout.write(values.json
      ? `${JSON.stringify(run, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`
      : `${report(run)}\n`);
    process.exitCode = held(run) ? 0 : 1;
  }
}
