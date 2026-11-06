// SPDX-License-Identifier: Apache-2.0
// The budget file: one SQLite database that every process, replica and rail
// opens. A payment reserves its amount inside one BEGIN IMMEDIATE transaction,
// so two processes racing for the last of a budget cannot both win, and a
// restart reads the same count. The Python ledger in this package uses the same
// tables and the same counting rule, so both languages spend from one budget.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { now as clockNow } from './_clock.mjs';
import { BudgetError, BudgetRefused } from './errors.mjs';
import { DOLLAR_UNITS, formatAmount, formatWindow, MAX_AMOUNT, MAX_INTEGER, shortWallet } from './money.mjs';

export const SCHEMA_VERSION = '1';
export const REFERENCE_LIMIT = 4096;

/**
 * Internal: the key of Reservation's method that gives an open payment, once, the
 * last moment it could still settle. The package does not export it.
 */
export const SETTLES_BY = Symbol('walletcap/settles-by');

const ID = /^[A-Za-z0-9_.:@/-]{1,128}$/;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS budget_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS budgets (
    instrument TEXT PRIMARY KEY,
    unit TEXT NOT NULL,
    cap INTEGER NOT NULL CHECK (cap >= 0),
    window_ms INTEGER NOT NULL CHECK (window_ms > 0),
    per_payment INTEGER CHECK (per_payment IS NULL OR per_payment > 0),
    max_uses INTEGER CHECK (max_uses IS NULL OR max_uses >= 0),
    revoked_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS spend (
    spend_id TEXT PRIMARY KEY,
    instrument TEXT NOT NULL REFERENCES budgets(instrument),
    amount INTEGER NOT NULL CHECK (amount > 0),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'committed')),
    rail TEXT NOT NULL,
    reference TEXT,
    at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS spend_by_instrument ON spend (instrument, at_ms);
