// SPDX-License-Identifier: Apache-2.0
// walletcap watch: every entry the ledger takes, as it happens, while an agent runs. It opens the
// file read-only and changes nothing: no upgrade, no journal switch, no write. The Python
// package's walletcap/_watch.py reads the same rows and prints the same lines.
import { existsSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadSqlite } from '../core/_sqlite.js';
import { pathFlag, statusOf } from '../core/budget.js';
import { BudgetUnavailable, isWalletcapError } from '../core/errors.js';
import { loadSpec, MIN_SQLITE_VERSION, SCHEMA_VERSION, type StatusRow, versionAtLeast } from '../core/ledger.js';
import { formatUsd, type Micros, normalizeWallet, shortWallet, toWindowMs } from '../core/money.js';
import { toWire } from '../core/wire.js';

/** One entry of the ledger as watch prints it. `--json` prints these keys, in this order. */
export interface WatchEntry {
  seq: bigint;
  at: Date;
  kind: 'held' | 'bound' | 'noted' | 'settled' | 'void';
  payment: string;
  wallet: string;
  /** Micro-dollars. */
  amount: Micros;
  /** held, bound: the last moment the payment could settle. */
  until: Date | null;
  /** noted: 'unknown' or 'refused'. */
  outcome: string | null;
  /** The rail, payee and note of the payment's hold, on every entry of the payment. */
  rail: string | null;
  to: string | null;
  note: string | null;
  /** noted, settled, void: what showed it. */
  evidence: string | null;
  /** What the wallet's budget had left when this entry was read, in micro-dollars. */
  remaining: Micros | null;
}

export interface WatchOptions {
  /** Watch this wallet's budget only. */
  wallet?: string | undefined;
  /** First print the entries of this long ago until now: a duration, as --older-than takes one. */
  since?: string | undefined;
  /** Stop after this long. */
  for?: string | undefined;
  /** JSON Lines, one object an entry, and no lines of its own. */
  json?: boolean | undefined;
  /** The command line's filter for text a payer or payee wrote. */
  plain: (text: string) => string;
  out?: NodeJS.WritableStream;
}

// How often the ledger is asked for new entries, and the most it hands over at once.
const INTERVAL_MS = 500;
const BATCH = 500;
const BUSY = 5;
// The ledger keeps times up to 10^15 ms, about the year 33,658. Python's datetime stops at the end
// of 9999, so both command lines print a later time as that moment.
const LAST_MOMENT = 253_402_300_799_999n;

// An entry and its payment's hold, which carries the rail, the payee and the note.
const ENTRIES_SQL = `
SELECT e.seq, e.at, e.kind, e.payment, e.wallet, e.amount, e.until, e.outcome, e.evidence, h.rail, h.info
FROM wc_entry e LEFT JOIN wc_entry h ON h.payment = e.payment AND h.kind = 'held'
WHERE e.seq > :after AND (:wallet IS NULL OR e.wallet = :wallet)
ORDER BY e.seq
LIMIT :batch
`;
// Where watch starts: after the ledger's last entry, or after the last one older than --since by
// the ledger's own clock.
const END_SQL = 'SELECT coalesce(max(seq), 0) AS seq FROM wc_entry';
const SINCE_SQL = `
SELECT coalesce((SELECT seq FROM wc_entry WHERE at < (SELECT now FROM wc_clock) - :since_ms ORDER BY seq DESC LIMIT 1), 0) AS seq
`;

type Db = InstanceType<ReturnType<typeof loadSqlite>['DatabaseSync']>;

interface EntryRow {
  seq: bigint;
  at: bigint;
  kind: WatchEntry['kind'];
  payment: string;
  wallet: string;
  amount: bigint;
  until: bigint | null;
  outcome: string | null;
  evidence: string | null;
  rail: string | null;
  info: string | null;
}

const unusable = (path: string, error: unknown): BudgetUnavailable =>
  new BudgetUnavailable(`the budget file ${path} cannot be used: ${(error as Error)?.message ?? error}`, { cause: error });

const isBusy = (error: unknown): boolean => (Number((error as { errcode?: unknown })?.errcode) & 0xff) === BUSY;

const moment = (ms: bigint): Date => new Date(Number(ms > LAST_MOMENT ? LAST_MOMENT : ms < 0n ? 0n : ms));

