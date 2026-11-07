// SPDX-License-Identifier: Apache-2.0
// The ledger reads its clock in SQL (spec/schema.sql, wc_clock): SQLite's julianday('now').
// No option changes it. walletcap's own tests move it through setClock(), which this module
// keeps for them and the package does not export: it replaces julianday('now') on the test
// process's own connections, and nowhere else.
import type { DatabaseSync } from 'node:sqlite';

let source: (() => number | bigint) | null = null;
let read: number | null = null;
const connections = new Set<DatabaseSync>();

// SQLite keeps 'now' fixed for a whole statement; a test clock is read once per transaction, so
// a moving one (Date.now) can't give one statement two times.
const install = (db: DatabaseSync): void => db.function('julianday', { varargs: true, deterministic: false }, (...args) => {
  if (args.length !== 1 || args[0] !== 'now') throw new Error("walletcap's test clock answers julianday('now') only");
  read ??= Number(source === null ? Date.now() : source());
  return read / 86_400_000 + 2_440_587.5;
});

/** Internal: the ledger calls this as each transaction begins. */
export function clockTick(): void {
  read = null;
}

/** Internal: the ledger registers each connection it opens, and forgets it on close. */
export function attachClock(db: DatabaseSync): void {
  connections.add(db);
  if (source !== null) install(db);
}

export function detachClock(db: DatabaseSync): void {
  connections.delete(db);
}

/** For walletcap's tests only: read the time, in milliseconds, from `clock` until resetClock(). */
export function setClock(clock: () => number | bigint): void {
  if (typeof clock !== 'function') throw new TypeError('setClock takes a function that returns milliseconds');
  source = clock;
  clockTick();
  for (const db of connections) install(db);
}

/** For walletcap's tests only: back to the system clock. */
export function resetClock(): void {
  source = null;
  clockTick();
}
