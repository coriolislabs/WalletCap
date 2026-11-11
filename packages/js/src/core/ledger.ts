// SPDX-License-Identifier: Apache-2.0
// The budget file's client. The rule is not in this module: spec/schema.sql holds the tables,
// the counting rule and admission, and this module runs its statements by name, as the Python
// package does. What it adds is reading input, opening and upgrading the file, waiting for
// another process's write lock on the event loop (each try holds it for at most SQLite's own
// 10 ms wait), and wording refusals. The file
// serves one host: SQLite's locks aren't reliable over NFS, SMB or Docker Desktop bind mounts.
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { SCHEMA_SQL, UPGRADE_SQL } from './_spec.generated.js';
import { attachClock, clockTick, detachClock } from './_clock.js';
import { stampLedgerTime } from './_decisions.js';
import { loadSqlite } from './_sqlite.js';
import { BudgetRefused, BudgetUnavailable, isWalletcapError, type RefusalSource, UsageError } from './errors.js';
import { formatAmount, formatWindow, MAX_AMOUNT, type Micros, normalizeWallet, shortWallet } from './money.js';

/** The file's format. 0.4 upgrades a 0.2 (1) or 0.3 (2) file when it opens it; they refuse 3. */
export const SCHEMA_VERSION = '3';
/** The oldest SQLite the ledger runs on: STRICT tables arrived in 3.37.0. */
export const MIN_SQLITE_VERSION = '3.37.0';
/**
 * How long after its failure was noted an x402 hold with no settle-by time waits for the owner's
 * bulk release: an hour, the longest an x402 authorization walletcap signs can be redeemed, and a
 * minute. The wallet signs, if at all, before it answers, so the hour counts from the failure.
 * The rule is in spec/schema.sql (void_unknown); this is its value, for messages.
 */
export const UNBOUNDED_HOLD_MS = 3_660_000n;
/** The most a time or a duration can be, in milliseconds: about 31,700 years. */
export const MAX_TIME = 10n ** 15n;
/** The tables walletcap 0.2 and 0.3 create, empty, in a newer file before they refuse it: spend first (it references budgets). */
const LEGACY_TABLES = ['spend', 'budgets'];
/** counts_from of a held payment with no bound: it counts until evidence ends it. */
export const OPEN = (1n << 63n) - 1n;

const ID = /^[A-Za-z0-9_.:@/+-]{1,160}$/;
const RAIL = /^[A-Za-z0-9_.:@/-]{1,64}$/;
const INFO_LIMIT = 4096;
const EVIDENCE_LIMIT = 1024;
const BUSY = 5;
// SQLite's own wait for a lock, per try: short, because node:sqlite waits on this thread. The
// rest of busyTimeoutMs is waited out between tries, on the event loop.
const SQLITE_BUSY_TIMEOUT_MS = 10;
const MAX_BACKOFF_MS = 50;

export type PaymentState = 'held' | 'settled' | 'void';
export type Outcome = 'unknown' | 'refused';

/** A budget's limits as the file keeps them. */
export interface BudgetRow {
  wallet: string;
  unit: string;
  cap: Micros;
  window_ms: bigint;
  per_payment: Micros | null;
  max_payments: bigint | null;
  frozen_at: bigint | null;
  merged_from: string | null;
  frozen_by: string | null;
}

/** One payment's latest state, from the payment, history and counting statements. */
export interface PaymentRow {
  payment: string;
  wallet: string;
  amount: Micros;
  state: PaymentState;
  outcome: Outcome | null;
  held_at: bigint;
  until: bigint | null;
  counts_from: bigint | null;
  counting: bigint | null;
  window_ms: bigint;
  rail: string;
  info: string | null;
  now: bigint;
  settled_by: string | null;
  noted: string | null;
}

/** A payment after a move. `moved` is false when the call appended nothing: the move was already made. */
export interface Moved extends PaymentRow {
  moved: boolean;
}

/** What counts against a budget now: the status statement. */
export interface StatusRow {
  wallet: string;
  unit: string;
  now: bigint;
  cap: Micros;
  window_ms: bigint;
  per_payment: Micros | null;
  max_payments: bigint | null;
  frozen_at: bigint | null;
  counted: Micros;
  payments: bigint;
  room: Micros;
  remaining: Micros;
  spent: Micros;
  in_flight: Micros;
  merged_from: string | null;
  frozen_by: string | null;
}

/** Why a hold appended nothing: the refusal statement. */
export interface RefusalRow {
  code: 'frozen' | 'per_payment' | 'budget' | 'max_payments' | null;
  source: RefusalSource;
  wallet: string;
  unit: string;
  now: bigint;
  cap: Micros;
  window_ms: bigint;
  per_payment: Micros | null;
  max_payments: bigint | null;
  frozen_at: bigint | null;
  counted: Micros;
  payments: bigint;
  p_counted: Micros;
  p_payments: bigint;
  held: Micros;
  held_payments: bigint;
  frozen_by: string | null;
  existing: string | null;
  settles_too_soon: bigint;
}

/**
 * A hold the ledger admitted, or the payment already under that identity. `holder` is the token
 * the paying process's later moves need (ledger.md, Identity): set only when this call held it.
 */
export interface Held {
  payment: string;
  at: bigint | null;
  until: bigint | null;
  state: PaymentState;
  holder: string | null;
}

