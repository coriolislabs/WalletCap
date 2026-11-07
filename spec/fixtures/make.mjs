// SPDX-License-Identifier: Apache-2.0
// Writes the budget files older walletcap versions left, for the upgrade tests: schema-1.sqlite as
// 0.2.4 wrote it, and schema-2.sqlite as 0.3.0 wrote it, each with a .expect.json of what 0.3.0
// counted in it at a series of times. The files are committed; this script is how they were made.
//
//   mkdir old && cd old && echo '{"type":"module"}' > package.json
//   npm install walletcap-0.2.4@npm:walletcap@0.2.4 walletcap-0.3.0@npm:walletcap@0.3.0
//   node <repo>/spec/fixtures/make.mjs "$PWD"
//
// Every time is the ledger's own: 0.2.4 takes a clock option, and 0.3.0's tests set its clock
// through its _clock.mjs, as here. T0 is 2027-01-15T08:00:00Z.
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [old] = process.argv.slice(2);
if (!old) throw new Error('usage: node make.mjs <directory with walletcap-0.2.4 and walletcap-0.3.0 installed>');
const load = async (pkg, file) => import(pathToFileURL(join(old, 'node_modules', pkg, file)).href);
const v024 = await load('walletcap-0.2.4', 'ledger.mjs');
const v030 = await load('walletcap-0.3.0', 'index.mjs');
const clock030 = await load('walletcap-0.3.0', '_clock.mjs');

const OUT = new URL('.', import.meta.url).pathname;
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TX = n => `0x${n.repeat(64 / n.length)}`;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

// The wallets. Each 0.2.x spelling of one wallet becomes one budget in 0.3.
export const WALLETS = {
  app: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  frozen: '0xd797ead28C38575FDf4fC523866287372340Ca02',
  merged: '0x4165cb72De51A67aac32DC33197d779552205efD',
  solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  card: 'card-visa-4242',
  agent: '0x0773a0a3ec5f88162ea52470b7973b2cfaaa846a',
  stopped: '0x0000000000000000000000000000000000000abc',
};