`;
// The counting rule, the same in Python: a settled payment counts while its
// settlement is inside the budget's rolling window, and a reservation counts
// until it is committed or released, or its expiry passes, whatever the window.
const COUNTED = 'FROM spend JOIN budgets ON budgets.instrument = spend.instrument '
  + "WHERE spend.instrument = ? AND ((spend.status = 'committed' AND spend.at_ms + budgets.window_ms >= ?) "
  + "OR (spend.status = 'reserved' AND (spend.expires_at_ms IS NULL OR spend.expires_at_ms > ?)))";

// node:sqlite prints an ExperimentalWarning when it loads (Node 22 and 24).
// Load it once with that one warning held back, so an agent's logs stay clean.
const require = createRequire(import.meta.url);
let sqlite;
const loadSqlite = () => {
  if (sqlite !== undefined) return sqlite;
  const emitWarning = process.emitWarning;
  process.emitWarning = function quietSqlite(warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(String(warning?.message ?? warning))) return undefined;
    return emitWarning.call(this, warning, ...rest);
  };
  try {
    sqlite = require('node:sqlite');
  } catch (error) {
    throw new BudgetError(`walletcap needs Node 22.13 or later, for node:sqlite (${error.message})`, { cause: error });
  } finally {
    process.emitWarning = emitWarning;
  }
  return sqlite;
};

export const identifier = (value, label) => {
  if (typeof value !== 'string' || !ID.test(value)) throw new BudgetError(`${label} must be a plain identifier`);
  return value;
};

/** Refuse an option `what` doesn't take, naming the one that was probably meant. */
export const checkKeys = (source, known, what) => {
  if (source === null || typeof source !== 'object') throw new BudgetError(`${what} takes an options object`);
  for (const key of Object.keys(source)) {
    if (known.has(key)) continue;
    const plain = key.toLowerCase().replaceAll(/[-_]/g, '');
    const match = [...known].find(candidate => candidate.toLowerCase() === plain);
    throw new BudgetError(`unknown option ${key}${match ? `; did you mean ${match}?` : ''}`);
  }
};

const wholeNumber = (value, label, { allowZero, max, most }) => {
  let parsed;
  try { parsed = BigInt(value); } catch { throw new BudgetError(`${label} must be an integer`); }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new BudgetError(`${label} must be an exact integer`);
  if (parsed > max || parsed < (allowZero ? 0n : 1n)) {
    throw new BudgetError(`${label} must be a ${allowZero ? 'nonnegative' : 'positive'} integer ${most}`);
  }
  return parsed;
};

/** An amount in the budget's own unit, at most MAX_AMOUNT, so no sum of them overflows 64 bits. */
export const units = (value, label, { allowZero = false } = {}) => wholeNumber(value, label, { allowZero, max: MAX_AMOUNT, most: `of at most ${MAX_AMOUNT}` });

/** A time in milliseconds, or a count, that fits in 64 bits. */
export const integer = (value, label, { allowZero = false } = {}) => wholeNumber(value, label, { allowZero, max: MAX_INTEGER, most: 'that fits in 64 bits' });

// Counted as a payment settled at `until` would be: through until + window. A time already past counts as now.
const expiry = (settlesBy, now, windowMs) => {
  const until = settlesBy > now ? settlesBy : now;
  return until + windowMs >= MAX_INTEGER ? MAX_INTEGER : until + windowMs + 1n;
};

const referenceText = reference => {
  if (reference === null || reference === undefined) return null;
  if (typeof reference !== 'string' || reference.length > REFERENCE_LIMIT) {
    throw new BudgetError(`reference must be a string of at most ${REFERENCE_LIMIT} characters`);
  }
  return reference;
};

const unreadable = (path, error) => new BudgetError(`the budget file ${path} cannot be used: ${error.message}`, { cause: error });

/** Why `row`'s budget refuses `spend` on top of what already counts, or null. */
export function refusal(row, { total, uses }, spend) {
  const name = shortWallet(row.instrument);
  const money = value => formatAmount(value, row.unit);
  const window = formatWindow(row.window_ms);
  if (row.revoked_at_ms !== null) {
    return new BudgetRefused('revoked', `${name}'s budget is frozen: nothing can be paid until its owner unfreezes it`);
  }
  if (row.per_payment !== null && spend > row.per_payment) {
    return new BudgetRefused('per_payment', `${money(spend)} is over ${name}'s ${money(row.per_payment)} limit per payment`);
  }
  if (total + spend > row.cap) {
    const left = row.cap > total ? row.cap - total : 0n;
    return new BudgetRefused('budget', `${money(spend)} would bring ${name} to ${money(total + spend)} in the last ${window}, over its ${money(row.cap)} limit (${money(left)} left)`);
  }
  if (row.max_uses !== null && uses + 1n > row.max_uses) {
    return new BudgetRefused('uses', `${name} already made ${uses} payment${uses === 1n ? '' : 's'} in the last ${window}, the most its budget allows`);
  }
  return null;
}

const unitsMatch = (stored, wanted) => (DOLLAR_UNITS.has(wanted) ? DOLLAR_UNITS.has(stored) : stored === wanted);

export class Ledger {
  #db;
  #path;
  #closed = false;
  #statements = new Map();