/** An open payment a refusal names for the owner. */
export interface OpenHold {
  payment: string;
  rail: string;
  until: bigint | null;
}

/** Why a process without a payment's token can't move it. */
export const heldElsewhere = (payment: string, verb: string): string =>
  `payment ${payment} was held by another process: only that process, or the budget's owner, can ${verb} it`;

const HOLDER = /^[0-9a-f]{32}$/;
const holderToken = (value: string | null): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || !HOLDER.test(value)) throw new UsageError('a holder token is 32 lowercase hex digits');
  return value;
};

/** The paying process's own limits, which only tighten the budget's, for that process. */
export interface ProcessLimits {
  perPayment?: bigint | null;
  cap?: bigint | null;
  windowMs?: bigint | null;
  maxPayments?: bigint | null;
}

interface OwnLimits {
  perPayment: bigint | null;
  cap: bigint | null;
  windowMs: bigint | null;
  maxPayments: bigint | null;
}

export interface LedgerOptions {
  /** How long to wait for another process's write lock, in milliseconds. Defaults to 30000. */
  busyTimeoutMs?: number;
  /** Create the file (0600, its folder 0700) if it is missing. Defaults to false. */
  create?: boolean;
}

/** One spec file, split on its '-- @' lines. */
export interface Spec {
  sections: Record<string, string>;
  fragments: Record<string, string>;
  statements: Record<string, string>;
}

/**
 * spec/schema.sql and spec/upgrade.sql split on their '-- @' lines: sections run whole,
 * fragments are spliced into statements as {{name}}, and statements run by name. Comment lines
 * inside fragments and statements are dropped.
 */
export function parseSpec(text: string): Spec {
  const parsed: Spec = { sections: {}, fragments: {}, statements: {} };
  const kinds = { section: 'sections', fragment: 'fragments', statement: 'statements' } as const;
  let into: (typeof kinds)[keyof typeof kinds] | null = null;
  let name = '';
  let lines: string[] = [];
  const flush = (): void => {
    if (into !== null) parsed[into][name] = lines.join('\n').trim();
    lines = [];
  };
  for (const line of text.split('\n')) {
    const marker = /^-- @(section|fragment|statement) ([a-z_]+)\s*$/.exec(line);
    if (marker) {
      flush();
      into = kinds[marker[1] as keyof typeof kinds];
      name = marker[2] ?? '';
    } else if (into !== null && !(into !== 'sections' && /^\s*--/.test(line))) {
      lines.push(line);
    }
  }
  flush();
  for (const [key, sql] of Object.entries(parsed.statements)) {
    parsed.statements[key] = sql.replace(/\{\{([a-z_]+)\}\}/g, (_, fragment: string) => {
      const text = parsed.fragments[fragment];
      if (text === undefined) throw new Error(`spec: no fragment ${fragment}`);
      return text;
    });
  }
  return parsed;
}

let spec: { schema: Spec; upgrade: Spec } | undefined;
/**
 * spec/schema.sql and spec/upgrade.sql, parsed once. The build compiles their text into the
 * package (_spec.generated.ts), so nothing is read from disk and a bundler carries it along.
 */
export function loadSpec(): { schema: Spec; upgrade: Spec } {
  spec ??= { schema: parseSpec(SCHEMA_SQL), upgrade: parseSpec(UPGRADE_SQL) };
  return spec;
}

const section = (spec: Spec, name: string): string => {
  const sql = spec.sections[name];
  if (sql === undefined) throw new Error(`spec: no section ${name}`);
  return sql;
};

// A statement's :named parameters, outside its string literals.
const parameterNames = (sql: string): string[] => [
  ...new Set([...sql.replace(/'(?:[^']|'')*'/g, "''").matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1] ?? '')),
];

/** Internal: whether a dotted version is at least `least`. */
export const versionAtLeast = (version: string, least: string): boolean => {
  const [a, b] = [version, least].map(text => text.split('.').map(Number)) as [number[], number[]];
  for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

// --- Reading input ------------------------------------------------------------------------

/** The name a wallet's budget is kept under (money's normalizeWallet). */
export const walletKey = (value: unknown): string => normalizeWallet(value);

const whole = (value: unknown, label: string, { min, max }: { min: bigint; max: bigint }): bigint => {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^[0-9]+$/.test(value)) parsed = BigInt(value);
  else throw new UsageError(`${label} must be an integer`);
  if (parsed < min || parsed > max) throw new UsageError(`${label} must be an integer from ${min} to ${max}`);
  return parsed;
};

/** An amount in the budget's own unit, from 1 (or 0) to MAX_AMOUNT. */
export const units = (value: unknown, label: string, { allowZero = false }: { allowZero?: boolean } = {}): Micros =>
  whole(value, label, { min: allowZero ? 0n : 1n, max: MAX_AMOUNT }) as Micros;

/** A time or a duration in milliseconds. */
export const millis = (value: unknown, label: string, { min = 0n }: { min?: bigint } = {}): bigint =>
  whole(value instanceof Date ? value.getTime() : value, label, { min, max: MAX_TIME });

/** A payment's identity: the rail's own (eip3009:<from>:<nonce>, tx:<hash>) or the caller's key. */
export const paymentId = (value: unknown): string => {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new UsageError('a payment id is 1 to 160 of letters, digits and _ . : @ / + -');
  }
  return value;
};