// The JSON a payer kept with its hold. A payee wrote some of it, so a field is read only if it
// is the string it should be.
const infoOf = (text: string | null): Record<string, unknown> => {
  try {
    const info: unknown = text ? JSON.parse(text) : {};
    return info !== null && typeof info === 'object' ? (info as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const entryOf = (row: EntryRow, remaining: Micros | null): WatchEntry => {
  const info = infoOf(row.info);
  return {
    seq: row.seq,
    at: moment(row.at),
    kind: row.kind,
    payment: row.payment,
    wallet: row.wallet,
    amount: row.amount as Micros,
    until: row.until === null ? null : moment(row.until),
    outcome: row.outcome,
    rail: row.rail,
    to: textOf(info.to) ?? textOf(info.payTo),
    note: textOf(info.note),
    evidence: row.evidence,
    remaining,
  };
};

const isoSeconds = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * One entry as a line of text: when, what, how much, on which rail, to whom, what the entry
 * says, the payment's id, and what the budget has left. `many` adds the wallet, for a file with
 * more than one budget. Everything the file holds as text goes through `plain`.
 */
export function watchLine(entry: WatchEntry, { many, plain }: { many: boolean; plain: (text: string) => string }): string {
  const evidence = entry.evidence ? plain(entry.evidence) : '';
  const says =
    entry.kind === 'noted'
      ? [plain(entry.outcome ?? ''), evidence].filter(Boolean).join(': ')
      : entry.kind === 'settled' && evidence
        ? `tx ${evidence}`
        : evidence;
  return [
    `${entry.at.toISOString().slice(11, 19)}Z`,
    entry.kind.padEnd(7),
    formatUsd(entry.amount).padStart(10),
    many ? plain(shortWallet(entry.wallet)) : '',
    entry.rail ? plain(entry.rail).padEnd(6) : '',
    entry.to ? `to ${plain(shortWallet(entry.to.toLowerCase()))}` : '',
    plain(entry.note ?? ''),
    entry.until === null ? '' : `settles by ${isoSeconds(entry.until)}`,
    says,
    plain(entry.payment),
    entry.remaining === null ? '' : `(${formatUsd(entry.remaining)} left)`,
  ]
    .filter(Boolean)
    .join('  ');
}

// Which file a path names right now, or null if it names none.
const fileIdentity = (path: string): { dev: bigint; ino: bigint } | null => {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stat === undefined ? null : { dev: stat.dev, ino: stat.ino };
};

// The budget file, open for reading only, once it is known to be a budget at this version's schema.
const open = (path: string): Db => {
  if (!existsSync(path)) {
    throw new BudgetUnavailable(`no budget file at ${path}: its owner creates one with walletcap set --wallet <address> --per-day <dollars>`);
  }
  let db: Db;
  try {
    const { DatabaseSync } = loadSqlite();
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw isWalletcapError(error) ? error : unusable(path, error);
  }
  try {
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec('PRAGMA query_only = ON');
    const { version } = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    if (!versionAtLeast(version, MIN_SQLITE_VERSION)) {
      throw new BudgetUnavailable(`walletcap needs SQLite ${MIN_SQLITE_VERSION} or later; this Node has ${version}`);
    }
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]).map(row => row.name);
    if (tables.length === 0) throw new BudgetUnavailable(`${path} is empty: walletcap set --wallet <address> --per-day <dollars> creates the budget`);
    const schema = tables.includes('budget_meta')
      ? ((db.prepare("SELECT value FROM budget_meta WHERE key = 'schema'").get() as { value: string } | undefined)?.value ?? null)
      : null;
    if (schema === null) throw new BudgetUnavailable(`${path} is a SQLite file, not a walletcap budget`);
    if (schema === '1' || schema === '2') {
      // Upgrading is a write, and one that every older process must be stopped for.
      throw new BudgetUnavailable(
        `${path} is at schema ${schema}, which an older walletcap wrote, and watch only reads. Stop every older walletcap process, ` +
          `open the file once with this version to upgrade it (walletcap status${pathFlag(path)}), then watch it`,
      );
    }
    if (schema !== SCHEMA_VERSION) {
      throw new BudgetUnavailable(`${path} is at schema ${schema}, which a newer walletcap wrote; this one reads ${SCHEMA_VERSION}`);
    }
    return db;
  } catch (error) {
    db.close();
    throw isWalletcapError(error) ? error : unusable(path, error);
  }
};

/**
 * Print every entry the budget file at `path` takes, oldest first, until the process is
 * interrupted or `for` has passed. Reads only.
 */
export async function watch(path: string, options: WatchOptions): Promise<void> {
  const { plain, out = process.stdout } = options;
  const only = options.wallet === undefined ? null : normalizeWallet(options.wallet);
  const sinceMs = options.since === undefined ? null : toWindowMs(options.since, '--since');
  const forMs = options.for === undefined ? null : toWindowMs(options.for, '--for');

  // An interrupt, or a reader that went away (walletcap watch | head), ends the watch: exit 0.
  // The pipe's handler stays on, for the writes still on their way out.
  const stop = new AbortController();
  const halt = (): void => stop.abort();
  process.once('SIGINT', halt);
  process.once('SIGTERM', halt);
  out.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
    halt();
  });

  let db: Db | undefined;
  try {
    const file = open(path);
    db = file;
    const identity = fileIdentity(path);
    const prepare = (sql: string | undefined) => {
      if (sql === undefined) throw new Error('spec: a statement watch runs is missing');
      const statement = file.prepare(sql);
      statement.setReadBigInts(true);
      return statement;
    };
    const { statements } = loadSpec().schema;
    const status = prepare(statements.status);
    const budgets = prepare(statements.budgets);
    const entries = prepare(ENTRIES_SQL);
    const remainingOf = (wallet: string): Micros | null => (status.get({ wallet }) as unknown as StatusRow | undefined)?.remaining ?? null;
    // One read transaction: the entries and what each budget has left are of one moment.
    const reading = <T>(work: () => T): T => {
      try {
        file.exec('BEGIN');
        const result = work();
        file.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          file.exec('ROLLBACK');
        } catch {
          /* no transaction to roll back */
        }
        throw error;
      }
    };

    // Where to start, and what each watched budget holds as the watch starts.
    let last = 0n;
    let summaries: string[];
    try {
      summaries = reading(() => {
        const watched = only === null ? (budgets.all() as unknown as { wallet: string }[]).map(row => row.wallet) : [only];
        const rows = watched.map(wallet => status.get({ wallet }) as unknown as StatusRow | undefined);
        if (only !== null && rows[0] === undefined) {
          throw new BudgetUnavailable(
            `${shortWallet(only)} has no budget in ${path}: its owner creates one with walletcap set --wallet ${only} --per-day <dollars>`,
          );
        }
        if (rows.length === 0) throw new BudgetUnavailable(`no budget in ${path} yet: walletcap set --wallet <address> --per-day <dollars>`);
        const start = sinceMs === null ? prepare(END_SQL).get() : prepare(SINCE_SQL).get({ since_ms: sinceMs });
        last = (start as unknown as { seq: bigint }).seq;
        return rows.flatMap(row => (row === undefined ? [] : [statusOf(row, path).summary]));
      });
    } catch (error) {
      throw isWalletcapError(error) ? error : unusable(path, error);
    }
    if (!options.json) out.write(`${[`Watching ${path}`, ...summaries, ''].join('\n')}\n`);

    // The entries the ledger took since the last read, as the lines to print.
    const read = (): string[] => {
      // This connection keeps the file it opened, even once that file is deleted or another is
      // moved into its place: it would go on watching a ledger no payment is counted in.
      const now = fileIdentity(path);
      if (identity !== null && (now === null || now.dev !== identity.dev || now.ino !== identity.ino)) {
        throw new BudgetUnavailable(
          now === null
            ? `the budget file ${path} was removed while walletcap watched it`
            : `the budget file ${path} was replaced while walletcap watched it: run walletcap watch again to watch the file now there`,
        );
      }
      return reading(() => {
        const rows = entries.all({ after: last, wallet: only, batch: BATCH }) as unknown as EntryRow[];
        const many = only === null && budgets.all().length > 1;
        const left = new Map<string, Micros | null>();
        const lines = rows.map(row => {
          if (!left.has(row.wallet)) left.set(row.wallet, remainingOf(row.wallet));
          const entry = entryOf(row, left.get(row.wallet) ?? null);
          return options.json ? JSON.stringify(toWire(entry)) : watchLine(entry, { many, plain });
        });
        last = rows.at(-1)?.seq ?? last;
        return lines;
      });
    };

    const deadline = forMs === null ? Number.POSITIVE_INFINITY : performance.now() + Number(forMs);
    for (;;) {
      for (;;) {
        let lines: string[];
        try {
          lines = read();
        } catch (error) {
          // Another process holds the file's lock: its entries are read the next time round.
          if (isBusy(error)) break;
          throw isWalletcapError(error) ? error : unusable(path, error);
        }
        if (lines.length > 0) out.write(`${lines.join('\n')}\n`);
        if (lines.length < BATCH || stop.signal.aborted) break;
      }
      const left = deadline - performance.now();
      if (stop.signal.aborted || left <= 0) break;
      try {
        await sleep(Math.min(INTERVAL_MS, left), undefined, { signal: stop.signal });
      } catch {
        break;
      }
    }
  } finally {
    db?.close();
    process.off('SIGINT', halt);
    process.off('SIGTERM', halt);
  }
}