const work = mkdtempSync(join(tmpdir(), 'walletcap-fixtures-'));
try {
  // Schema 1, as 0.2.4 created it: the tables come from 0.2.4's own Ledger, the rows as 0.2.4's
  // SharedBudgetStore and Python Ledger kept them, under the names they were given.
  const one = join(work, 'schema-1.sqlite');
  new v024.Ledger(one, { clock: () => T0 - 5 * DAY }).close();
  const db = new DatabaseSync(one);
  const budget = db.prepare('INSERT INTO budgets VALUES (?, ?, ?, ?, ?, ?, NULL)');
  const spend = db.prepare('INSERT INTO spend VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const { app, frozen, merged, solana, card } = WALLETS;
  budget.run(app, 'usd', 150_000_000, DAY, null, null);
  budget.run(app.toLowerCase(), 'usd', 100_000_000, DAY, null, null);
  budget.run(frozen.toLowerCase(), 'usd', 150_000_000, DAY, null, null);
  budget.run(frozen, 'wei', 10 ** 15, DAY, null, null);
  budget.run(merged, 'usd', 150_000_000, DAY, null, null);
  budget.run(`eip155:8453:${merged}`, 'usdc', 300_000_000, DAY, 50_000_000, null);
  budget.run(merged.toLowerCase(), 'usd', 200_000_000, HOUR, null, 10);
  budget.run(`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${solana}`, 'usd', 50_000_000, DAY, null, null);
  budget.run(card, 'usd', 25_000_000, DAY, 10_000_000, null);
  spend.run('spend-a', merged, 100_000_000, 'committed', 'cdp', null, T0 - HOUR, null);
  spend.run('spend-b', `eip155:8453:${merged}`, 20_000_000, 'reserved', 'python', null, T0 - 2 * HOUR, null);
  spend.run('spend-c', merged.toLowerCase(), 10_000_000, 'committed', 'js', JSON.stringify({ tx: TX('ab') }), T0 - 10 * MIN, null);
  spend.run('spend-d', app.toLowerCase(), 30_000_000, 'reserved', 'x402', JSON.stringify({ to: merged, scheme: 'exact' }), T0 - 20 * MIN, T0 + 5 * MIN + DAY + 1);
  spend.run('spend-e', app, 40_000_000, 'committed', 'js', null, T0 - 2 * DAY, null);
  spend.run('spend-f', `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${solana}`, 5_000_000, 'reserved', 'js', JSON.stringify({ outcome: 'unknown', error: 'rpc timeout' }), T0 - 3 * HOUR, null);
  spend.run('spend-g', card, 2_500_000, 'committed', 'python', JSON.stringify({ tx: TX('cd'), note: 'one API call' }), T0 - 5 * MIN, null);
  db.close();
  copyFileSync(one, join(OUT, 'schema-1.sqlite'));

  // Schema 2, as 0.3.0 left it: the schema-1 file upgraded by 0.3.0, then payments 0.3.0 made.
  const two = join(work, 'schema-2.sqlite');
  copyFileSync(one, two);
  let now = T0 - 4 * DAY;
  clock030.setClock(() => now);
  const at = ms => { now = ms; };
  const agent = v030.openBudget({ wallet: WALLETS.agent, path: two, perPayment: '$50', perDay: '$150', create: true });
  const ok = tx => async () => tx;
  const fail = message => async () => { throw new Error(message); };
  at(T0 - 3 * DAY);
  await agent.pay('$9', ok(TX('01')), { to: WALLETS.merged, note: 'aged out' });
  at(T0 - 2 * DAY);
  agent.reserve('$8', { settlesBy: new Date(T0 - 2 * DAY + 5 * MIN), rail: 'x402' });
  at(T0 - 3 * HOUR);
  await agent.pay('$3', fail('rpc timeout')).catch(() => {});
  at(T0 - 2 * HOUR);
  await agent.pay('$10', ok(TX('02')), { to: WALLETS.merged });
  at(T0 - HOUR);
  agent.reserve('$20', { settlesBy: new Date(T0 + 2 * DAY), rail: 'x402' }).commit({ tx: TX('03') });
  at(T0 - 30 * MIN);
  agent.reserve('$5', { note: 'in flight' });
  at(T0 - 20 * MIN);
  agent.reserve('$4', { settlesBy: new Date(T0 + HOUR), rail: 'x402' }).annotate({ outcome: 'refused' });
  const store = agent.cdpStore({ asset: USDC });
  at(T0 - 15 * MIN);
  await store.append({ atomicAmount: 1_000_000n, asset: USDC, network: 'eip155:8453', payTo: WALLETS.merged, at: T0 - 15 * MIN });
  at(T0 - 12 * MIN);
  const rolledBack = { atomicAmount: 500_000n, asset: USDC, network: 'eip155:8453', payTo: WALLETS.merged, at: T0 - 12 * MIN };
  await store.append(rolledBack);
  await store.removeEntry(rolledBack);
  store.close();
  at(T0 - 10 * MIN);
  agent.reserve('$7', { settlesBy: new Date(T0 + 5 * MIN), rail: 'x402' });
  agent.close();
  at(T0 - HOUR);
  const stopped = v030.openBudget({ wallet: WALLETS.stopped, path: two, perDay: '$50', create: true });
  await stopped.pay('$5', ok(TX('04')));
  at(T0 - 30 * MIN);
  stopped.freeze();
  stopped.close();
  copyFileSync(two, join(OUT, 'schema-2.sqlite'));

  // What 0.3.0 counts in each file at each probe time, opened by every wallet's canonical name.
  const PROBES = [T0, T0 + 6 * MIN, T0 + HOUR + MIN, T0 + DAY - 11 * MIN, T0 + DAY + 2 * HOUR, T0 + 3 * DAY + MIN, T0 + 30 * DAY];
  const canonical = [WALLETS.app, WALLETS.frozen, WALLETS.merged, WALLETS.solana, WALLETS.card, WALLETS.agent, WALLETS.stopped];
  const expect = file => {
    const probes = [];
    for (const time of PROBES) {
      const copy = join(work, `probe-${time}.sqlite`);
      copyFileSync(file, copy);
      at(time);
      const budgets = {};
      for (const wallet of canonical) {
        let opened;
        try {
          opened = v030.openBudget({ wallet, path: copy });
        } catch {
          continue; // not in this file
        }
        const s = opened.status();
        budgets[s.wallet] = Object.fromEntries(['cap', 'window', 'perPayment', 'maxPayments', 'spent', 'inFlight', 'remaining', 'payments', 'frozen']
          .map(key => [key, typeof s[key] === 'bigint' ? Number(s[key]) : s[key]]));
        budgets[s.wallet].holds = opened.holds().map(hold => hold.id);
        opened.close();
      }
      probes.push({ at: time, budgets });
      rmSync(copy);
    }
    return { made: 'walletcap 0.3.0 counted these after opening the file', T0, probes };
  };
  writeFileSync(join(OUT, 'schema-1.expect.json'), `${JSON.stringify(expect(one), null, 2)}\n`);
  writeFileSync(join(OUT, 'schema-2.expect.json'), `${JSON.stringify(expect(two), null, 2)}\n`);
  clock030.resetClock();
} finally {
  rmSync(work, { recursive: true, force: true });
}