// The id of a payment about to be held: one a command line won't read as an option.
const newPaymentId = (value: unknown): string => {
  const id = paymentId(value);
  if (id.startsWith('-')) throw new UsageError("a payment id can't start with '-': a command line reads it as an option");
  return id;
};

const railName = (value: unknown): string => {
  if (typeof value !== 'string' || !RAIL.test(value)) throw new UsageError('rail must be a plain identifier');
  return value;
};

const text = (value: unknown, label: string, limit: number): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > limit) throw new UsageError(`${label} must be a string of at most ${limit} characters`);
  return value;
};

// --- Wording ------------------------------------------------------------------------------

const plural = (count: bigint): string => (count === 1n ? '' : 's');
const mergedNote = (names: string[]): string =>
  `The 0.3.0 upgrade merged the budget${names.length === 1 ? '' : 's'} 0.2.x kept under ${names.join(', ')} ` +
  "into this one, with the tighter of each limit; its owner can change them with 'walletcap set'";
const frozenNote = ({ kept, aside }: { kept: string; aside: { name: string; unit: string }[] }): string =>
  `The 0.3.0 upgrade froze it: 0.2.x also kept ${aside.map(({ name, unit }) => `a budget in ${unit} under ${name}`).join(' and ')} ` +
  `for this wallet, which can't be merged with this one in ${kept}, so ${aside.length === 1 ? 'that budget no longer counts' : 'those budgets no longer count'}`;
const parsedNote = <T>(json: string | null | undefined, word: (value: T) => string): string | null => {
  if (json === null || json === undefined) return null;
  try {
    return word(JSON.parse(json) as T);
  } catch {
    return null;
  }
};
/** What an upgrade merged into this budget, or null. */
export const mergedNoteOf = (json: string | null): string | null => parsedNote(json, mergedNote);

const isoSeconds = (ms: bigint): string => new Date(Number(ms)).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * What a payment the CDP store holds is, for an owner deciding whether to void it: CDP signed its
 * authorization, which a payee can redeem until an hour and a minute after CDP recorded it.
 */
export const cdpHoldNote = (hold: { payment: string; until: bigint | null }): string =>
  `${hold.payment} is a payment CDP signed: ` +
  `its authorization can be redeemed until ${hold.until === null ? 'an hour and a minute after CDP recorded it' : isoSeconds(hold.until)}, ` +
  'so void it only if the chain shows it was never redeemed';

const heldNote = (heldPayments: bigint, holds: OpenHold[]): string => {
  const more = heldPayments > BigInt(holds.length) ? ` and ${heldPayments - BigInt(holds.length)} more` : '';
  const cdp = holds.filter(hold => hold.rail === 'cdp').map(cdpHoldNote);
  return (
    `${holds.map(hold => hold.payment).join(', ')}${more}; walletcap holds lists them, and if one never left the wallet its owner can void it` +
    (cdp.length === 0 ? '' : `. ${cdp.join('; ')}`)
  );
};

/**
 * The refusal for `why` (a row of the refusal statement): the code, a brief an agent is told,
 * and a message that also names, for the owner, the open payments that take up the room.
 */
export function refusal(why: RefusalRow, amount: bigint, limits: OwnLimits, openIds: () => OpenHold[]): BudgetRefused {
  const { source } = why;
  // Dated with the ledger's time for it, which the decision log reports.
  const refused = (code: 'frozen' | 'per_payment' | 'budget' | 'max_payments', message: string, brief = message): BudgetRefused =>
    stampLedgerTime(new BudgetRefused(code, message, { brief, source }), why.now);
  const name = shortWallet(why.wallet);
  const money = (value: bigint): string => formatAmount(value, why.unit);
  const window = formatWindow(why.window_ms);
  if (why.code === 'frozen') {
    const note = parsedNote(why.frozen_by, frozenNote);
    return refused('frozen', `${name}'s budget is frozen: nothing can be paid until its owner unfreezes it${note === null ? '' : `. ${note}`}`);
  }
  if (source === 'process') {
    const own = limits.windowMs === null ? window : formatWindow(limits.windowMs);
    if (why.code === 'per_payment')
      return refused('per_payment', `${money(amount)} is over the ${money(limits.perPayment ?? 0n)} limit per payment this process set`);
    if (why.code === 'budget') {
      const cap = limits.cap ?? 0n;
      const left = cap > why.p_counted ? cap - why.p_counted : 0n;
      return refused(
        'budget',
        `${money(amount)} would bring ${name} to ${money(why.p_counted + amount)} in the last ${own}, ` +
          `over the ${money(cap)} limit this process set (${money(left)} left)`,
      );
    }
    return refused('max_payments', `${name} already made ${why.p_payments} payment${plural(why.p_payments)} in the last ${own}, the most this process allows`);
  }
  if (why.code === 'per_payment') return refused('per_payment', `${money(amount)} is over ${name}'s ${money(why.per_payment ?? 0n)} limit per payment`);
  const held = why.held_payments;
  if (why.code === 'budget') {
    const left = why.cap > why.counted ? why.cap - why.counted : 0n;
    const over = `${money(amount)} would bring ${name} to ${money(why.counted + amount)} in the last ${window}, over its ${money(why.cap)} limit (${money(left)} left)`;
    if (held === 0n) return refused('budget', over);
    const brief = `${over}; ${money(why.held)} of it is ${held} open payment${plural(held)}`;
    return refused('budget', `${brief} (${heldNote(held, openIds())})`, brief);
  }
  if (held === 0n) {
    return refused('max_payments', `${name} already made ${why.payments} payment${plural(why.payments)} in the last ${window}, the most its budget allows`);
  }
  const brief =
    `${name} has ${why.payments} payment${plural(why.payments)} counting in the last ${window}, the most its budget allows, ` +
    `and ${held} of them ${held === 1n ? 'is' : 'are'} still open`;
  return refused('max_payments', `${brief} (${heldNote(held, openIds())})`, brief);
}