  constructor(path, { busyTimeoutMs = 30_000 } = {}) {
    if (typeof path !== 'string' || path.length === 0) throw new BudgetError('path is required');
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0) throw new BudgetError('busyTimeoutMs must be a positive integer');
    const { DatabaseSync } = loadSqlite();
    this.#path = path;
    try {
      this.#db = new DatabaseSync(path);
    } catch (error) {
      throw unreadable(path, error);
    }
    try {
      this.#db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      this.#db.exec('PRAGMA foreign_keys = ON');
      this.#db.exec(SCHEMA);
      this.transaction(() => {
        this.statement("INSERT OR IGNORE INTO budget_meta VALUES ('schema', ?)").run(SCHEMA_VERSION);
        const { value } = this.statement("SELECT value FROM budget_meta WHERE key = 'schema'").get();
        if (value !== SCHEMA_VERSION) throw new BudgetError(`ledger schema ${value} is not ${SCHEMA_VERSION}`);
      });
    } catch (error) {
      this.#db.close();
      throw error instanceof BudgetError ? error : unreadable(path, error);
    }
  }

  get path() { return this.#path; }

  /** The ledger's own time: the system clock, in milliseconds. Callers can't set it. */
  now() { return integer(clockNow(), 'clock', { allowZero: true }); }

  statement(sql) {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      statement.setReadBigInts(true);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /** Run `work` in one write transaction; another process waits for the busy timeout. */
  transaction(work) { return this.#run('BEGIN IMMEDIATE', work); }

  /** Run `work` against one consistent snapshot of the file. */
  read(work) { return this.#run('BEGIN', work); }

  #run(begin, work) {
    try {
      this.#db.exec(begin);
    } catch (error) {
      throw unreadable(this.#path, error); // a busy timeout throws here, before anything to roll back
    }
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error instanceof BudgetError ? error : unreadable(this.#path, error);
    }
  }

  #row(instrument) {
    return this.statement('SELECT * FROM budgets WHERE instrument = ?').get(instrument) ?? null;
  }

  #required(instrument) {
    const row = this.#row(instrument);
    if (row === null) throw new BudgetError(`${shortWallet(instrument)} has no budget in ${this.#path}`);
    return row;
  }

  #counted(instrument, now) {
    return this.statement(`SELECT COALESCE(SUM(spend.amount), 0) AS total, COUNT(spend.spend_id) AS uses ${COUNTED}`)
      .get(instrument, now, now);
  }

  #insert(instrument, unit, { cap, windowMs, perPayment = null, maxUses = null }) {
    this.statement('INSERT INTO budgets VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .run(instrument, unit, cap, windowMs, perPayment, maxUses);
  }

  // Limits from ensure() and setLimits(), checked here too: every stored cap is bounded.
  static #limits({ cap, windowMs, perPayment, maxUses }) {
    const limits = {};
    if (cap !== undefined) limits.cap = units(cap, 'cap', { allowZero: true });
    if (windowMs !== undefined) limits.windowMs = integer(windowMs, 'windowMs');
    if (perPayment !== undefined) limits.perPayment = perPayment === null ? null : units(perPayment, 'perPayment');
    if (maxUses !== undefined) limits.maxUses = maxUses === null ? null : integer(maxUses, 'maxUses', { allowZero: true });
    return limits;
  }

  budget(instrument) { return this.read(() => this.#row(instrument)); }

  budgets() { return this.read(() => this.statement('SELECT * FROM budgets ORDER BY instrument').all()); }

  /** Record a budget once; declaring it again with other limits is refused. */
  declare(instrument, { unit, cap, windowMs, perPayment = null, maxUses = null }) {
    identifier(instrument, 'instrument');
    identifier(unit, 'unit');
    const budget = {
      unit,
      cap: units(cap, 'cap', { allowZero: true }),
      window_ms: integer(windowMs, 'windowMs'),
      per_payment: perPayment === null ? null : units(perPayment, 'perPayment'),
      max_uses: maxUses === null ? null : integer(maxUses, 'maxUses', { allowZero: true }),
    };
    return this.transaction(() => {
      const row = this.#row(instrument);
      if (row === null) {
        this.#insert(instrument, unit, { cap: budget.cap, windowMs: budget.window_ms, perPayment: budget.per_payment, maxUses: budget.max_uses });
        return this.#row(instrument);
      }
      if (Object.keys(budget).some(key => row[key] !== budget[key])) {
        throw new BudgetError('instrument budget is already declared with other limits');
      }
      return row;
    });
  }

  /**
   * Create the budget with `limits`, or move its stored limits toward them:
   * a tighter limit is stored, a looser one is reported and left alone. A
   * restart can lower a limit; only setLimits() raises one.
   */
  ensure(instrument, asked, { unit = 'usd', create = true } = {}) {
    identifier(instrument, 'instrument');
    const limits = Ledger.#limits(asked);
    return this.transaction(() => {
      const row = this.#row(instrument);
      if (row === null) {
        if (!create) throw new BudgetError(`${shortWallet(instrument)} has no budget in ${this.#path}`);
        if (limits.cap === undefined) {
          throw new BudgetError(`${shortWallet(instrument)} has no budget yet: give it a rolling limit, like perDay: '$150'`);
        }
        this.#insert(instrument, unit, limits);
        return { created: true, lowered: [], looser: [], row: this.#row(instrument) };
      }
      if (!unitsMatch(row.unit, unit)) throw new BudgetError(`${shortWallet(instrument)}'s budget counts in ${row.unit}, not ${unit}`);
      const lowered = [];
      const looser = [];
      const sameWindow = limits.windowMs === undefined || limits.windowMs === row.window_ms;
      let { cap, per_payment: perPayment, max_uses: maxUses } = row;
      if (limits.cap !== undefined) {
        if (!sameWindow) looser.push({ field: 'window', stored: row.window_ms, asked: limits.windowMs });
        else if (limits.cap < cap) { cap = limits.cap; lowered.push('cap'); }
        else if (limits.cap > cap) looser.push({ field: 'cap', stored: cap, asked: limits.cap });
      }
      if (limits.perPayment !== undefined) {
        const asked = limits.perPayment;
        if (asked !== null && (perPayment === null || asked < perPayment)) { perPayment = asked; lowered.push('perPayment'); }
        else if (perPayment !== null && (asked === null || asked > perPayment)) looser.push({ field: 'perPayment', stored: perPayment, asked });
      }
      if (limits.maxUses !== undefined && limits.maxUses !== maxUses) {
        const asked = limits.maxUses;
        if (sameWindow && asked !== null && (maxUses === null || asked < maxUses)) { maxUses = asked; lowered.push('maxUses'); }
        else looser.push({ field: 'maxUses', stored: maxUses, asked });
      }
      if (lowered.length > 0) {
        this.statement('UPDATE budgets SET cap = ?, per_payment = ?, max_uses = ? WHERE instrument = ?')
          .run(cap, perPayment, maxUses, instrument);
      }
      return { created: false, lowered, looser, row: this.#row(instrument) };
    });
  }

  /** Change limits in either direction. What was spent keeps counting: nothing resets. */
  setLimits(instrument, asked, { unit = 'usd', create = true } = {}) {
    identifier(instrument, 'instrument');
    const limits = Ledger.#limits(asked);
    return this.transaction(() => {
      const row = this.#row(instrument);
      if (row === null) {
        if (!create) throw new BudgetError(`${shortWallet(instrument)} has no budget in ${this.#path}`);
        if (limits.cap === undefined) {
          throw new BudgetError(`${shortWallet(instrument)} has no budget yet: give it a rolling limit too, like --per-day 150`);
        }
        this.#insert(instrument, unit, limits);
        return this.#row(instrument);
      }
      if (!unitsMatch(row.unit, unit)) throw new BudgetError(`${shortWallet(instrument)}'s budget counts in ${row.unit}, not ${unit}`);
      if (limits.windowMs !== undefined && limits.windowMs !== row.window_ms) {
        const used = this.statement('SELECT 1 FROM spend WHERE instrument = ? LIMIT 1').get(instrument);
        if (used) {
          throw new BudgetError(`${shortWallet(instrument)} has spend in this budget; the window cannot change. Create a new budget instead.`);
        }
      }
      this.statement('UPDATE budgets SET cap = ?, window_ms = ?, per_payment = ?, max_uses = ? WHERE instrument = ?').run(
        limits.cap ?? row.cap,
        limits.windowMs ?? row.window_ms,
        limits.perPayment === undefined ? row.per_payment : limits.perPayment,
        limits.maxUses === undefined ? row.max_uses : limits.maxUses,
        instrument,
      );
      return this.#row(instrument);
    });
  }

  /** What counts against the budget right now: total and number of payments. */
  counted(instrument, now = this.now()) { return this.read(() => this.#counted(instrument, now)); }

  countedRows(instrument, now = this.now()) {
    return this.read(() => this.statement(
      `SELECT spend.spend_id, spend.status, spend.amount, spend.rail, spend.reference, spend.at_ms ${COUNTED}`,
    ).all(instrument, now, now));
  }

  /** Whether `amount` would be refused right now, without reserving it. */
  check(instrument, amount) {
    const spend = units(amount, 'amount');
    const now = this.now();
    return this.read(() => {
      const row = this.#required(instrument);
      const counted = this.#counted(instrument, now);
      const refused = refusal(row, counted, spend);
      const left = row.cap - counted.total;
      return { refusal: refused, total: counted.total, uses: counted.uses, remaining: row.revoked_at_ms !== null || left < 0n ? 0n : left };
    });
  }

  /**
   * Take `amount` from the budget, or throw the BudgetRefused that says why
   * not. A reservation counts until committed or released. With settlesByMs
   * (the last moment the payment could still settle) it stops counting one
   * window after that moment, as if it had settled then; a moment already
   * past counts as now.
   */
  reserve(instrument, amount, { rail = 'js', reference = null, settlesByMs = null } = {}) {
    identifier(instrument, 'instrument');
    const spend = units(amount, 'amount');
    identifier(rail, 'rail');
    const text = referenceText(reference);
    const settlesBy = settlesByMs === null ? null : integer(settlesByMs, 'settlesByMs', { allowZero: true });
    const now = this.now();
    return this.transaction(() => {
      const row = this.#required(instrument);
      const refused = refusal(row, this.#counted(instrument, now), spend);
      if (refused !== null) throw refused;
      const spendId = `spend-${randomUUID().replaceAll('-', '')}`;
      const expires = settlesBy === null ? null : expiry(settlesBy, now, row.window_ms);
      this.statement("INSERT INTO spend VALUES (?, ?, ?, 'reserved', ?, ?, ?, ?)")
        .run(spendId, instrument, spend, rail, text, now, expires);
      return spendId;
    });
  }

  /**
   * Record a payment as settled now, after the same checks. Coinbase's SDK
   * records a payment when it creates it; the time is always the ledger's own.
   */
  record(instrument, amount, { rail, reference = null }) {
    const spend = units(amount, 'amount');
    identifier(rail, 'rail');
    const text = referenceText(reference);
    const now = this.now();
    return this.transaction(() => {
      const row = this.#required(instrument);
      const refused = refusal(row, this.#counted(instrument, now), spend);
      if (refused !== null) throw refused;
      const spendId = `${rail}-${randomUUID()}`;
      this.statement("INSERT INTO spend VALUES (?, ?, ?, 'committed', ?, ?, ?, NULL)")
        .run(spendId, instrument, spend, rail, text, now);
      return spendId;
    });
  }

  /** The payment settled: it counts for one rolling window from now. */
  commit(spendId, { reference } = {}) {
    identifier(spendId, 'spend_id');
    const text = referenceText(reference);
    const now = this.now();
    this.transaction(() => {
      const row = this.statement('SELECT status FROM spend WHERE spend_id = ?').get(spendId);
      if (row === undefined) throw new BudgetError('unknown reservation');
      if (row.status === 'committed') throw new BudgetError('reservation is already committed');
      this.statement("UPDATE spend SET status = 'committed', at_ms = MAX(at_ms, ?), expires_at_ms = NULL, "
        + 'reference = COALESCE(?, reference) WHERE spend_id = ?').run(now, text, spendId);
    });
  }

  /**
   * Give an open reservation that has no settle-by time the last moment its
   * payment could settle: it then counts until one window after that moment,
   * as reserve() with settlesByMs does. A reservation that already has one
   * keeps it.
   */
  settlesBy(spendId, settlesByMs) {
    identifier(spendId, 'spend_id');
    const settlesBy = integer(settlesByMs, 'settlesByMs', { allowZero: true });
    const now = this.now();
    this.transaction(() => {
      const row = this.statement('SELECT spend.status, spend.expires_at_ms, budgets.window_ms FROM spend '
        + 'JOIN budgets ON budgets.instrument = spend.instrument WHERE spend.spend_id = ?').get(spendId);
      if (row === undefined || row.status !== 'reserved' || row.expires_at_ms !== null) return;
      this.statement("UPDATE spend SET expires_at_ms = ? WHERE spend_id = ? AND status = 'reserved' AND expires_at_ms IS NULL")
        .run(expiry(settlesBy, now, row.window_ms), spendId);
    });
  }

  /** Replace an open reservation's reference; it keeps counting. */
  annotate(spendId, reference) {
    identifier(spendId, 'spend_id');
    const text = referenceText(reference);
    this.transaction(() => {
      this.statement("UPDATE spend SET reference = ? WHERE spend_id = ? AND status = 'reserved'").run(text, spendId);
    });
  }

  /** Give back a reservation whose payment never left. */
  release(spendId) {
    identifier(spendId, 'spend_id');
    this.transaction(() => {
      const { changes } = this.statement("DELETE FROM spend WHERE spend_id = ? AND status = 'reserved'").run(spendId);
      if (Number(changes) !== 1) throw new BudgetError('only an uncommitted reservation can be released');
    });
  }

  removeByReference(instrument, rail, reference) {
    this.transaction(() => {
      this.statement('DELETE FROM spend WHERE spend_id = (SELECT spend_id FROM spend '
        + 'WHERE instrument = ? AND rail = ? AND reference = ? LIMIT 1)').run(instrument, rail, reference);
    });
  }

  /**
   * Turn a recorded payment back into an open reservation, noting why: it counts
   * until someone releases it, whatever the window.
   */
  reopenByReference(instrument, rail, reference, { outcome } = {}) {
    this.transaction(() => {
      const row = this.statement("SELECT spend_id, reference FROM spend WHERE instrument = ? AND rail = ? AND reference = ? AND status = 'committed' LIMIT 1")
        .get(instrument, rail, reference);
      if (row === undefined) return;
      let text = row.reference;
      if (outcome !== undefined) {
        try { text = referenceText(JSON.stringify({ ...JSON.parse(row.reference), outcome })); } catch { /* keep the reference as it was */ }
      }
      this.statement("UPDATE spend SET status = 'reserved', expires_at_ms = NULL, reference = ? WHERE spend_id = ?").run(text, row.spend_id);
    });
  }

  /** Refuse every later payment from the instrument, on every rail. */
  revoke(instrument) {
    const now = this.now();
    this.transaction(() => {
      this.#required(instrument);
      this.statement('UPDATE budgets SET revoked_at_ms = ? WHERE instrument = ? AND revoked_at_ms IS NULL').run(now, instrument);
    });
  }

  /** Allow payments again after revoke(). */
  unrevoke(instrument) {
    this.transaction(() => {
      this.#required(instrument);
      this.statement('UPDATE budgets SET revoked_at_ms = NULL WHERE instrument = ?').run(instrument);
    });
  }

  /** What counts against the budget right now, in its own unit. */
  status(instrument) {
    const now = this.now();
    return this.read(() => {
      const row = this.#required(instrument);
      const sums = Object.fromEntries(this.statement(
        `SELECT spend.status AS status, COALESCE(SUM(spend.amount), 0) AS total, COUNT(spend.spend_id) AS uses ${COUNTED} GROUP BY spend.status`,
      ).all(instrument, now, now).map(sum => [sum.status, sum]));
      const spent = sums.committed?.total ?? 0n;
      const reserved = sums.reserved?.total ?? 0n;
      const revoked = row.revoked_at_ms !== null;
      const left = row.cap - spent - reserved;
      return {
        instrument,
        unit: row.unit,
        cap: row.cap,
        windowMs: row.window_ms,
        perPayment: row.per_payment,
        maxUses: row.max_uses,
        spent,
        reserved,
        uses: (sums.committed?.uses ?? 0n) + (sums.reserved?.uses ?? 0n),
        revoked,
        remaining: revoked || left < 0n ? 0n : left,
      };
    });
  }

  /** The newest payments first, with whether each still counts. */
  history(instrument, { limit = 20 } = {}) {
    const rows = integer(limit, 'limit');
    const now = this.now();
    return this.read(() => {
      const row = this.#required(instrument);
      return this.statement('SELECT * FROM spend WHERE instrument = ? ORDER BY at_ms DESC, rowid DESC LIMIT ?')
        .all(instrument, rows)
        .map(spend => ({
          ...spend,
          counting: spend.status === 'committed'
            ? spend.at_ms + row.window_ms >= now
            : spend.expires_at_ms === null || spend.expires_at_ms > now,
        }));
    });
  }

  /** One payment by id, or null. */
  payment(spendId) {
    identifier(spendId, 'spend_id');
    return this.read(() => this.statement('SELECT * FROM spend WHERE spend_id = ?').get(spendId) ?? null);
  }

  /** Delete settled payments older than `cutoffMs` that no longer count. */
  prune(instrument, cutoffMs) {
    const cutoff = integer(cutoffMs, 'olderThanMs', { allowZero: true });
    const now = this.now();
    this.transaction(() => {
      const { window_ms: window } = this.#required(instrument);
      // Reservations stay until committed or released: a lapsed one may still settle.
      this.statement("DELETE FROM spend WHERE instrument = ? AND status = 'committed' AND at_ms < ? AND at_ms + ? < ?")
        .run(instrument, cutoff, window, now);
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    this.#db.close();
  }
}
