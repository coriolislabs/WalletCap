// SPDX-License-Identifier: Apache-2.0
// Internal (not exported by the package): node:sqlite, loaded once. Kept apart from ledger.ts so
// the public declarations never name node:sqlite's types.
import { createRequire } from 'node:module';
import { BudgetUnavailable } from './errors.js';

type Sqlite = typeof import('node:sqlite');

// node:sqlite prints an ExperimentalWarning when it loads (Node 22 and 24). Load it once with
// that one warning held back, so an agent's logs stay clean.
const require = createRequire(import.meta.url);
let sqlite: Sqlite | undefined;

/** node:sqlite, or BudgetUnavailable on a Node that has none. */
export const loadSqlite = (): Sqlite => {
  if (sqlite !== undefined) return sqlite;
  const emitWarning = process.emitWarning;
  process.emitWarning = function quietSqlite(this: unknown, warning: string | Error, ...rest: unknown[]) {
    const [first] = rest;
    const type = typeof first === 'string' ? first : (first as { type?: string } | undefined)?.type;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(String((warning as Error)?.message ?? warning))) return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqlite = require('node:sqlite') as Sqlite;
  } catch (error) {
    throw new BudgetUnavailable(`walletcap needs Node 22.13 or later, for node:sqlite (${(error as Error).message})`, { cause: error });
  } finally {
    process.emitWarning = emitWarning;
  }
  return sqlite;
};