// --- The ledger ---------------------------------------------------------------------------

const unusable = (path: string, error: unknown): BudgetUnavailable =>
  new BudgetUnavailable(`the budget file ${path} cannot be used: ${(error as Error)?.message ?? error}`, { cause: error });

/** A guard trigger's refusal ('walletcap: …'), or null. */
const guardMessage = (error: unknown): string | null => {
  const message = String((error as Error)?.message ?? '');
  const at = message.indexOf('walletcap: ');
  return at < 0 ? null : message.slice(at + 'walletcap: '.length);
};

// Another process holds the write lock: the attempt is retried after a wait.
class Busy extends Error {}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

// Which file a path names right now, or null if it names none.
const fileIdentity = (path: string): FileIdentity | null => {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stat === undefined ? null : { dev: stat.dev, ino: stat.ino };
};

const isBusy = (error: unknown): boolean => (Number((error as { errcode?: unknown })?.errcode) & 0xff) === BUSY;

type Args = Record<string, unknown>;

interface Prepared {
  statement: StatementSync;
  names: string[];
}

const ownLimits = (limits: ProcessLimits): OwnLimits => ({
  perPayment: limits.perPayment ?? null,
  cap: limits.cap ?? null,
  windowMs: limits.windowMs ?? null,
  maxPayments: limits.maxPayments ?? null,
});

/**
 * One budget file. Every method runs statements from spec/schema.sql; each write runs in one
 * BEGIN IMMEDIATE transaction, so the file has one writer at a time. A method that finds the
 * write lock taken waits for it between tries, on the event loop, up to busyTimeoutMs.
 */
export class Ledger {
  readonly #db: DatabaseSync;
  readonly #path: string;
  readonly #busyTimeoutMs: number;
  #closed = false;
  // The file this connection opened, once it is open: its device and inode.
  #identity: FileIdentity | null = null;
  readonly #statements = new Map<string, Prepared>();

  private constructor(path: string, db: DatabaseSync, busyTimeoutMs: number) {
    this.#path = path;
    this.#db = db;
    this.#busyTimeoutMs = busyTimeoutMs;
  }

