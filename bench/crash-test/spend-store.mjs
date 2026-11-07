// SPDX-License-Identifier: Apache-2.0
// A SpendStore built the way Coinbase's docs ask: CDP's interface over a shared, durable backend,
// so every replica reads one ledger. "For production workloads where the cap must be enforced
// across restarts or replicas, implement this interface against a shared durable backend"
// (@coinbase/cdp-sdk, src/x402/guardrails/types.ts).
//
// It does exactly what the interface says. The interface has no step that checks the cap and
// records a payment together: CDP loads the total, decides, then appends, and its lock covers one
// process. Replicas sharing this store can each read the same total before any of them appends.
//
// The ledger is a SQLite file, so every replica on this machine shares it, and each call answers
// after `latencyMs`, as a store over the network does (Redis, Postgres or DynamoDB, a millisecond
// or more away). That gap between CDP's check and its record is where replicas overlap; a store in
// the same process answers in microseconds and hides it.
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

export class SharedSpendStore {
  #db;
  #latency;

  constructor(path, { latencyMs = 1 } = {}) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout = 10000');
    this.#db.exec('CREATE TABLE IF NOT EXISTS ledger (atomic TEXT NOT NULL, asset TEXT NOT NULL, network TEXT NOT NULL, pay_to TEXT NOT NULL, at INTEGER NOT NULL)');
    this.#latency = latencyMs;
  }

  async #roundTrip(work) {
    if (this.#latency > 0) await sleep(this.#latency);
    return work();
  }

  async size() {
    return this.#roundTrip(() => Number(this.#db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n));
  }

  async load() {
    return this.#roundTrip(() => this.#db.prepare('SELECT * FROM ledger ORDER BY at').all().map(row => ({
      atomicAmount: BigInt(row.atomic), asset: row.asset, network: row.network, payTo: row.pay_to, at: Number(row.at),
    })));
  }

  async append(entry) {
    return this.#roundTrip(() => {
      this.#db.prepare('INSERT INTO ledger VALUES (?, ?, ?, ?, ?)')
        .run(String(entry.atomicAmount), entry.asset, entry.network, entry.payTo, entry.at);
    });
  }

  async prune(olderThanMs) {
    return this.#roundTrip(() => {
      this.#db.prepare('DELETE FROM ledger WHERE at < ?').run(olderThanMs);
    });
  }

  async removeEntry(entry) {
    return this.#roundTrip(() => {
      this.#db.prepare('DELETE FROM ledger WHERE rowid = (SELECT rowid FROM ledger WHERE atomic = ? AND asset = ? AND network = ? AND pay_to = ? AND at = ? LIMIT 1)')
        .run(String(entry.atomicAmount), entry.asset, entry.network, entry.payTo, entry.at);
    });
  }

  close() {
    this.#db.close();
  }
}

/**
 * Any SpendStore, answering each call after `latencyMs` as SharedSpendStore does. The shared-store
 * row puts walletcap's store at the same distance, so CDP's check and its record are as far apart.
 */
export function withLatency(store, latencyMs) {
  const call = method => async (...args) => {
    await sleep(latencyMs);
    return store[method](...args);
  };
  return {
    size: call('size'),
    load: call('load'),
    append: call('append'),
    prune: call('prune'),
    removeEntry: call('removeEntry'),
    close: () => store.close(),
  };
}
