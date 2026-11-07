// SPDX-License-Identifier: Apache-2.0
// Read a budget file back and check the ledger's invariants, from wc_entry alone:
// - SQLite's integrity check passes;
// - replaying wc_entry, in order, through spec/schema.sql's tables and projection gives the same
//   wc_current, so the projection is exactly what the entries say;
// - every 'held' entry was admissible: recomputing the counting rule over the entries before it,
//   at its own time, the budget had room for it. This is computed here, not read from wc_current.
// Usage: node scripts/race/check.mjs <budget.sqlite>
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const SCHEMA = readFileSync(new URL('../../spec/schema.sql', import.meta.url), 'utf8');
const section = name => {
  const start = SCHEMA.indexOf(`-- @section ${name}\n`);
  const end = SCHEMA.indexOf('\n-- @', start + 1);
  return SCHEMA.slice(start, end < 0 ? undefined : end);
};
const OPEN = (1n << 63n) - 1n;

export function check(path) {
  const db = new DatabaseSync(path);
  const all = sql => {
    const statement = db.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all();
  };
  const integrity = all('PRAGMA integrity_check')[0].integrity_check;
  const entries = all('SELECT * FROM wc_entry ORDER BY seq');
  const current = all('SELECT * FROM wc_current ORDER BY payment');
  const budgets = all('SELECT * FROM wc_budget ORDER BY wallet');
  db.close();

  // The projection, rebuilt from the entries.
  const replay = new DatabaseSync(':memory:');
  replay.exec(section('tables'));
  replay.exec(section('projection'));
  const columns = rows => (rows.length === 0 ? [] : Object.keys(rows[0]));
  const insert = (table, rows) => {
    const names = columns(rows);
    const statement = replay.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`);
    for (const row of rows) statement.run(...names.map(name => row[name]));
  };
  insert('wc_budget', budgets);
  insert('wc_entry', entries);
  const rebuilt = replay.prepare('SELECT * FROM wc_current ORDER BY payment');
  rebuilt.setReadBigInts(true);
  const replayed =
    JSON.stringify(rebuilt.all(), (_, v) => (typeof v === 'bigint' ? String(v) : v)) ===
    JSON.stringify(current, (_, v) => (typeof v === 'bigint' ? String(v) : v));
  replay.close();

  // Every admission, recomputed from the entries before it.
  const budget = new Map(budgets.map(row => [row.wallet, row]));
  const payments = new Map();
  // biome-ignore lint/complexity/useMathMinMax: these are bigints, which Math.max refuses
  const latest = (...times) => times.filter(time => time !== null).reduce((a, b) => (b > a ? b : a));
  const countsFrom = p => {
    if (p.state === 'void') return null;
    if (p.state === 'held') return p.until === null ? OPEN : latest(p.until, p.heldAt);
    return latest(p.settledAt, p.until, p.heldAt);
  };
  const violations = [];
  const kinds = { held: 0, bound: 0, noted: 0, settled: 0, void: 0 };
  for (const e of entries) {
    kinds[e.kind] += 1;
    if (e.kind === 'held') {
      const b = budget.get(e.wallet);
      const counting = [...payments.values()].filter(p => p.wallet === e.wallet && countsFrom(p) !== null && countsFrom(p) >= e.at - b.window_ms);
      const counted = counting.reduce((sum, p) => sum + p.amount, 0n);
      const why =
        b.frozen_at !== null
          ? 'frozen'
          : b.per_payment !== null && e.amount > b.per_payment
            ? 'per_payment'
            : counted + e.amount > b.cap
              ? 'budget'
              : b.max_payments !== null && BigInt(counting.length) >= b.max_payments
                ? 'max_payments'
                : null;
      if (why !== null) violations.push({ seq: Number(e.seq), payment: e.payment, why, counted: String(counted), amount: String(e.amount) });
      payments.set(e.payment, { wallet: e.wallet, amount: e.amount, state: 'held', heldAt: e.at, until: e.until, settledAt: null });
      continue;
    }
    const p = payments.get(e.payment);
    if (p === undefined) {
      violations.push({ seq: Number(e.seq), payment: e.payment, why: `${e.kind} for a payment never held` });
      continue;
    }
    if (e.kind === 'bound') p.until = e.until;
    else if (e.kind === 'settled') Object.assign(p, { state: 'settled', settledAt: e.at });
    else if (e.kind === 'void') p.state = 'void';
  }
  return { integrity, replayed, entries: entries.length, payments: payments.size, kinds, violations };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = check(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.integrity === 'ok' && result.replayed && result.violations.length === 0 ? 0 : 1;
}