  /**
   * Open the budget file at `path`, creating it (mode 0600, its folder 0700) only with
   * `create`. A file another walletcap version wrote is upgraded; a newer one is refused.
   */
  static async open(path: string, { busyTimeoutMs = 30_000, create = false }: LedgerOptions = {}): Promise<Ledger> {
    if (typeof path !== 'string' || path.length === 0) throw new UsageError('path is required');
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0) throw new UsageError('busyTimeoutMs must be a positive integer');
    const { DatabaseSync } = loadSqlite();
    loadSpec();
    if (!existsSync(path)) {
      if (!create) throw new BudgetUnavailable(`no budget file at ${path}`);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        closeSync(openSync(path, 'wx', 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw unusable(path, error);
        // Another process created it first: fine. A link to a file that isn't there is not: SQLite
        // would follow it and create the budget somewhere else, readable by anyone.
        if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
          throw new BudgetUnavailable(
            `the budget file ${path} is a symbolic link to a file that doesn't exist; walletcap creates a budget only at the path itself`,
          );
        }
      }
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path);
    } catch (error) {
      throw unusable(path, error);
    }
    attachClock(db);
    const ledger = new Ledger(path, db, busyTimeoutMs);
    try {
      // Before anything reads the file: even preparing a statement loads the schema, and on a
      // WAL file another process may be mid-recovery (SQLITE_BUSY_RECOVERY), so the open waits
      // on the event loop like every other call.
      db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      await ledger.#attempt(() => {
        try {
          const { version } = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
          if (!versionAtLeast(version, MIN_SQLITE_VERSION)) {
            throw new BudgetUnavailable(`walletcap needs SQLite ${MIN_SQLITE_VERSION} or later; this Node has ${version}`);
          }
          db.exec('PRAGMA foreign_keys = ON');
          db.exec('PRAGMA synchronous = FULL');
        } catch (error) {
          throw isWalletcapError(error) ? error : ledger.#failure(error);
        }
      });
      await ledger.#prepareFile();
      ledger.#identity = fileIdentity(path);
    } catch (error) {
      ledger.close();
      throw isWalletcapError(error) ? error : unusable(path, error);
    }
    return ledger;
  }

  get path(): string {
    return this.#path;
  }

  // The schema the file is at: null for an empty file.
  #schema(): string | null {
    const tables = (this.#db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]).map(row => row.name);
    if (tables.length === 0) return null;
    if (!tables.includes('budget_meta')) throw new BudgetUnavailable(`${this.#path} is a SQLite file, not a walletcap budget`);
    const row = this.#db.prepare("SELECT value FROM budget_meta WHERE key = 'schema'").get() as { value: string } | undefined;
    if (row === undefined) throw new BudgetUnavailable(`${this.#path} has no schema version; it is not a walletcap budget walletcap can read`);
    return row.value;
  }

  // Create the schema, or upgrade an older one, in one write transaction: a crash leaves the
  // file as it was, and two processes that open it at once upgrade it once.
  // The empty tables walletcap 0.2 and 0.3 create, before they refuse a newer file's schema.
  #strays(): string[] {
    const tables = new Set((this.#db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
    return LEGACY_TABLES.filter(name => tables.has(name));
  }

  async #prepareFile(): Promise<void> {
    const { current, strays } = await this.#attempt(() => {
      try {
        const found = this.#schema();
        return { current: found, strays: found === SCHEMA_VERSION ? this.#strays() : [] };
      } catch (error) {
        throw isBusy(error) ? new Busy() : error;
      }
    });
    if (current === SCHEMA_VERSION) {
      // A 0.2 or 0.3 process that opened this file left its own tables, empty, before it refused
      // the schema. They hold nothing; drop them so the file holds only schema 3. They change no
      // count, so a file this process can't write (read-only, or busy) keeps them until a process
      // that can opens it.
      if (strays.length > 0) {
        try {
          await this.#write(() => {
            for (const name of this.#strays()) {
              const { rows } = this.#db.prepare(`SELECT count(*) AS rows FROM "${name}"`).get() as { rows: number | bigint };
              if (Number(rows) === 0) this.#db.exec(`DROP TABLE "${name}"`);
            }
          });
        } catch (error) {
          if (!(error instanceof BudgetUnavailable)) throw error;
        }
      }
      return;
    }
    const { schema, upgrade } = loadSpec();
    await this.#write(() => {
      const found = this.#schema();
      if (found === SCHEMA_VERSION) return;
      if (found === null) {
        for (const name of ['tables', 'projection', 'guards']) this.#db.exec(section(schema, name));
      } else if (found === '1' || found === '2') {
        this.#db.exec(section(upgrade, 'rename'));
        this.#db.exec(section(schema, 'tables'));
        this.#db.exec(section(schema, 'projection'));
        if (found === '1') this.#db.exec(section(upgrade, 'names'));
        this.#db.exec(section(upgrade, 'migrate'));
        this.#db.exec(section(schema, 'guards'));
      } else {
        throw new BudgetUnavailable(`${this.#path} is at schema ${found}, which a newer walletcap wrote; this one reads ${SCHEMA_VERSION}`);
      }
      this.#db.prepare("INSERT INTO budget_meta (key, value) VALUES ('schema', ?)").run(SCHEMA_VERSION);
    });
    // WAL lets readers through while one process writes. A file another process holds open
    // stays in its journal mode until it can switch; either mode is correct.
    try {
      this.#db.exec('PRAGMA journal_mode = WAL');
    } catch {
      /* busy: keep the journal mode */
    }
  }

  #statement(name: string): Prepared {
    let entry = this.#statements.get(name);
    if (entry === undefined) {
      const sql = loadSpec().schema.statements[name];
      if (sql === undefined) throw new Error(`spec: no statement ${name}`);
      const statement = this.#db.prepare(sql);
      statement.setReadBigInts(true);
      entry = { statement, names: parameterNames(sql) };
      this.#statements.set(name, entry);
    }
    return entry;
  }

  #all<T>(name: string, args: Args = {}): T[] {
    const { statement, names } = this.#statement(name);
    const bound: Record<string, SQLInputValue> = {};
    for (const key of names) {
      const value = args[key];
      bound[key] = value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : (value as SQLInputValue);
    }
    return statement.all(bound) as unknown as T[];
  }

  #get<T>(name: string, args: Args = {}): T | null {
    return this.#all<T>(name, args)[0] ?? null;
  }

  #write<T>(work: () => T): Promise<T> {
    return this.#attempt(() => this.#run('BEGIN IMMEDIATE', work));
  }

  #read<T>(work: () => T): Promise<T> {
    return this.#attempt(() => this.#run('BEGIN', work));
  }

  // One try: a whole transaction, synchronous, so nothing else on this thread sees it half done.
  #run<T>(begin: string, work: () => T): T {
    if (this.#closed) throw new BudgetUnavailable(`the budget file ${this.#path} is closed`);
    // This connection keeps the file it opened, even once that file is deleted or another is
    // moved into its place: it would go on counting in a file no other process sees, beside a new
    // budget that starts from nothing. The path must still name the file that was opened.
    if (this.#identity !== null) {
      const now = fileIdentity(this.#path);
      if (now === null || now.dev !== this.#identity.dev || now.ino !== this.#identity.ino) {
        throw new BudgetUnavailable(
          `the budget file ${this.#path} was ${now === null ? 'removed' : 'replaced'} after this process opened it, so what this process counted is no longer the wallet's budget: open the budget again`,
        );
      }
    }
    clockTick();
    try {
      this.#db.exec(begin);
    } catch (error) {
      throw this.#failure(error);
    }
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw isWalletcapError(error) || error instanceof Busy ? error : this.#failure(error);
    }
  }

  // Try `work` until it isn't kept out by another process's write lock, waiting between tries
  // on the event loop, 1, 2, 4 … up to 50 ms with jitter, for at most busyTimeoutMs.
  async #attempt<T>(work: () => T): Promise<T> {
    const deadline = Date.now() + this.#busyTimeoutMs;
    let wait = 1;
    for (;;) {
      try {
        return work();
      } catch (error) {
        if (!(error instanceof Busy)) throw error;
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new BudgetUnavailable(`the budget file ${this.#path} is busy: another process held its write lock for more than ${this.#busyTimeoutMs} ms`, {
            cause: error.cause,
          });
        }
        await sleep(Math.min(left, wait + Math.random() * wait));
        wait = Math.min(wait * 2, MAX_BACKOFF_MS);
      }
    }
  }

  #failure(error: unknown): Error {
    const guard = guardMessage(error);
    if (guard !== null) return new UsageError(guard, { cause: error });
    if (isBusy(error)) return new Busy('busy', { cause: error });
    return unusable(this.#path, error);
  }

  #noBudget(wallet: string): BudgetUnavailable {
    return new BudgetUnavailable(`${shortWallet(wallet)} has no budget in ${this.#path}`);
  }

  /** The ledger's time, in milliseconds. */
  now(): Promise<bigint> {
    return this.#read(() => (this.#get<{ now: bigint }>('now') as { now: bigint }).now);
  }

  budget(name: string): Promise<BudgetRow | null> {
    const wallet = walletKey(name);
    return this.#read(() => this.#get<BudgetRow>('budget', { wallet }));
  }

  budgets(): Promise<BudgetRow[]> {
    return this.#read(() => this.#all<BudgetRow>('budgets'));
  }

  /** Create a budget. Its limits are checked by the table's constraints too. */
  createBudget(
    name: string,
    {
      unit = 'usd',
      cap,
      windowMs,
      perPayment = null,
      maxPayments = null,
    }: {
      unit?: string;
      cap: bigint;
      windowMs: bigint;
      perPayment?: bigint | null;
      maxPayments?: bigint | null;
    },
  ): Promise<BudgetRow> {
    const wallet = walletKey(name);
    const values = {
      wallet,
      unit: railName(unit),
      cap: units(cap, 'cap', { allowZero: true }),
      window_ms: millis(windowMs, 'windowMs', { min: 1n }),
      per_payment: perPayment === null ? null : units(perPayment, 'perPayment'),
      max_payments: maxPayments === null ? null : whole(maxPayments, 'maxPayments', { min: 0n, max: 1n << 62n }),
    };
    return this.#write(() => {
      if (this.#get<BudgetRow>('budget', { wallet }) !== null) throw new UsageError(`${shortWallet(wallet)} already has a budget in ${this.#path}`);
      this.#all('create_budget', values);
      return this.#get<BudgetRow>('budget', { wallet }) as BudgetRow;
    });
  }

  /**
   * The owner's change, up or down; a field left undefined stays. What was spent keeps counting.
   * The window changes only while nothing counts.
   */
  setLimits(
    name: string,
    {
      cap,
      windowMs,
      perPayment,
      maxPayments,
    }: {
      cap?: bigint;
      windowMs?: bigint;
      perPayment?: bigint | null;
      maxPayments?: bigint | null;
    },
  ): Promise<BudgetRow> {
    const wallet = walletKey(name);
    const values = {
      wallet,
      cap: cap === undefined ? null : units(cap, 'cap', { allowZero: true }),
      window_ms: windowMs === undefined ? null : millis(windowMs, 'windowMs', { min: 1n }),
      keep_per_payment: perPayment === undefined,
      per_payment: perPayment === undefined || perPayment === null ? null : units(perPayment, 'perPayment'),
      keep_max_payments: maxPayments === undefined,
      max_payments: maxPayments === undefined || maxPayments === null ? null : whole(maxPayments, 'maxPayments', { min: 0n, max: 1n << 62n }),
    };
    return this.#write(() => {
      if (this.#get<BudgetRow>('budget', { wallet }) === null) throw this.#noBudget(wallet);
      this.#all('set_limits', values);
      return this.#get<BudgetRow>('budget', { wallet }) as BudgetRow;
    });
  }

  freeze(name: string): Promise<void> {
    const wallet = walletKey(name);
    return this.#write(() => {
      if (this.#get<BudgetRow>('budget', { wallet }) === null) throw this.#noBudget(wallet);
      this.#all('freeze', { wallet });
    });
  }

  unfreeze(name: string): Promise<void> {
    const wallet = walletKey(name);
    return this.#write(() => {
      if (this.#get<BudgetRow>('budget', { wallet }) === null) throw this.#noBudget(wallet);
      this.#all('unfreeze', { wallet });
    });
  }

  /** Whether a hold of `amount` would be refused now, without holding it, and what is left. */
  check(name: string, amount: bigint, { limits = {} }: { limits?: ProcessLimits } = {}): Promise<{ refusal: BudgetRefused | null; remaining: Micros }> {
    const wallet = walletKey(name);
    const own = ownLimits(limits);
    const spend = units(amount, 'amount');
    return this.#read(() => {
      const why = this.#get<RefusalRow>('refusal', {
        wallet,
        amount: spend,
        p_per_payment: own.perPayment,
        p_cap: own.cap,
        p_window_ms: own.windowMs,
        p_max_payments: own.maxPayments,
      });
      if (why === null) throw this.#noBudget(wallet);
      const remaining = (why.frozen_at !== null || why.counted > why.cap ? 0n : why.cap - why.counted) as Micros;
      if (why.code === null) return { refusal: null, remaining };
      return { refusal: refusal(why, spend, own, () => this.#all<OpenHold>('open_ids', { wallet })), remaining };
    });
  }

  /**
   * Admission: hold `amount` for a payment, or throw the BudgetRefused that says why not.
   * `until` (ms) or `withinMs` (from the ledger's now) bounds when it could settle. `limits`
   * are the paying process's own, tighter ones. Holding an identity already in the ledger
   * throws UsageError, which says where that payment stands.
   */
  hold(
    name: string,
    amount: bigint,
    {
      payment = null,
      until = null,
      withinMs = null,
      rail,
      info = null,
      limits = {},
    }: {
      payment?: string | null;
      until?: bigint | Date | null;
      withinMs?: bigint | null;
      rail: string;
      info?: string | null;
      limits?: ProcessLimits;
    },
  ): Promise<Held> {
    const wallet = walletKey(name);
    const own = ownLimits(limits);
    const args = {
      wallet,
      amount: units(amount, 'amount'),
      payment: payment === null ? null : newPaymentId(payment),
      until: until === null ? null : millis(until, 'until'),
      within_ms: withinMs === null ? null : millis(withinMs, 'withinMs', { min: 1n }),
      rail: railName(rail),
      info: text(info, 'info', INFO_LIMIT),
      holder: randomBytes(16).toString('hex'),
      p_per_payment: own.perPayment,
      p_cap: own.cap,
      p_window_ms: own.windowMs,
      p_max_payments: own.maxPayments,
    };
    return this.#write((): Held => {
      const held = this.#get<{ payment: string; at: bigint; until: bigint | null }>('hold', args);
      if (held !== null) return { ...held, state: 'held', holder: args.holder };
      const why = this.#get<RefusalRow>('refusal', args);
      if (why === null) throw this.#noBudget(wallet);
      if (why.existing !== null) {
        const existing = JSON.parse(why.existing) as { wallet: string; amount: number; state: PaymentState };
        const payment = args.payment as string;
        const known = { paymentId: payment, paymentState: existing.state };
        // An id is one payment, held once. Holding it again, whatever room is left, could pay it a
        // second time; a voided id would bring back a payment given up. A process that restarts
        // looks its payment up instead.
        if (existing.state === 'void') throw new UsageError(`payment ${payment} was voided; retry with a new id`, known);
        if (existing.wallet === wallet && BigInt(existing.amount) === args.amount) {
          throw new UsageError(
            `payment ${payment} is already in the ledger (${existing.state}); look it up with payment(id) instead of holding it again`,
            known,
          );
        }
        // Ids are one namespace for the whole file. Another wallet's payment is named, not described.
        throw new UsageError(
          existing.wallet === wallet
            ? `payment ${payment} is already in the ledger, for ${formatAmount(BigInt(existing.amount), why.unit)}`
            : `payment ${payment} is already in the ledger, under another wallet's budget; use another id`,
          known,
        );
      }
      if (why.settles_too_soon) {
        const iso = (ms: bigint): string => new Date(Number(ms)).toISOString();
        throw new UsageError(`settlesBy ${iso(args.until ?? 0n)} is not after now (${iso(why.now)}): a payment can't settle before it is made`);
      }
      if (why.code === null) throw new BudgetUnavailable('walletcap could not hold the payment, and the ledger gives no reason');
      throw refusal(why, args.amount, own, () => this.#all<OpenHold>('open_ids', { wallet }));
    });
  }

  // A transition: append it if allowed, else find out whether it was already done, or why not.
  // `mine` says whether the caller has the payment's token; the owner's moves don't ask.
  #move(statement: string, payment: string, args: Args, refused: (current: PaymentRow, mine: () => boolean) => string | null): Promise<Moved> {
    const id = paymentId(payment);
    return this.#write((): Moved => {
      const moved = this.#get(statement, { payment: id, ...args });
      const current = this.#get<PaymentRow>('payment', { payment: id });
      if (current === null) throw new UsageError(`no payment ${id} in ${this.#path}`);
      if (moved === null) {
        const mine = (): boolean => this.#get<{ mine: bigint }>('mine', { payment: id, holder: args.holder ?? null })?.mine === 1n;
        const reason = refused(current, mine);
        if (reason !== null) throw new UsageError(reason);
      }
      return { ...current, moved: moved !== null };
    });
  }

  /**
   * held or void -> settled, with the evidence (a transaction hash, the payee's answer), by the
   * process that held it (`holder`). Settling a settled payment again is a no-op for that process;
   * without the token it is refused, whatever the payment's state.
   */
  settle(payment: string, { evidence = null, holder }: { evidence?: string | null; holder: string | null }): Promise<Moved> {
    return this.#move('settle', payment, { evidence: text(evidence, 'evidence', EVIDENCE_LIMIT), holder: holderToken(holder) }, (current, mine) =>
      mine() ? null : heldElsewhere(current.payment, 'settle'),
    );
  }

  /** held -> void, by the process that held it: evidence that the payment never moved money. */
  void(payment: string, { evidence = null, holder }: { evidence?: string | null; holder: string | null }): Promise<Moved> {
    return this.#move('void', payment, { evidence: text(evidence, 'evidence', EVIDENCE_LIMIT), holder: holderToken(holder) }, (current, mine) => {
      if (current.state === 'settled') return `payment ${current.payment} is settled; a settled payment can't be voided`;
      return mine() ? null : heldElsewhere(current.payment, 'void');
    });
  }

  /**
   * held with no until -> held until `until`, or `withinMs` from now, by the process that held
   * it. One that has an until keeps it.
   */
  bound(
    payment: string,
    { until = null, withinMs = null, holder }: { until?: bigint | Date | null; withinMs?: bigint | null; holder: string | null },
  ): Promise<Moved> {
    const args = {
      until: until === null ? null : millis(until, 'until'),
      within_ms: withinMs === null ? null : millis(withinMs, 'withinMs', { min: 1n }),
      holder: holderToken(holder),
    };
    if ((args.until === null) === (args.within_ms === null)) throw new UsageError('bound takes until or withinMs');
    return this.#move('bound', payment, args, (current, mine) => {
      if (!mine()) return heldElsewhere(current.payment, 'bound');
      return current.state === 'held' && current.until === null && args.until !== null
        ? `settlesBy ${new Date(Number(args.until)).toISOString()} is not after now: a payment can't settle before it is made`
        : null;
    });
  }

  /** Note a held payment's outcome, by the process that held it: 'unknown' or 'refused'. It counts the same. */
  note(payment: string, outcome: Outcome, { evidence = null, holder }: { evidence?: string | null; holder: string | null }): Promise<Moved> {
    if (outcome !== 'unknown' && outcome !== 'refused') throw new UsageError("outcome is 'unknown' or 'refused'");
    return this.#move('note', payment, { outcome, evidence: text(evidence, 'evidence', EVIDENCE_LIMIT), holder: holderToken(holder) }, (current, mine) =>
      mine() ? null : heldElsewhere(current.payment, 'note'),
    );
  }

  /** The owner's reconciliation: held or void -> settled, whoever held it. Idempotent. */
  ownerSettle(payment: string, { evidence = null }: { evidence?: string | null } = {}): Promise<PaymentRow> {
    return this.#move('owner_settle', payment, { evidence: text(evidence, 'evidence', EVIDENCE_LIMIT) }, () => null);
  }

  /** The owner's reconciliation: held -> void, whoever held it. A settled payment stays settled. */
  ownerVoid(payment: string, { evidence = null }: { evidence?: string | null } = {}): Promise<PaymentRow> {
    return this.#move('owner_void', payment, { evidence: text(evidence, 'evidence', EVIDENCE_LIMIT) }, current =>
      current.state === 'settled' ? `payment ${current.payment} is settled; a settled payment can't be voided` : null,
    );
  }

  /** One payment, or null. */
  payment(payment: string): Promise<PaymentRow | null> {
    const id = paymentId(payment);
    return this.#read(() => this.#get<PaymentRow>('payment', { payment: id }));
  }

  /** What counts against the budget now. */
  status(name: string): Promise<StatusRow> {
    const wallet = walletKey(name);
    return this.#read(() => {
      const row = this.#get<StatusRow>('status', { wallet });
      if (row === null) throw this.#noBudget(wallet);
      return row;
    });
  }

  /** The newest payments first. */
  history(name: string, { limit = 20 }: { limit?: number | bigint | string } = {}): Promise<PaymentRow[]> {
    const wallet = walletKey(name);
    const rows = whole(limit, 'limit', { min: 1n, max: 1_000_000n });
    return this.#read(() => this.#all<PaymentRow>('history', { wallet, limit: rows }));
  }

  /** The payments that count now, oldest first; with heldOnly, the open ones. */
  counting(name: string, { heldOnly = false }: { heldOnly?: boolean } = {}): Promise<PaymentRow[]> {
    const wallet = walletKey(name);
    return this.#read(() => this.#all<PaymentRow>('counting', { wallet, held_only: heldOnly }));
  }

  /**
   * The owner's bulk release: void every held payment of unknown or refused outcome, held at
   * least `olderThanMs` ago, that can no longer settle. Returns { payment, amount } for each.
   */
  voidUnknown(
    name: string,
    olderThanMs: bigint,
    { evidence = 'voided by its owner: unknown or refused outcome' }: { evidence?: string } = {},
  ): Promise<{ payment: string; amount: Micros }[]> {
    const wallet = walletKey(name);
    const age = millis(olderThanMs, 'olderThanMs');
    const note = text(evidence, 'evidence', EVIDENCE_LIMIT);
    return this.#write(() => {
      if (this.#get<BudgetRow>('budget', { wallet }) === null) throw this.#noBudget(wallet);
      return this.#all<{ payment: string; amount: Micros }>('void_unknown', { wallet, older_than_ms: age, evidence: note });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    detachClock(this.#db);
    try {
      this.#db.close();
    } catch {
      /* already closed */
    }
  }
}
